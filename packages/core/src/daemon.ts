import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import {
  type BackendKind,
  type BackendStatus,
  classifyJsonRpcMessage,
  type InitializeResult,
  type JsonRpcId,
  JsonRpcIdSchema,
  NUH_ERROR_CODES,
  NUH_PROTOCOL_VERSION,
  type NuhClientRequest,
  type NuhNormalizedEvent,
  NuhProtocolError,
  parseNdjsonJson,
  parseNuhClientNotification,
  parseNuhClientRequest,
  serializeNdjsonLine,
  type ThreadSummary,
  toNuhNotification,
} from '@nuh/protocol';
import {
  bootDshHeadlessRuntime,
  type DshHeadlessBootOptions,
  type DshHeadlessRuntime,
} from './dsh-runtime.ts';
import { runEchoTurn } from './echo-backend.ts';
import { AuditLedger, resolveDefaultNuhHome } from './ledger.ts';

interface ThreadRecord {
  readonly threadId: string;
  readonly workdir: string;
  activeBackend: BackendKind;
  model?: string;
  readonly sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access';
  readonly approvalPolicy: 'untrusted' | 'on-request' | 'never';
  readonly createdAt: string;
  updatedAt: string;
}

interface ActiveTurnRecord {
  readonly turnId: string;
  readonly threadId: string;
  readonly abortController: AbortController;
  readonly done: Promise<void>;
}

export interface NuhDaemonOptions {
  readonly dshOptions?: DshHeadlessBootOptions;
  readonly nuhHome?: string;
  readonly echoStepDelayMs?: number;
  readonly runtime?: DshHeadlessRuntime;
  readonly stderr?: Writable;
}

function extractValidRpcId(raw: unknown): JsonRpcId | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const candidate = (raw as Record<string, unknown>).id;
  const parsed = JsonRpcIdSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/**
 * NUH 无头守护进程内核（Phase 1 Step 1.2）：
 * - 托管 `@deepseek-ai/dsh-base` 无头 Cordis 容器生命周期
 * - 通过 `stdio://` NDJSON 暴露 `@nuh/protocol` JSON-RPC 2.0 服务端
 * - 将规范化 Thread / Turn / Item 事件追加写入 `ledger.jsonl`
 */
export class NuhDaemon {
  readonly runtime: DshHeadlessRuntime;
  readonly ledger: AuditLedger;
  private readonly echoStepDelayMs: number | undefined;
  private readonly stderr: Writable;
  private readonly threads = new Map<string, ThreadRecord>();
  private readonly knownTurnIds = new Map<string, string>();
  private readonly activeTurns = new Map<string, ActiveTurnRecord>();
  private initialized = false;
  private shutdownPromise: Promise<void> | null = null;
  private closeStdio: (() => void) | null = null;

  private constructor(runtime: DshHeadlessRuntime, ledger: AuditLedger, options: NuhDaemonOptions) {
    this.runtime = runtime;
    this.ledger = ledger;
    this.echoStepDelayMs = options.echoStepDelayMs;
    this.stderr = options.stderr ?? process.stderr;
  }

  static async create(options: NuhDaemonOptions = {}): Promise<NuhDaemon> {
    const runtime = options.runtime ?? (await bootDshHeadlessRuntime(options.dshOptions));
    const nuhHome = options.nuhHome ?? resolveDefaultNuhHome();
    const ledger = new AuditLedger(nuhHome);
    const daemon = new NuhDaemon(runtime, ledger, options);

    const coreFiber = runtime.ctx.plugin({
      name: 'nuh-daemon-core',
      apply(ctx) {
        ctx.effect(() => () => {
          daemon.abortAllActiveTurns();
        });
      },
    });
    await coreFiber.inertia;

    return daemon;
  }

  private logDiagnostic(level: 'info' | 'warn' | 'error', message: string, meta?: unknown): void {
    const entry = {
      ts: new Date().toISOString(),
      source: 'nuh-daemon',
      level,
      message,
      ...(meta !== undefined ? { meta } : {}),
    };
    this.stderr.write(`${JSON.stringify(entry)}\n`);
  }

  private abortAllActiveTurns(): void {
    for (const turn of this.activeTurns.values()) {
      turn.abortController.abort();
    }
  }

  private writeFrame(output: Writable, payload: unknown): void {
    if (!output.writableEnded && !output.destroyed) {
      output.write(serializeNdjsonLine(payload));
    }
  }

  private getBackendStatuses(): BackendStatus[] {
    return [
      {
        kind: 'native-dsh',
        available: true,
        authenticated: true,
        version: '0.2.2-rc.1',
        reason: 'headless deterministic echo loop active',
      },
      {
        kind: 'codex',
        available: false,
        authenticated: false,
        reason: 'Phase 2 backend adapter not yet attached',
      },
      {
        kind: 'claude',
        available: false,
        authenticated: false,
        reason: 'Phase 2 backend adapter not yet attached',
      },
      {
        kind: 'agy',
        available: false,
        authenticated: false,
        reason: 'Phase 2 backend adapter not yet attached',
      },
    ];
  }

  private async handleRequest(req: NuhClientRequest, output: Writable): Promise<unknown> {
    switch (req.method) {
      case 'initialize': {
        const result: InitializeResult = {
          serverInfo: {
            name: 'nuh-daemon',
            version: '0.1.0',
          },
          protocolVersion: NUH_PROTOCOL_VERSION,
          backends: this.getBackendStatuses(),
          loadedDshPlugins: [...this.runtime.loadedPluginIds],
        };
        return result;
      }

      case 'thread/start': {
        const threadId = `nuh_thr_${randomUUID().slice(0, 12)}`;
        const now = new Date().toISOString();
        const record: ThreadRecord = {
          threadId,
          workdir: req.params.workdir,
          activeBackend: req.params.defaultBackend,
          ...(req.params.model !== undefined ? { model: req.params.model } : {}),
          sandboxMode: req.params.sandboxMode,
          approvalPolicy: req.params.approvalPolicy,
          createdAt: now,
          updatedAt: now,
        };
        this.threads.set(threadId, record);
        await this.ledger.appendThreadStarted(threadId, {
          workdir: record.workdir,
          defaultBackend: record.activeBackend,
          ...(record.model !== undefined ? { model: record.model } : {}),
          sandboxMode: record.sandboxMode,
          approvalPolicy: record.approvalPolicy,
        });
        return {
          threadId,
          createdAt: now,
        };
      }

      case 'thread/resume': {
        const thread = this.threads.get(req.params.threadId);
        if (!thread) {
          throw new NuhProtocolError(
            NUH_ERROR_CODES.THREAD_NOT_FOUND,
            `未找到 threadId: ${req.params.threadId}`,
            { threadId: req.params.threadId },
          );
        }
        const ledgerSummary = await this.ledger.summarizeThread(thread.threadId);
        return {
          threadId: thread.threadId,
          activeBackend: thread.activeBackend,
          ledgerSummary,
        };
      }

      case 'thread/list': {
        const threads: ThreadSummary[] = [];
        for (const thread of this.threads.values()) {
          if (req.params.workdir && thread.workdir !== req.params.workdir) {
            continue;
          }
          threads.push({
            threadId: thread.threadId,
            workdir: thread.workdir,
            activeBackend: thread.activeBackend,
            createdAt: thread.createdAt,
            updatedAt: thread.updatedAt,
          });
        }
        return { threads };
      }

      case 'thread/setBackend': {
        const thread = this.threads.get(req.params.threadId);
        if (!thread) {
          throw new NuhProtocolError(
            NUH_ERROR_CODES.THREAD_NOT_FOUND,
            `未找到 threadId: ${req.params.threadId}`,
            { threadId: req.params.threadId },
          );
        }
        thread.activeBackend = req.params.backend;
        if (req.params.model !== undefined) {
          thread.model = req.params.model;
        }
        thread.updatedAt = new Date().toISOString();
        await this.ledger.appendThreadBackendChanged(thread.threadId, {
          backend: thread.activeBackend,
          ...(thread.model !== undefined ? { model: thread.model } : {}),
        });
        return {
          threadId: thread.threadId,
          backend: thread.activeBackend,
          ...(thread.model !== undefined ? { model: thread.model } : {}),
        };
      }

      case 'turn/start': {
        const thread = this.threads.get(req.params.threadId);
        if (!thread) {
          throw new NuhProtocolError(
            NUH_ERROR_CODES.THREAD_NOT_FOUND,
            `未找到 threadId: ${req.params.threadId}`,
            { threadId: req.params.threadId },
          );
        }
        const resolvedBackend = req.params.backendOverride ?? thread.activeBackend;
        if (resolvedBackend !== 'native-dsh') {
          throw new NuhProtocolError(
            NUH_ERROR_CODES.BACKEND_UNAVAILABLE,
            `后端 "${resolvedBackend}" 尚未在 Phase 1 Step 1.2 接入，当前仅支持 native-dsh`,
            { resolvedBackend },
          );
        }

        const turnId = `nuh_turn_${randomUUID().slice(0, 12)}`;
        thread.updatedAt = new Date().toISOString();
        this.knownTurnIds.set(turnId, thread.threadId);
        await this.ledger.appendTurnInput(thread.threadId, {
          turnId,
          backend: resolvedBackend,
          input: req.params.input,
        });

        const abortController = new AbortController();
        const emitEvent = async (event: NuhNormalizedEvent): Promise<void> => {
          await this.ledger.appendNormalizedEvent(event);
          this.writeFrame(output, toNuhNotification(event));
        };

        const done = (async () => {
          try {
            await runEchoTurn({
              threadId: thread.threadId,
              turnId,
              backend: resolvedBackend,
              input: req.params.input,
              signal: abortController.signal,
              ...(this.echoStepDelayMs !== undefined ? { stepDelayMs: this.echoStepDelayMs } : {}),
              emit: emitEvent,
            });
          } catch (cause) {
            const detail = cause instanceof Error ? cause.message : String(cause);
            this.logDiagnostic('error', 'Echo turn execution failed', {
              threadId: thread.threadId,
              turnId,
              detail,
            });
            await emitEvent({
              type: 'turn/completed',
              payload: {
                threadId: thread.threadId,
                turnId,
                status: 'failed',
                error: {
                  code: NUH_ERROR_CODES.INTERNAL_ERROR,
                  message: detail,
                },
              },
            });
          } finally {
            this.activeTurns.delete(turnId);
          }
        })();

        this.activeTurns.set(turnId, {
          turnId,
          threadId: thread.threadId,
          abortController,
          done,
        });

        return {
          turnId,
          resolvedBackend,
        };
      }

      case 'turn/interrupt': {
        const thread = this.threads.get(req.params.threadId);
        if (!thread) {
          throw new NuhProtocolError(
            NUH_ERROR_CODES.THREAD_NOT_FOUND,
            `未找到 threadId: ${req.params.threadId}`,
            { threadId: req.params.threadId },
          );
        }
        const ownerThreadId = this.knownTurnIds.get(req.params.turnId);
        if (ownerThreadId !== thread.threadId) {
          throw new NuhProtocolError(
            NUH_ERROR_CODES.TURN_NOT_FOUND,
            `未找到 turnId: ${req.params.turnId}`,
            { threadId: thread.threadId, turnId: req.params.turnId },
          );
        }
        const activeTurn = this.activeTurns.get(req.params.turnId);
        if (!activeTurn) {
          return { interrupted: false };
        }
        activeTurn.abortController.abort();
        await activeTurn.done;
        return { interrupted: true };
      }
    }
  }

  private async handleLine(line: string, output: Writable): Promise<void> {
    let raw: unknown;
    let rawId: JsonRpcId | null = null;
    try {
      raw = parseNdjsonJson(line);
      rawId = extractValidRpcId(raw);
      const classified = classifyJsonRpcMessage(raw, { requireJsonRpcVersion: true });

      if (classified.kind === 'request') {
        const req = parseNuhClientRequest(raw);
        const result = await this.handleRequest(req, output);
        this.writeFrame(output, {
          jsonrpc: '2.0',
          id: req.id,
          result,
        });
        return;
      }

      if (classified.kind === 'notification') {
        const notif = parseNuhClientNotification(raw);
        if (notif.method === 'initialized') {
          this.initialized = true;
          this.logDiagnostic('info', 'Client handshake initialized', {
            loadedPluginCount: this.runtime.loadedPluginIds.length,
            settingsActive: this.runtime.settingsActive,
            hmrDisabled: this.runtime.hmrDisabled,
          });
        }
        return;
      }

      throw new NuhProtocolError(
        NUH_ERROR_CODES.INVALID_REQUEST,
        `收到未匹配的 JSON-RPC Response 帧 (id=${String(classified.message.id)})`,
      );
    } catch (cause) {
      if (cause instanceof NuhProtocolError) {
        this.writeFrame(output, cause.toJsonRpcErrorResponse(rawId));
        return;
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      const err = new NuhProtocolError(NUH_ERROR_CODES.INTERNAL_ERROR, message);
      this.writeFrame(output, err.toJsonRpcErrorResponse(rawId));
    }
  }

  isClientInitialized(): boolean {
    return this.initialized;
  }

  async waitForActiveTurns(): Promise<void> {
    while (this.activeTurns.size > 0) {
      await Promise.all([...this.activeTurns.values()].map((turn) => turn.done));
    }
  }

  /**
   * 绑定 `stdio://` NDJSON 输入输出流，返回在输入流结束且全部在途工作收口后 resolve 的 Promise。
   */
  serveStdio(input: Readable = process.stdin, output: Writable = process.stdout): Promise<void> {
    const rl = createInterface({ input, crlfDelay: Infinity });
    this.closeStdio = () => rl.close();
    const inFlightLines = new Set<Promise<void>>();

    return new Promise((resolve) => {
      rl.on('line', (line) => {
        const task = this.handleLine(line, output).finally(() => {
          inFlightLines.delete(task);
        });
        inFlightLines.add(task);
      });

      rl.on('close', () => {
        this.closeStdio = null;
        void (async () => {
          await Promise.all(inFlightLines);
          await this.waitForActiveTurns();
          await this.ledger.flush();
          resolve();
        })();
      });
    });
  }

  async shutdown(reason = 'shutdown'): Promise<void> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = (async () => {
        this.logDiagnostic('info', `Shutting down NUH daemon (${reason})`);
        this.closeStdio?.();
        this.abortAllActiveTurns();
        await this.waitForActiveTurns();
        await this.ledger.flush();
        await this.runtime.dispose();
      })();
    }
    await this.shutdownPromise;
  }
}

export async function createNuhDaemon(options?: NuhDaemonOptions): Promise<NuhDaemon> {
  return NuhDaemon.create(options);
}
