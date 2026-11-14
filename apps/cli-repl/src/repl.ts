import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import {
  type ApprovalDecision,
  type BackendKind,
  BackendKindSchema,
  type BackendStatus,
  classifyJsonRpcMessage,
  InitializeResultSchema,
  type JsonRpcId,
  NUH_ERROR_CODES,
  NUH_PROTOCOL_VERSION,
  NuhProtocolError,
  parseNdjsonJson,
  parseNuhNotification,
  parseNuhServerRequest,
  serializeNdjsonLine,
  type ThoughtLevel,
  ThoughtLevelSchema,
  ThreadListResultSchema,
  ThreadSetBackendResultSchema,
  ThreadStartResultSchema,
  TurnInterruptResultSchema,
  TurnStartResultSchema,
} from '@nuh/protocol';

export interface ReplOptions {
  readonly daemonEntry?: string;
  readonly daemonArgs?: readonly string[];
  readonly daemonEnv?: NodeJS.ProcessEnv;
  readonly workdir?: string;
  readonly defaultBackend?: BackendKind;
  readonly defaultModel?: string;
  readonly input?: Readable;
  readonly output?: Writable;
  readonly errorOutput?: Writable;
  readonly interactivePrompt?: boolean;
}

interface PendingRpc {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
}

interface PendingApprovalPrompt {
  readonly id: JsonRpcId;
  readonly resolve: (decision: ApprovalDecision) => void;
}

export function resolveDefaultDaemonEntry(): string {
  const fromEnv = process.env.NUH_DAEMON_ENTRY?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return path.resolve(fromEnv);
  }
  const candidates = [
    path.resolve(import.meta.dirname, '../../../packages/core/dist/bin.js'),
    path.resolve(import.meta.dirname, '../../../packages/core/src/bin.ts'),
    path.resolve(process.cwd(), 'packages/core/dist/bin.js'),
    path.resolve(process.cwd(), 'packages/core/src/bin.ts'),
    path.resolve(process.cwd(), 'node_modules/.bin/nuh-daemon'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `无法定位 NUH Daemon 入口文件，请先运行 pnpm build 或通过 --daemon / NUH_DAEMON_ENTRY 指定路径`,
  );
}

function parseApprovalChoice(input: string): ApprovalDecision | null {
  const normalized = input.trim().toLowerCase();
  if (
    normalized === 'y' ||
    normalized === 'yes' ||
    normalized === 'allow' ||
    normalized === 'allow_once'
  ) {
    return 'allow_once';
  }
  if (normalized === 'a' || normalized === 'always' || normalized === 'allow_for_session') {
    return 'allow_for_session';
  }
  if (normalized === 'n' || normalized === 'no' || normalized === 'deny') {
    return 'deny';
  }
  return null;
}

function formatBackendList(backends: readonly BackendStatus[]): string {
  return backends
    .map(
      (b) =>
        `  - ${b.kind}: available=${String(b.available)} authenticated=${String(b.authenticated)}${b.reason ? ` (${b.reason})` : ''}`,
    )
    .join('\n');
}

/**
 * 极简纯 stdio REPL 客户端（仅使用 Node 原生 `readline` + `child_process`，仅依赖 `@nuh/protocol`）。
 */
export async function startRepl(options: ReplOptions = {}): Promise<number> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const errorOutput = options.errorOutput ?? process.stderr;
  const workdir = path.resolve(options.workdir ?? process.cwd());
  const interactivePrompt =
    options.interactivePrompt ?? Boolean((input as { isTTY?: boolean }).isTTY);

  const daemonEntry = options.daemonEntry
    ? path.resolve(options.daemonEntry)
    : resolveDefaultDaemonEntry();

  const child = spawn(process.execPath, [daemonEntry, ...(options.daemonArgs ?? [])], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: options.daemonEnv ? { ...process.env, ...options.daemonEnv } : process.env,
  });

  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error('Daemon 子进程未正确建立 stdio 管道');
  }

  const daemonStdin = child.stdin;
  const daemonStdout = child.stdout;
  const daemonStderr = child.stderr;

  const pending = new Map<JsonRpcId, PendingRpc>();
  const pendingApprovalQueue: PendingApprovalPrompt[] = [];
  let nextRequestId = 1;
  let currentThreadId: string | null = null;
  let currentBackend: BackendKind = options.defaultBackend ?? 'native-dsh';
  let currentModel: string | undefined = options.defaultModel;
  let currentThoughtLevel: ThoughtLevel | undefined;
  let knownBackends: BackendStatus[] = [];
  let activeTurnId: string | null = null;
  const completedTurnIds = new Set<string>();
  const turnWaiters = new Map<string, () => void>();
  let daemonExited = false;

  const childExitPromise = new Promise<number>((resolve, reject) => {
    child.on('error', (err) => {
      reject(err);
    });
    child.on('exit', (code, signal) => {
      daemonExited = true;
      for (const [id, entry] of pending.entries()) {
        pending.delete(id);
        entry.reject(
          new NuhProtocolError(
            NUH_ERROR_CODES.BACKEND_PROCESS_ERROR,
            `Daemon 在请求 ${String(id)} 完成前退出 (code=${String(code)}, signal=${String(signal)})`,
          ),
        );
      }
      while (pendingApprovalQueue.length > 0) {
        const approval = pendingApprovalQueue.shift();
        approval?.resolve('deny');
      }
      for (const [turnId, wake] of turnWaiters.entries()) {
        completedTurnIds.add(turnId);
        wake();
      }
      turnWaiters.clear();
      resolve(code ?? (signal ? 1 : 0));
    });
  });

  const stderrRl = createInterface({ input: daemonStderr, crlfDelay: Infinity });
  stderrRl.on('line', (line) => {
    if (process.env.NUH_REPL_VERBOSE === '1') {
      errorOutput.write(`[daemon:stderr] ${line}\n`);
    }
  });

  const sendRequest = (method: string, params: unknown): Promise<unknown> => {
    const id = nextRequestId;
    nextRequestId += 1;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      daemonStdin.write(
        serializeNdjsonLine({
          jsonrpc: '2.0',
          id,
          method,
          params,
        }),
      );
    });
  };

  const sendNotification = (method: string, params?: unknown): void => {
    daemonStdin.write(
      serializeNdjsonLine({
        jsonrpc: '2.0',
        method,
        ...(params !== undefined ? { params } : {}),
      }),
    );
  };

  const sendApprovalResponse = (id: JsonRpcId, decision: ApprovalDecision, note?: string): void => {
    if (daemonStdin.writableEnded || daemonStdin.destroyed) {
      return;
    }
    daemonStdin.write(
      serializeNdjsonLine({
        jsonrpc: '2.0',
        id,
        result: {
          decision,
          ...(note !== undefined ? { note } : {}),
        },
      }),
    );
  };

  const stdoutRl = createInterface({ input: daemonStdout, crlfDelay: Infinity });
  stdoutRl.on('line', (line) => {
    try {
      const raw = parseNdjsonJson(line);
      const frame = classifyJsonRpcMessage(raw, { requireJsonRpcVersion: true });
      if (frame.kind === 'response_success') {
        const entry = pending.get(frame.message.id);
        if (entry) {
          pending.delete(frame.message.id);
          entry.resolve(frame.message.result);
        }
        return;
      }
      if (frame.kind === 'response_error') {
        const id = frame.message.id;
        if (id !== null) {
          const entry = pending.get(id);
          if (entry) {
            pending.delete(id);
            entry.reject(
              new NuhProtocolError(
                NUH_ERROR_CODES.INTERNAL_ERROR,
                frame.message.error.message,
                frame.message.error,
              ),
            );
          }
        } else {
          errorOutput.write(`[daemon:error] ${frame.message.error.message}\n`);
        }
        return;
      }
      if (frame.kind === 'notification') {
        const notif = parseNuhNotification(raw);
        switch (notif.method) {
          case 'turn/started':
            output.write(`[turn ${notif.params.turnId} started (${notif.params.backend})]\n`);
            break;
          case 'item/started':
            output.write(`[item ${notif.params.itemId} started (${notif.params.kind})]\n`);
            break;
          case 'item/delta':
            if (notif.params.channel === 'thinking') {
              output.write(`[thinking] ${notif.params.delta}`);
            } else {
              output.write(notif.params.delta);
            }
            break;
          case 'item/completed':
            output.write(`\n[item ${notif.params.itemId} ${notif.params.status}]\n`);
            break;
          case 'turn/completed':
            output.write(
              `[turn ${notif.params.turnId} ${notif.params.status}${notif.params.error ? `: ${notif.params.error.message}` : ''}]\n`,
            );
            completedTurnIds.add(notif.params.turnId);
            if (activeTurnId === notif.params.turnId) {
              activeTurnId = null;
            }
            {
              const wake = turnWaiters.get(notif.params.turnId);
              if (wake) {
                turnWaiters.delete(notif.params.turnId);
                wake();
              }
            }
            break;
        }
        return;
      }
      if (frame.kind === 'request') {
        const srvReq = parseNuhServerRequest(raw);
        const commandLine = srvReq.params.command ? `\n  command: ${srvReq.params.command}` : '';
        output.write(
          `\n[approval required] (${srvReq.params.backend}/${srvReq.params.category}) ${srvReq.params.title}${commandLine}\nApprove? [y=allow_once / a=allow_for_session / n=deny]: `,
        );
        void new Promise<ApprovalDecision>((resolve) => {
          pendingApprovalQueue.push({ id: srvReq.id, resolve });
        }).then((decision) => {
          sendApprovalResponse(srvReq.id, decision);
        });
      }
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      errorOutput.write(`[repl:protocol-error] ${detail}\n`);
    }
  });

  const waitForTurn = async (turnId: string): Promise<void> => {
    if (completedTurnIds.has(turnId) || daemonExited) {
      return;
    }
    await new Promise<void>((resolve) => {
      turnWaiters.set(turnId, resolve);
    });
  };

  const waitForActiveTurn = async (): Promise<void> => {
    if (!activeTurnId) {
      return;
    }
    await waitForTurn(activeTurnId);
  };

  const initRaw = await sendRequest('initialize', {
    clientInfo: { name: 'nuh-cli-repl', version: '0.1.0' },
    protocolVersion: NUH_PROTOCOL_VERSION,
  });
  const initRes = InitializeResultSchema.parse(initRaw);
  knownBackends = initRes.backends;
  sendNotification('initialized');

  const threadRaw = await sendRequest('thread/start', {
    workdir,
    defaultBackend: currentBackend,
    ...(currentModel !== undefined ? { model: currentModel } : {}),
  });
  const threadRes = ThreadStartResultSchema.parse(threadRaw);
  currentThreadId = threadRes.threadId;

  output.write(
    `[connected] ${initRes.serverInfo.name} v${initRes.serverInfo.version} (plugins=${String(initRes.loadedDshPlugins.length)})\n`,
  );
  output.write(`[thread ${currentThreadId} ready (backend=${currentBackend})]\n`);

  const userRl = createInterface({
    input,
    ...(interactivePrompt ? { output, prompt: 'nuh> ' } : {}),
    crlfDelay: Infinity,
  });

  const onSigInt = (): void => {
    if (!daemonExited) {
      child.kill('SIGINT');
    }
    userRl.close();
  };
  process.on('SIGINT', onSigInt);

  const showPrompt = (): void => {
    if (interactivePrompt) {
      userRl.prompt();
    }
  };

  let closing = false;
  let lineQueue = Promise.resolve();

  const flushPendingApprovalsAsDeny = (): void => {
    while (pendingApprovalQueue.length > 0) {
      const approval = pendingApprovalQueue.shift();
      approval?.resolve('deny');
    }
  };

  const finishAndClose = async (): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;
    flushPendingApprovalsAsDeny();
    await waitForActiveTurn();
    if (!daemonStdin.writableEnded && !daemonStdin.destroyed) {
      daemonStdin.end();
    }
    userRl.close();
  };

  showPrompt();

  await new Promise<void>((resolveLoop) => {
    userRl.on('line', (rawLine) => {
      const trimmed = rawLine.trim();
      if (trimmed === '/interrupt') {
        flushPendingApprovalsAsDeny();
        void (async () => {
          try {
            if (!currentThreadId || !activeTurnId) {
              output.write('[no active turn]\n');
            } else {
              const intRaw = await sendRequest('turn/interrupt', {
                threadId: currentThreadId,
                turnId: activeTurnId,
              });
              const intRes = TurnInterruptResultSchema.parse(intRaw);
              output.write(`[interrupt ${String(intRes.interrupted)}]\n`);
            }
          } catch (cause) {
            const detail = cause instanceof Error ? cause.message : String(cause);
            errorOutput.write(`[repl:error] ${detail}\n`);
          }
          showPrompt();
        })();
        return;
      }

      if (pendingApprovalQueue.length > 0) {
        const decision = parseApprovalChoice(trimmed);
        if (decision !== null) {
          const approval = pendingApprovalQueue.shift();
          approval?.resolve(decision);
        } else {
          output.write(
            'Invalid choice. Enter y (allow_once), a (allow_for_session), or n (deny): ',
          );
        }
        return;
      }

      lineQueue = lineQueue.then(async () => {
        if (closing) {
          return;
        }
        if (trimmed.length === 0) {
          showPrompt();
          return;
        }
        try {
          if (trimmed === '/quit' || trimmed === '/exit') {
            await finishAndClose();
            return;
          }
          if (trimmed === '/help') {
            output.write(
              'Commands: /backends, /backend <kind> [model] [low|medium|high], /model <model> [low|medium|high], /interrupt, /thread, /threads, /quit\n',
            );
            showPrompt();
            return;
          }
          if (trimmed === '/backends') {
            output.write(`[backends]\n${formatBackendList(knownBackends)}\n`);
            showPrompt();
            return;
          }
          if (trimmed === '/backend') {
            output.write(
              `[backend ${currentBackend}${currentModel ? ` model=${currentModel}` : ''}${currentThoughtLevel ? ` thought=${currentThoughtLevel}` : ''}]\n`,
            );
            showPrompt();
            return;
          }
          if (trimmed.startsWith('/backend ')) {
            if (!currentThreadId) {
              errorOutput.write('[repl:error] 未初始化 threadId\n');
              showPrompt();
              return;
            }
            const parts = trimmed.slice('/backend '.length).trim().split(/\s+/);
            const backendParsed = BackendKindSchema.safeParse(parts[0]);
            if (!backendParsed.success) {
              errorOutput.write(
                `[repl:error] 不支持的后端 "${parts[0] ?? ''}"，可选: native-dsh | codex | agy | claude\n`,
              );
              showPrompt();
              return;
            }
            const modelArg = parts[1];
            const thoughtArg = parts[2];
            let thoughtParsed: ThoughtLevel | undefined;
            if (thoughtArg !== undefined) {
              const checked = ThoughtLevelSchema.safeParse(thoughtArg);
              if (!checked.success) {
                errorOutput.write(
                  `[repl:error] 无效 thoughtLevel "${thoughtArg}"，可选: low | medium | high\n`,
                );
                showPrompt();
                return;
              }
              thoughtParsed = checked.data;
            }
            const resRaw = await sendRequest('thread/setBackend', {
              threadId: currentThreadId,
              backend: backendParsed.data,
              ...(modelArg !== undefined ? { model: modelArg } : {}),
              ...(thoughtParsed !== undefined ? { thoughtLevel: thoughtParsed } : {}),
            });
            const res = ThreadSetBackendResultSchema.parse(resRaw);
            currentBackend = res.backend;
            currentModel = res.model;
            currentThoughtLevel = res.thoughtLevel;
            output.write(
              `[backend switched -> ${currentBackend}${currentModel ? ` model=${currentModel}` : ''}${currentThoughtLevel ? ` thought=${currentThoughtLevel}` : ''}]\n`,
            );
            showPrompt();
            return;
          }
          if (trimmed.startsWith('/model ')) {
            if (!currentThreadId) {
              errorOutput.write('[repl:error] 未初始化 threadId\n');
              showPrompt();
              return;
            }
            const parts = trimmed.slice('/model '.length).trim().split(/\s+/);
            const modelArg = parts[0];
            if (!modelArg) {
              errorOutput.write('[repl:error] 用法: /model <model> [low|medium|high]\n');
              showPrompt();
              return;
            }
            const thoughtArg = parts[1];
            let thoughtParsed: ThoughtLevel | undefined;
            if (thoughtArg !== undefined) {
              const checked = ThoughtLevelSchema.safeParse(thoughtArg);
              if (!checked.success) {
                errorOutput.write(
                  `[repl:error] 无效 thoughtLevel "${thoughtArg}"，可选: low | medium | high\n`,
                );
                showPrompt();
                return;
              }
              thoughtParsed = checked.data;
            }
            const resRaw = await sendRequest('thread/setBackend', {
              threadId: currentThreadId,
              backend: currentBackend,
              model: modelArg,
              ...(thoughtParsed !== undefined ? { thoughtLevel: thoughtParsed } : {}),
            });
            const res = ThreadSetBackendResultSchema.parse(resRaw);
            currentModel = res.model;
            currentThoughtLevel = res.thoughtLevel;
            output.write(
              `[model updated -> ${currentBackend}${currentModel ? ` model=${currentModel}` : ''}${currentThoughtLevel ? ` thought=${currentThoughtLevel}` : ''}]\n`,
            );
            showPrompt();
            return;
          }
          if (trimmed === '/thread') {
            output.write(`[thread ${currentThreadId ?? '(none)'}]\n`);
            showPrompt();
            return;
          }
          if (trimmed === '/threads') {
            const listRaw = await sendRequest('thread/list', {});
            const listRes = ThreadListResultSchema.parse(listRaw);
            output.write(`${JSON.stringify(listRes.threads)}\n`);
            showPrompt();
            return;
          }
          if (!currentThreadId) {
            errorOutput.write('[repl:error] 未初始化 threadId\n');
            showPrompt();
            return;
          }
          const turnRaw = await sendRequest('turn/start', {
            threadId: currentThreadId,
            input: trimmed,
          });
          const turnRes = TurnStartResultSchema.parse(turnRaw);
          if (!completedTurnIds.has(turnRes.turnId)) {
            activeTurnId = turnRes.turnId;
          }
          await waitForTurn(turnRes.turnId);
        } catch (cause) {
          const detail = cause instanceof Error ? cause.message : String(cause);
          errorOutput.write(`[repl:error] ${detail}\n`);
        }
        showPrompt();
      });
    });

    userRl.on('close', () => {
      flushPendingApprovalsAsDeny();
      void (async () => {
        await lineQueue;
        await finishAndClose();
        resolveLoop();
      })();
    });
  });

  process.off('SIGINT', onSigInt);
  const exitCode = await childExitPromise;
  stdoutRl.close();
  stderrRl.close();
  return exitCode;
}
