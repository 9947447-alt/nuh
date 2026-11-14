import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import {
  type BackendMcpServerConfig,
  type BackendRegistry,
  createDefaultBackendRegistry,
} from '@nuh/backends';
import { HeadlessMnemonExecutor } from '@nuh/dsh-shims';
import {
  createMcpBridgeLaunchSpec,
  McpBridgeIpcServer,
  type McpBridgeJsonSchemaObject,
  type McpBridgeToolProvider,
} from '@nuh/mcp-bridge';
import {
  type ApprovalRequestedParams,
  ApprovalRequestedParamsSchema,
  type ApprovalRequestedResult,
  ApprovalRequestedResultSchema,
  type BackendKind,
  classifyJsonRpcMessage,
  formatZodValidationError,
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
  type ThoughtLevel,
  type ThreadSummary,
  toNuhNotification,
} from '@nuh/protocol';
import {
  bootDshHeadlessRuntime,
  type DshHeadlessBootOptions,
  type DshHeadlessRuntime,
} from './dsh-runtime.ts';
import { NativeDshEchoBackend } from './echo-backend.ts';
import { AuditLedger, buildHandoffPrompt, resolveDefaultNuhHome } from './ledger.ts';

interface ThreadRecord {
  readonly threadId: string;
  readonly workdir: string;
  activeBackend: BackendKind;
  lastExecutedBackend: BackendKind | null;
  model?: string;
  thoughtLevel?: ThoughtLevel;
  readonly backendSessions: Map<BackendKind, string>;
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

interface PendingApprovalRecord {
  readonly resolve: (result: ApprovalRequestedResult) => void;
  readonly reject: (reason: Error) => void;
}

export interface NuhDaemonOptions {
  readonly dshOptions?: DshHeadlessBootOptions;
  readonly nuhHome?: string;
  readonly echoStepDelayMs?: number;
  readonly runtime?: DshHeadlessRuntime;
  readonly backendRegistry?: BackendRegistry;
  readonly enableMcpBridge?: boolean;
  readonly stderr?: Writable;
}

function isJsonSchemaObject(schema: unknown): schema is McpBridgeJsonSchemaObject {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    !Array.isArray(schema) &&
    'type' in schema &&
    schema.type === 'object'
  );
}

function toBackendMcpServerConfig(socketPath: string, cwd?: string): BackendMcpServerConfig {
  const launch = createMcpBridgeLaunchSpec({
    socketPath,
    ...(cwd ? { cwd } : {}),
  });
  return {
    name: launch.serverName,
    command: launch.command,
    args: launch.args,
    env: launch.env,
  };
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
 * NUH 无头守护进程内核（Phase 1 Step 1.3）：
 * - 托管 `@deepseek-ai/dsh-base` 无头 Cordis 容器生命周期
 * - 通过 `@nuh/backends` 注册表调度 `native-dsh` / `codex` / `agy`（及预留 `claude`）后端
 * - 通过 `stdio://` NDJSON 暴露 `@nuh/protocol` JSON-RPC 2.0 服务端与双向 `approval/requested` 审批通道
 * - 跨后端切换时从 `ledger.jsonl` 提取近期上下文摘要注入新后端（Handoff Summary）
 */
export class NuhDaemon {
  readonly runtime: DshHeadlessRuntime;
  readonly ledger: AuditLedger;
  readonly backends: BackendRegistry;
  private readonly stderr: Writable;
  private readonly mcpServer: McpBridgeIpcServer | undefined;
  private readonly mnemonExecutor: HeadlessMnemonExecutor | undefined;
  private readonly threads = new Map<string, ThreadRecord>();
  private readonly knownTurnIds = new Map<string, string>();
  private readonly activeTurns = new Map<string, ActiveTurnRecord>();
  private readonly pendingApprovals = new Map<JsonRpcId, PendingApprovalRecord>();
  private nextServerRequestSeq = 1;
  private initialized = false;
  private shutdownPromise: Promise<void> | null = null;
  private closeStdio: (() => void) | null = null;

  private constructor(
    runtime: DshHeadlessRuntime,
    ledger: AuditLedger,
    options: NuhDaemonOptions,
    mcpServer?: McpBridgeIpcServer,
    mnemonExecutor?: HeadlessMnemonExecutor,
  ) {
    this.runtime = runtime;
    this.ledger = ledger;
    this.stderr = options.stderr ?? process.stderr;
    this.mcpServer = mcpServer;
    this.mnemonExecutor = mnemonExecutor;
    const defaultMcpServers = mcpServer
      ? [toBackendMcpServerConfig(mcpServer.socketPath, options.dshOptions?.cwd)]
      : undefined;
    this.backends =
      options.backendRegistry ??
      createDefaultBackendRegistry({
        logger: (level, message, meta) => {
          this.logDiagnostic(level === 'debug' ? 'info' : level, message, meta);
        },
        ...(defaultMcpServers ? { mcpServers: defaultMcpServers } : {}),
        nativeBackend: new NativeDshEchoBackend(options.echoStepDelayMs),
      });
  }

  get mcpSocketPath(): string | undefined {
    return this.mcpServer?.socketPath;
  }

  static async create(options: NuhDaemonOptions = {}): Promise<NuhDaemon> {
    const runtime = options.runtime ?? (await bootDshHeadlessRuntime(options.dshOptions));
    const nuhHome = options.nuhHome ?? resolveDefaultNuhHome();
    const ledger = new AuditLedger(nuhHome);
    const defaultWorkspace = options.dshOptions?.cwd ?? process.cwd();
    const enableMcpBridge = options.enableMcpBridge ?? true;

    let mnemonExecutor: HeadlessMnemonExecutor | undefined;
    let mcpServer: McpBridgeIpcServer | undefined;

    try {
      if (enableMcpBridge) {
        mnemonExecutor = new HeadlessMnemonExecutor(runtime.ctx, defaultWorkspace);
        const executorRef = mnemonExecutor;
        const provider: McpBridgeToolProvider = {
          listTools: () =>
            executorRef.listTools().map((tool) => ({
              name: tool.name,
              description: tool.description,
              inputSchema: isJsonSchemaObject(tool.inputSchema)
                ? tool.inputSchema
                : { type: 'object' as const, properties: {} },
              readOnly: true as const,
            })),
          callTool: (name, args, callOptions) => executorRef.callTool(name, args, callOptions),
        };
        mcpServer = await McpBridgeIpcServer.start({
          nuhHome,
          provider,
          ...(options.stderr ? { stderr: options.stderr } : {}),
        });
      }

      const daemon = new NuhDaemon(runtime, ledger, options, mcpServer, mnemonExecutor);

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
    } catch (error) {
      await mcpServer?.dispose();
      await mnemonExecutor?.dispose();
      if (!options.runtime) {
        await runtime.dispose();
      }
      throw error;
    }
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
    for (const [id, pending] of this.pendingApprovals.entries()) {
      this.pendingApprovals.delete(id);
      pending.resolve({ decision: 'deny', note: 'Daemon shutting down' });
    }
    for (const turn of this.activeTurns.values()) {
      turn.abortController.abort();
    }
  }

  private writeFrame(output: Writable, payload: unknown): void {
    if (!output.writableEnded && !output.destroyed) {
      output.write(serializeNdjsonLine(payload));
    }
  }

  private requestClientApproval(
    output: Writable,
    params: ApprovalRequestedParams,
    signal: AbortSignal,
  ): Promise<ApprovalRequestedResult> {
    const validatedParams = ApprovalRequestedParamsSchema.parse(params);
    if (signal.aborted) {
      return Promise.resolve({ decision: 'deny', note: 'Turn interrupted before approval' });
    }

    const requestId: JsonRpcId = `srv_req_${String(this.nextServerRequestSeq)}`;
    this.nextServerRequestSeq += 1;

    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        if (this.pendingApprovals.delete(requestId)) {
          resolve({ decision: 'deny', note: 'Turn interrupted while awaiting approval' });
        }
      };

      this.pendingApprovals.set(requestId, {
        resolve: (result) => {
          signal.removeEventListener('abort', onAbort);
          resolve(result);
        },
        reject: (err) => {
          signal.removeEventListener('abort', onAbort);
          reject(err);
        },
      });

      signal.addEventListener('abort', onAbort, { once: true });

      this.writeFrame(output, {
        jsonrpc: '2.0',
        id: requestId,
        method: 'approval/requested',
        params: validatedParams,
      });
    });
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
          backends: await this.backends.listStatuses(),
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
          lastExecutedBackend: null,
          ...(req.params.model !== undefined ? { model: req.params.model } : {}),
          backendSessions: new Map(),
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
        const targetBackend = this.backends.require(req.params.backend);
        const status = await targetBackend.getStatus();
        if (!status.available) {
          throw new NuhProtocolError(
            NUH_ERROR_CODES.BACKEND_UNAVAILABLE,
            status.reason ?? `后端 "${req.params.backend}" 当前不可用`,
            {
              backend: req.params.backend,
              ...(status.reason !== undefined ? { code: status.reason } : {}),
            },
          );
        }

        const switchedBackend = req.params.backend !== thread.activeBackend;
        if (switchedBackend) {
          await this.backends.closeThreadOnAll(thread.threadId, req.params.backend);
          thread.activeBackend = req.params.backend;
          if (req.params.model !== undefined) {
            thread.model = req.params.model;
          } else {
            delete thread.model;
          }
          if (req.params.thoughtLevel !== undefined) {
            thread.thoughtLevel = req.params.thoughtLevel;
          } else {
            delete thread.thoughtLevel;
          }
        } else {
          if (req.params.model !== undefined) {
            thread.model = req.params.model;
          }
          if (req.params.thoughtLevel !== undefined) {
            thread.thoughtLevel = req.params.thoughtLevel;
          }
          if (targetBackend.configureSession) {
            await targetBackend.configureSession(thread.threadId, {
              ...(thread.model !== undefined ? { model: thread.model } : {}),
              ...(thread.thoughtLevel !== undefined ? { thoughtLevel: thread.thoughtLevel } : {}),
            });
          }
        }

        thread.updatedAt = new Date().toISOString();
        await this.ledger.appendThreadBackendChanged(thread.threadId, {
          backend: thread.activeBackend,
          ...(thread.model !== undefined ? { model: thread.model } : {}),
          ...(thread.thoughtLevel !== undefined ? { thoughtLevel: thread.thoughtLevel } : {}),
        });
        return {
          threadId: thread.threadId,
          backend: thread.activeBackend,
          ...(thread.model !== undefined ? { model: thread.model } : {}),
          ...(thread.thoughtLevel !== undefined ? { thoughtLevel: thread.thoughtLevel } : {}),
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
        const backend = this.backends.require(resolvedBackend);
        const status = await backend.getStatus();
        if (!status.available) {
          throw new NuhProtocolError(
            NUH_ERROR_CODES.BACKEND_UNAVAILABLE,
            status.reason ?? `后端 "${resolvedBackend}" 当前不可用`,
            {
              resolvedBackend,
              ...(status.reason !== undefined ? { code: status.reason } : {}),
            },
          );
        }

        const turnId = `nuh_turn_${randomUUID().slice(0, 12)}`;
        thread.updatedAt = new Date().toISOString();
        this.knownTurnIds.set(turnId, thread.threadId);

        const isBackendSwitch =
          thread.lastExecutedBackend !== null && thread.lastExecutedBackend !== resolvedBackend;
        const promptForBackend = isBackendSwitch
          ? buildHandoffPrompt(
              req.params.input,
              await this.ledger.summarizeThread(thread.threadId),
              thread.lastExecutedBackend as BackendKind,
              resolvedBackend,
            )
          : req.params.input;
        thread.lastExecutedBackend = resolvedBackend;

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
        const resolvedModel = req.params.modelOverride ?? thread.model;
        const existingSessionId = thread.backendSessions.get(resolvedBackend);

        const done = (async () => {
          try {
            await backend.runTurn({
              threadId: thread.threadId,
              turnId,
              workdir: thread.workdir,
              prompt: promptForBackend,
              ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
              ...(thread.thoughtLevel !== undefined ? { thoughtLevel: thread.thoughtLevel } : {}),
              sandboxMode: thread.sandboxMode,
              approvalPolicy: thread.approvalPolicy,
              ...(this.mcpServer
                ? {
                    mcpServers: [
                      toBackendMcpServerConfig(this.mcpServer.socketPath, thread.workdir),
                    ],
                  }
                : {}),
              ...(existingSessionId !== undefined ? { backendSessionId: existingSessionId } : {}),
              onBackendSessionId: (backendSessionId) => {
                thread.backendSessions.set(resolvedBackend, backendSessionId);
              },
              signal: abortController.signal,
              emit: emitEvent,
              requestApproval: (approvalParams) =>
                this.requestClientApproval(output, approvalParams, abortController.signal),
            });
          } catch (cause) {
            const errorCode =
              cause instanceof NuhProtocolError ? cause.code : NUH_ERROR_CODES.INTERNAL_ERROR;
            const detail = cause instanceof Error ? cause.message : String(cause);
            this.logDiagnostic('error', 'Backend turn execution failed', {
              threadId: thread.threadId,
              turnId,
              backend: resolvedBackend,
              code: errorCode,
              detail,
            });
            await emitEvent({
              type: 'turn/completed',
              payload: {
                threadId: thread.threadId,
                turnId,
                status: 'failed',
                error: {
                  code: errorCode,
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

      if (classified.kind === 'response_success') {
        const pending = this.pendingApprovals.get(classified.message.id);
        if (!pending) {
          throw new NuhProtocolError(
            NUH_ERROR_CODES.INVALID_REQUEST,
            `收到未匹配的 JSON-RPC Response 帧 (id=${String(classified.message.id)})`,
          );
        }
        this.pendingApprovals.delete(classified.message.id);
        const parsedResult = ApprovalRequestedResultSchema.safeParse(classified.message.result);
        if (!parsedResult.success) {
          const err = formatZodValidationError(
            'approval/requested 响应载荷校验失败',
            parsedResult.error,
            NUH_ERROR_CODES.PROTOCOL_VALIDATION_ERROR,
          );
          this.logDiagnostic('error', err.message, { id: classified.message.id });
          pending.reject(err);
          return;
        }
        pending.resolve(parsedResult.data);
        return;
      }

      const id = classified.message.id;
      if (id !== null) {
        const pending = this.pendingApprovals.get(id);
        if (pending) {
          this.pendingApprovals.delete(id);
          pending.resolve({
            decision: 'deny',
            note: classified.message.error.message,
          });
          return;
        }
      }

      throw new NuhProtocolError(
        NUH_ERROR_CODES.INVALID_REQUEST,
        `收到未匹配的 JSON-RPC Error Response 帧 (id=${String(id)})`,
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
        await this.backends.disposeAll();
        await this.mcpServer?.dispose();
        await this.mnemonExecutor?.dispose();
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
