import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { accessSync, constants, existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  formatZodValidationError,
  type JsonRpcErrorObject,
  type JsonRpcId,
  NUH_ERROR_CODES,
  NuhProtocolError,
  parseNdjsonJson,
  serializeNdjsonLine,
} from '@nuh/protocol';
import type { z } from 'zod';
import type { BackendDiagnosticLogger } from './types.ts';

export function parseExternalSchema<TSchema extends z.ZodType>(
  schema: TSchema,
  data: unknown,
  context: string,
): z.infer<TSchema> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw formatZodValidationError(
      context,
      parsed.error,
      NUH_ERROR_CODES.PROTOCOL_VALIDATION_ERROR,
    );
  }
  return parsed.data;
}

export interface ResolvedBackendCommand {
  readonly available: boolean;
  readonly command: string;
  readonly args: readonly string[];
  readonly overridden: boolean;
  readonly reason?: string;
}

function isPathLike(target: string): boolean {
  return path.isAbsolute(target) || target.includes('/') || target.includes('\\');
}

function isExecutableOnPath(binary: string): string | null {
  if (isPathLike(binary)) {
    if (!existsSync(binary)) {
      return null;
    }
    try {
      accessSync(binary, constants.X_OK);
      return binary;
    } catch {
      return binary.endsWith('.mjs') || binary.endsWith('.js') || binary.endsWith('.ts')
        ? binary
        : null;
    }
  }

  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = path.join(dir, binary);
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // ignore non-executable candidate
    }
  }
  return null;
}

function parseEnvArgs(raw: string | undefined, fallback: readonly string[]): readonly string[] {
  if (!raw || raw.trim().length === 0) {
    return fallback;
  }
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed;
    }
  }
  return trimmed.split(/\s+/);
}

/**
 * 解析外部 CLI 可执行文件配置：
 * - 若通过 options 或环境变量指定了测试替身/显式路径，优先使用它（即使设置了 NUH_DISABLE_EXTERNAL_LLM=1）
 * - 否则在 NUH_DISABLE_EXTERNAL_LLM=1 时禁止探测或启动真实外部 CLI
 */
export function resolveBackendCommand(params: {
  readonly explicitCommand?: string;
  readonly explicitArgs?: readonly string[];
  readonly envBinVar: string;
  readonly envArgsVar: string;
  readonly defaultCommand: string;
  readonly defaultArgs: readonly string[];
}): ResolvedBackendCommand {
  const envBin = process.env[params.envBinVar]?.trim();
  const rawCommand = params.explicitCommand?.trim() || (envBin && envBin.length > 0 ? envBin : '');
  const overridden = rawCommand.length > 0;

  if (overridden) {
    const args =
      params.explicitArgs ?? parseEnvArgs(process.env[params.envArgsVar], params.defaultArgs);
    const resolved = isExecutableOnPath(rawCommand);
    if (!resolved) {
      return {
        available: false,
        command: rawCommand,
        args,
        overridden: true,
        reason: `Configured binary not found or not executable: ${rawCommand}`,
      };
    }
    if (resolved.endsWith('.mjs') || resolved.endsWith('.js') || resolved.endsWith('.ts')) {
      return {
        available: true,
        command: process.execPath,
        args: [resolved, ...args],
        overridden: true,
      };
    }
    return {
      available: true,
      command: resolved,
      args,
      overridden: true,
    };
  }

  if (process.env.NUH_DISABLE_EXTERNAL_LLM === '1') {
    return {
      available: false,
      command: params.defaultCommand,
      args: params.defaultArgs,
      overridden: false,
      reason: 'External LLM disabled by NUH_DISABLE_EXTERNAL_LLM=1',
    };
  }

  const resolvedDefault = isExecutableOnPath(params.defaultCommand);
  if (!resolvedDefault) {
    return {
      available: false,
      command: params.defaultCommand,
      args: params.defaultArgs,
      overridden: false,
      reason: `${params.defaultCommand} binary not found in PATH`,
    };
  }

  return {
    available: true,
    command: resolvedDefault,
    args: params.explicitArgs ?? params.defaultArgs,
    overridden: false,
  };
}

export type ParsedWireFrame<TReq, TNotif> =
  | { readonly kind: 'server_request'; readonly message: TReq }
  | { readonly kind: 'notification'; readonly message: TNotif }
  | {
      readonly kind: 'response_success';
      readonly message: { readonly id: JsonRpcId; readonly result: unknown };
    }
  | {
      readonly kind: 'response_error';
      readonly message: { readonly id: JsonRpcId | null; readonly error: JsonRpcErrorObject };
    };

export interface ManagedStdioRpcOptions<TReq, TNotif> {
  readonly source: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly logger: BackendDiagnosticLogger;
  readonly parseWireMessage: (raw: unknown) => ParsedWireFrame<TReq, TNotif>;
  readonly onServerRequest: (req: TReq) => Promise<void> | void;
  readonly onNotification: (notif: TNotif) => Promise<void> | void;
  readonly onFatalError: (error: NuhProtocolError) => void;
  readonly onExit: (info: {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly expected: boolean;
  }) => void;
}

interface PendingRpcCall {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
}

/**
 * 托管 `stdio` NDJSON 子进程客户端：
 * - 显式绑定父进程 `SIGINT`/`SIGTERM`/`exit` 级联清理，绝不遗留僵尸进程
 * - `stderr` 严格隔离为结构化日志，绝不混入 `stdout` JSON-RPC 流
 * - 任何 NDJSON / Schema 校验失败均转化为结构化 `NuhProtocolError`，严禁静默吞错
 */
export class ManagedStdioJsonRpcProcess<TReq, TNotif> {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly options: ManagedStdioRpcOptions<TReq, TNotif>;
  private readonly pending = new Map<JsonRpcId, PendingRpcCall>();
  private readonly stdoutRl;
  private readonly stderrRl;
  private nextRequestId = 1;
  private eventQueue: Promise<void> = Promise.resolve();
  private expectedClose = false;
  private exited = false;
  private disposePromise: Promise<void> | null = null;
  private readonly exitPromise: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;

  private readonly onParentSigInt = (): void => {
    this.terminateSync('parent-SIGINT');
  };
  private readonly onParentSigTerm = (): void => {
    this.terminateSync('parent-SIGTERM');
  };
  private readonly onParentExit = (): void => {
    this.terminateSync('parent-exit');
  };

  constructor(options: ManagedStdioRpcOptions<TReq, TNotif>) {
    this.options = options;
    this.child = spawn(options.command, [...options.args], {
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });

    process.on('SIGINT', this.onParentSigInt);
    process.on('SIGTERM', this.onParentSigTerm);
    process.on('exit', this.onParentExit);

    this.child.stdin.on('error', (err) => {
      options.logger('warn', `${options.source} stdin write error`, { error: err.message });
    });

    this.stderrRl = createInterface({ input: this.child.stderr, crlfDelay: Infinity });
    this.stderrRl.on('line', (line) => {
      if (line.trim().length > 0) {
        options.logger('debug', `${options.source} stderr`, { line });
      }
    });

    this.stdoutRl = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.stdoutRl.on('line', (line) => {
      this.handleStdoutLine(line);
    });

    this.exitPromise = new Promise((resolve) => {
      this.child.on('error', (err) => {
        const protoErr = new NuhProtocolError(
          NUH_ERROR_CODES.BACKEND_PROCESS_ERROR,
          `${options.source} 子进程启动或运行失败: ${err.message}`,
          { source: options.source, cause: err.message },
        );
        this.rejectAllPending(protoErr);
        if (!this.expectedClose) {
          options.onFatalError(protoErr);
        }
      });

      this.child.on('exit', (code, signal) => {
        this.exited = true;
        this.detachParentHooks();
        this.stdoutRl.close();
        this.stderrRl.close();
        const expected = this.expectedClose;
        const exitErr = new NuhProtocolError(
          NUH_ERROR_CODES.BACKEND_PROCESS_ERROR,
          `${options.source} 子进程退出 (code=${String(code)}, signal=${String(signal)})`,
          { source: options.source, code, signal, expected },
        );
        this.rejectAllPending(exitErr);
        options.onExit({ code, signal, expected });
        resolve({ code, signal });
      });
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  isAlive(): boolean {
    return !this.exited && this.child.exitCode === null && !this.child.killed;
  }

  private detachParentHooks(): void {
    process.off('SIGINT', this.onParentSigInt);
    process.off('SIGTERM', this.onParentSigTerm);
    process.off('exit', this.onParentExit);
  }

  private terminateSync(reason: string): void {
    this.expectedClose = true;
    this.detachParentHooks();
    if (this.exited || this.child.exitCode !== null) {
      return;
    }
    this.options.logger('debug', `Terminating ${this.options.source} child process`, {
      pid: this.child.pid,
      reason,
    });
    if (!this.child.stdin.writableEnded && !this.child.stdin.destroyed) {
      this.child.stdin.end();
    }
    if (reason === 'parent-exit') {
      this.child.kill('SIGKILL');
      return;
    }
    this.child.kill('SIGTERM');
    const killTimer = setTimeout(() => {
      if (!this.exited && this.child.exitCode === null) {
        this.child.kill('SIGKILL');
      }
    }, 1500);
    killTimer.unref();
  }

  private rejectAllPending(error: Error): void {
    for (const [id, entry] of this.pending.entries()) {
      this.pending.delete(id);
      entry.reject(error);
    }
  }

  private handleStdoutLine(line: string): void {
    let frame: ParsedWireFrame<TReq, TNotif>;
    try {
      const raw = parseNdjsonJson(line);
      frame = this.options.parseWireMessage(raw);
    } catch (cause) {
      const protoErr =
        cause instanceof NuhProtocolError
          ? cause
          : new NuhProtocolError(
              NUH_ERROR_CODES.PROTOCOL_VALIDATION_ERROR,
              `${this.options.source} 下行报文解析失败: ${cause instanceof Error ? cause.message : String(cause)}`,
            );
      this.options.logger('error', `${this.options.source} wire parse error`, {
        code: protoErr.code,
        message: protoErr.message,
      });
      this.rejectAllPending(protoErr);
      this.options.onFatalError(protoErr);
      return;
    }

    if (frame.kind === 'response_success') {
      const entry = this.pending.get(frame.message.id);
      if (entry) {
        this.pending.delete(frame.message.id);
        entry.resolve(frame.message.result);
      } else {
        this.options.logger('warn', `${this.options.source} received unmatched success response`, {
          id: frame.message.id,
        });
      }
      return;
    }

    if (frame.kind === 'response_error') {
      const id = frame.message.id;
      const err = new NuhProtocolError(
        NUH_ERROR_CODES.BACKEND_PROCESS_ERROR,
        `${this.options.source} RPC 错误 (${String(frame.message.error.code)}): ${frame.message.error.message}`,
        frame.message.error,
      );
      if (id !== null) {
        const entry = this.pending.get(id);
        if (entry) {
          this.pending.delete(id);
          entry.reject(err);
          return;
        }
      }
      this.options.onFatalError(err);
      return;
    }

    if (frame.kind === 'notification') {
      const notif = frame.message;
      this.eventQueue = this.eventQueue
        .then(() => this.options.onNotification(notif))
        .catch((cause: unknown) => {
          const protoErr =
            cause instanceof NuhProtocolError
              ? cause
              : new NuhProtocolError(
                  NUH_ERROR_CODES.INTERNAL_ERROR,
                  `${this.options.source} 通知处理异常: ${cause instanceof Error ? cause.message : String(cause)}`,
                );
          this.options.onFatalError(protoErr);
        });
      return;
    }

    // Server-initiated request: wait for already-queued notifications (e.g. item/started)
    // to flush first, then handle concurrently so RPC responses/notifications are not blocked.
    const req = frame.message;
    void this.eventQueue.then(async () => {
      try {
        await this.options.onServerRequest(req);
      } catch (cause) {
        const protoErr =
          cause instanceof NuhProtocolError
            ? cause
            : new NuhProtocolError(
                NUH_ERROR_CODES.INTERNAL_ERROR,
                `${this.options.source} 服务端请求处理异常: ${cause instanceof Error ? cause.message : String(cause)}`,
              );
        this.options.onFatalError(protoErr);
      }
    });
  }

  sendRaw(payload: unknown): void {
    if (!this.isAlive() || this.child.stdin.writableEnded || this.child.stdin.destroyed) {
      throw new NuhProtocolError(
        NUH_ERROR_CODES.BACKEND_PROCESS_ERROR,
        `${this.options.source} 子进程 stdin 已关闭，无法发送报文`,
      );
    }
    this.child.stdin.write(serializeNdjsonLine(payload));
  }

  sendRequest(method: string, params?: unknown, explicitId?: JsonRpcId): Promise<unknown> {
    const id = explicitId ?? this.nextRequestId;
    if (explicitId === undefined) {
      this.nextRequestId += 1;
    }
    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    return new Promise((resolve, reject) => {
      if (!this.isAlive()) {
        reject(
          new NuhProtocolError(
            NUH_ERROR_CODES.BACKEND_PROCESS_ERROR,
            `${this.options.source} 子进程未运行，无法发送 ${method}`,
          ),
        );
        return;
      }
      this.pending.set(id, { method, resolve, reject });
      try {
        this.sendRaw(payload);
      } catch (cause) {
        this.pending.delete(id);
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  }

  sendNotification(method: string, params?: unknown): void {
    this.sendRaw({
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    });
  }

  sendResponse(id: JsonRpcId, result: unknown): void {
    this.sendRaw({
      jsonrpc: '2.0',
      id,
      result,
    });
  }

  async flushEvents(): Promise<void> {
    await this.eventQueue;
  }

  async dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.disposePromise = (async () => {
        if (this.exited || this.child.exitCode !== null) {
          this.detachParentHooks();
          return;
        }
        this.terminateSync('dispose');
        await this.exitPromise;
      })();
    }
    await this.disposePromise;
  }
}
