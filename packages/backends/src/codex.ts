import {
  type ApprovalDecision,
  type ApprovalPolicy,
  type BackendStatus,
  CodexAgentMessageDeltaNotificationSchema,
  CodexCommandApprovalRequestSchema,
  type CodexCommandExecutionDecisionSchema,
  CodexFileChangeApprovalRequestSchema,
  CodexInitializeResultSchema,
  type CodexItem,
  CodexItemCompletedNotificationSchema,
  CodexItemStartedNotificationSchema,
  type CodexNotification,
  type CodexServerRequest,
  CodexThreadStartResultSchema,
  CodexTokenUsageUpdatedNotificationSchema,
  CodexTurnCompletedNotificationSchema,
  CodexTurnStartedNotificationSchema,
  CodexTurnStartResultSchema,
  type ItemCompletionStatus,
  type ItemKind,
  NUH_ERROR_CODES,
  type NuhNormalizedEvent,
  NuhNormalizedEventSchema,
  NuhProtocolError,
  type NuhUsage,
  parseCodexClientRequest,
  parseCodexWireMessage,
  type SandboxMode,
} from '@nuh/protocol';
import { z } from 'zod';
import {
  ManagedStdioJsonRpcProcess,
  parseExternalSchema,
  resolveBackendCommand,
} from './stdio-rpc-client.ts';
import type {
  AgentBackend,
  BackendDiagnosticLogger,
  BackendMcpServerConfig,
  BackendTurnRequest,
} from './types.ts';

export interface CodexBackendOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: BackendDiagnosticLogger;
  readonly interruptGraceMs?: number;
  readonly mcpServers?: readonly BackendMcpServerConfig[];
}

const CODEX_MCP_NAME_PATTERN = /^[A-Za-z0-9_]+$/;
const TOML_BARE_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

function formatTomlKey(key: string): string {
  return TOML_BARE_KEY_PATTERN.test(key) ? key : JSON.stringify(key);
}

/**
 * Formats a dynamic `-c mcp_servers.<name>=...` inline TOML override for Codex CLI,
 * avoiding any mutation to global `~/.codex/config.toml`.
 */
export function formatCodexMcpServerOverride(server: BackendMcpServerConfig): string {
  if (!CODEX_MCP_NAME_PATTERN.test(server.name)) {
    throw new Error(
      `Invalid Codex MCP server name "${server.name}": expected ASCII identifier matching [A-Za-z0-9_]+`,
    );
  }
  const fields: string[] = [
    `command=${JSON.stringify(server.command)}`,
    `args=[${server.args.map((arg) => JSON.stringify(arg)).join(',')}]`,
  ];
  const envEntries = Object.entries(server.env ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (envEntries.length > 0) {
    const formattedEnv = envEntries
      .map(([key, value]) => `${formatTomlKey(key)}=${JSON.stringify(value)}`)
      .join(',');
    fields.push(`env={${formattedEnv}}`);
  }
  return `mcp_servers.${server.name}={${fields.join(',')}}`;
}

export function buildCodexMcpCliArgs(mcpServers?: readonly BackendMcpServerConfig[]): string[] {
  if (!mcpServers || mcpServers.length === 0) {
    return [];
  }
  const args: string[] = [];
  for (const server of mcpServers) {
    args.push('-c', formatCodexMcpServerOverride(server));
  }
  return args;
}

const GenericItemDeltaParamsSchema = z
  .object({
    itemId: z.string().min(1),
    delta: z.string(),
  })
  .passthrough();

interface ActiveCodexTurn {
  readonly request: BackendTurnRequest;
  codexTurnId: string | null;
  readonly startedItems: Map<string, ItemKind>;
  readonly itemHasTextDelta: Set<string>;
  readonly itemTextBuffer: Map<string, string>;
  readonly itemHasOutputDelta: Set<string>;
  latestUsage?: NuhUsage;
  settled: boolean;
  interruptRequested: boolean;
  readonly resolve: () => void;
  readonly reject: (err: Error) => void;
}

interface CodexThreadSession {
  readonly threadId: string;
  readonly workdir: string;
  readonly approvalPolicy: ApprovalPolicy;
  readonly sandboxMode: SandboxMode;
  proc: ManagedStdioJsonRpcProcess<CodexServerRequest, CodexNotification> | null;
  codexThreadId?: string;
  activeTurn: ActiveCodexTurn | null;
}

function mapCodexItemKind(codexType: string): ItemKind {
  switch (codexType) {
    case 'agentMessage':
      return 'agent_message';
    case 'reasoning':
      return 'reasoning';
    case 'commandExecution':
      return 'command_exec';
    case 'fileChange':
      return 'file_change';
    default:
      return 'tool_call';
  }
}

function mapCodexItemStatus(status: unknown): ItemCompletionStatus {
  if (typeof status !== 'string') {
    return 'ok';
  }
  switch (status) {
    case 'completed':
    case 'ok':
      return 'ok';
    case 'declined':
    case 'denied':
      return 'denied';
    case 'cancelled':
    case 'interrupted':
    case 'aborted':
      return 'cancelled';
    case 'failed':
    case 'error':
      return 'failed';
    default:
      return 'ok';
  }
}

function mapCodexDecision(
  decision: ApprovalDecision,
  availableDecisions: unknown,
): z.infer<typeof CodexCommandExecutionDecisionSchema> {
  const options = Array.isArray(availableDecisions) ? availableDecisions : [];
  if (decision === 'allow_for_session') {
    if (options.length === 0 || options.includes('acceptForSession')) {
      return 'acceptForSession';
    }
    return 'accept';
  }
  if (decision === 'allow_once') {
    return 'accept';
  }
  if (options.length > 0 && !options.includes('decline') && options.includes('cancel')) {
    return 'cancel';
  }
  return 'decline';
}

function buildItemMeta(item: CodexItem): Record<string, unknown> | undefined {
  const record = item as Record<string, unknown>;
  if (item.type === 'agentMessage') {
    return typeof record.phase === 'string' ? { phase: record.phase } : undefined;
  }
  if (item.type === 'commandExecution') {
    return {
      command: record.command,
      cwd: record.cwd,
    };
  }
  return { rawType: item.type };
}

function noopLogger(): void {
  // default silent diagnostic logger
}

/**
 * Codex App-Server 后端适配器（`codex app-server --stdio`）。
 * 严格遵循 Spike 01 实测约束：
 * - 允许下行报文省略 `"jsonrpc": "2.0"` 并透传未知字段
 * - 通过 `id && method` 优先分派服务端审批请求，防止与客户端请求 ID 碰撞
 * - 订阅流式 `item/*` 归档完整正文与工具输出，不依赖 `turn/completed` 的 `summary` 视图
 */
export class CodexBackend implements AgentBackend {
  readonly kind = 'codex' as const;
  private readonly options: CodexBackendOptions;
  private readonly logger: BackendDiagnosticLogger;
  private readonly interruptGraceMs: number;
  private readonly sessions = new Map<string, CodexThreadSession>();

  constructor(options: CodexBackendOptions = {}) {
    this.options = options;
    this.logger = options.logger ?? noopLogger;
    this.interruptGraceMs = options.interruptGraceMs ?? 1500;
  }

  private resolveCommand() {
    return resolveBackendCommand({
      ...(this.options.command !== undefined ? { explicitCommand: this.options.command } : {}),
      ...(this.options.args !== undefined ? { explicitArgs: this.options.args } : {}),
      envBinVar: 'NUH_CODEX_BIN',
      envArgsVar: 'NUH_CODEX_ARGS',
      defaultCommand: 'codex',
      defaultArgs: ['app-server', '--stdio'],
    });
  }

  async getStatus(): Promise<BackendStatus> {
    const resolved = this.resolveCommand();
    if (!resolved.available) {
      return {
        kind: 'codex',
        available: false,
        authenticated: false,
        ...(resolved.reason !== undefined ? { reason: resolved.reason } : {}),
      };
    }
    return {
      kind: 'codex',
      available: true,
      authenticated: true,
      reason: resolved.overridden
        ? 'configured codex stdio binary ready'
        : 'codex app-server --stdio ready',
    };
  }

  private async emitValidated(
    request: BackendTurnRequest,
    event: NuhNormalizedEvent,
  ): Promise<void> {
    const validated = NuhNormalizedEventSchema.parse(event);
    await request.emit(validated);
  }

  private async sendCodexRequest(
    proc: ManagedStdioJsonRpcProcess<CodexServerRequest, CodexNotification>,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    parseCodexClientRequest({ jsonrpc: '2.0', id: 0, method, params });
    return await proc.sendRequest(method, params);
  }

  private async handleNotification(
    session: CodexThreadSession,
    notif: CodexNotification,
  ): Promise<void> {
    const turn = session.activeTurn;
    if (!turn || turn.settled) {
      return;
    }

    if (notif.method === 'turn/started') {
      const parsed = CodexTurnStartedNotificationSchema.parse(notif);
      turn.codexTurnId = parsed.params.turn.id;
      return;
    }

    if (notif.method === 'item/started') {
      const parsed = CodexItemStartedNotificationSchema.parse(notif);
      const item = parsed.params.item;
      if (item.type === 'userMessage') {
        return;
      }
      const kind = mapCodexItemKind(item.type);
      turn.startedItems.set(item.id, kind);
      const meta = buildItemMeta(item);
      await this.emitValidated(turn.request, {
        type: 'item/started',
        payload: {
          threadId: turn.request.threadId,
          turnId: turn.request.turnId,
          itemId: item.id,
          kind,
          ...(meta !== undefined ? { meta } : {}),
        },
      });
      return;
    }

    if (notif.method === 'item/agentMessage/delta') {
      const parsed = CodexAgentMessageDeltaNotificationSchema.parse(notif);
      turn.itemHasTextDelta.add(parsed.params.itemId);
      const prev = turn.itemTextBuffer.get(parsed.params.itemId) ?? '';
      turn.itemTextBuffer.set(parsed.params.itemId, `${prev}${parsed.params.delta}`);
      await this.emitValidated(turn.request, {
        type: 'item/delta',
        payload: {
          threadId: turn.request.threadId,
          turnId: turn.request.turnId,
          itemId: parsed.params.itemId,
          channel: 'text',
          delta: parsed.params.delta,
        },
      });
      return;
    }

    if (
      notif.method === 'item/reasoning/delta' ||
      notif.method === 'item/reasoning/summaryTextDelta'
    ) {
      const parsed = GenericItemDeltaParamsSchema.safeParse(notif.params);
      if (parsed.success) {
        await this.emitValidated(turn.request, {
          type: 'item/delta',
          payload: {
            threadId: turn.request.threadId,
            turnId: turn.request.turnId,
            itemId: parsed.data.itemId,
            channel: 'thinking',
            delta: parsed.data.delta,
          },
        });
      }
      return;
    }

    if (notif.method === 'item/commandExecution/outputDelta') {
      const parsed = GenericItemDeltaParamsSchema.safeParse(notif.params);
      if (parsed.success) {
        turn.itemHasOutputDelta.add(parsed.data.itemId);
        await this.emitValidated(turn.request, {
          type: 'item/delta',
          payload: {
            threadId: turn.request.threadId,
            turnId: turn.request.turnId,
            itemId: parsed.data.itemId,
            channel: 'stdout',
            delta: parsed.data.delta,
          },
        });
      }
      return;
    }

    if (notif.method === 'item/fileChange/outputDelta') {
      const parsed = GenericItemDeltaParamsSchema.safeParse(notif.params);
      if (parsed.success) {
        turn.itemHasOutputDelta.add(parsed.data.itemId);
        await this.emitValidated(turn.request, {
          type: 'item/delta',
          payload: {
            threadId: turn.request.threadId,
            turnId: turn.request.turnId,
            itemId: parsed.data.itemId,
            channel: 'diff',
            delta: parsed.data.delta,
          },
        });
      }
      return;
    }

    if (notif.method === 'item/completed') {
      const parsed = CodexItemCompletedNotificationSchema.parse(notif);
      const item = parsed.params.item;
      if (item.type === 'userMessage') {
        return;
      }
      const record = item as Record<string, unknown>;
      const kind = turn.startedItems.get(item.id) ?? mapCodexItemKind(item.type);
      if (!turn.startedItems.has(item.id)) {
        turn.startedItems.set(item.id, kind);
        const meta = buildItemMeta(item);
        await this.emitValidated(turn.request, {
          type: 'item/started',
          payload: {
            threadId: turn.request.threadId,
            turnId: turn.request.turnId,
            itemId: item.id,
            kind,
            ...(meta !== undefined ? { meta } : {}),
          },
        });
      }

      const summary: Record<string, unknown> = {};
      if (item.type === 'agentMessage') {
        const rawText = typeof record.text === 'string' ? record.text : '';
        const buffered = turn.itemTextBuffer.get(item.id) ?? '';
        const finalText = rawText.length > 0 ? rawText : buffered;
        if (!turn.itemHasTextDelta.has(item.id) && finalText.length > 0) {
          await this.emitValidated(turn.request, {
            type: 'item/delta',
            payload: {
              threadId: turn.request.threadId,
              turnId: turn.request.turnId,
              itemId: item.id,
              channel: 'text',
              delta: finalText,
            },
          });
        }
        summary.text = finalText;
        if (typeof record.phase === 'string') {
          summary.phase = record.phase;
        }
      } else if (item.type === 'commandExecution') {
        const outputText =
          typeof record.aggregatedOutput === 'string' ? record.aggregatedOutput : '';
        if (!turn.itemHasOutputDelta.has(item.id) && outputText.length > 0) {
          await this.emitValidated(turn.request, {
            type: 'item/delta',
            payload: {
              threadId: turn.request.threadId,
              turnId: turn.request.turnId,
              itemId: item.id,
              channel: 'stdout',
              delta: outputText,
            },
          });
        }
        summary.command = record.command;
        if (record.exitCode !== undefined && record.exitCode !== null) {
          summary.exitCode = record.exitCode;
        }
        if (outputText.length > 0) {
          summary.output = outputText;
        }
      } else {
        summary.rawType = item.type;
      }

      const status = mapCodexItemStatus(record.status);
      turn.startedItems.delete(item.id);
      await this.emitValidated(turn.request, {
        type: 'item/completed',
        payload: {
          threadId: turn.request.threadId,
          turnId: turn.request.turnId,
          itemId: item.id,
          status,
          ...(Object.keys(summary).length > 0 ? { summary } : {}),
        },
      });
      return;
    }

    if (notif.method === 'thread/tokenUsage/updated') {
      const parsed = CodexTokenUsageUpdatedNotificationSchema.parse(notif);
      const total = parsed.params.tokenUsage.total;
      turn.latestUsage = {
        billingType: 'subscription',
        backend: 'codex',
        inputTokens: Math.max(0, Math.trunc(total.inputTokens)),
        outputTokens: Math.max(0, Math.trunc(total.outputTokens)),
        ...(total.cachedInputTokens !== undefined
          ? { cachedInputTokens: Math.max(0, Math.trunc(total.cachedInputTokens)) }
          : {}),
        ...(total.reasoningOutputTokens !== undefined
          ? { reasoningTokens: Math.max(0, Math.trunc(total.reasoningOutputTokens)) }
          : {}),
        totalTokens: Math.max(0, Math.trunc(total.totalTokens)),
      };
      return;
    }

    if (notif.method === 'turn/completed') {
      const parsed = CodexTurnCompletedNotificationSchema.parse(notif);
      const rawStatus = parsed.params.turn.status;
      const status =
        rawStatus === 'completed'
          ? 'completed'
          : rawStatus === 'interrupted' || rawStatus === 'cancelled' || turn.interruptRequested
            ? 'interrupted'
            : 'failed';

      for (const openItemId of turn.startedItems.keys()) {
        await this.emitValidated(turn.request, {
          type: 'item/completed',
          payload: {
            threadId: turn.request.threadId,
            turnId: turn.request.turnId,
            itemId: openItemId,
            status: status === 'interrupted' ? 'cancelled' : 'failed',
          },
        });
      }
      turn.startedItems.clear();

      const errorPayload =
        status === 'failed'
          ? {
              code: NUH_ERROR_CODES.BACKEND_PROCESS_ERROR,
              message:
                typeof parsed.params.turn.error === 'string'
                  ? parsed.params.turn.error
                  : 'Codex turn failed',
            }
          : undefined;

      await this.emitValidated(turn.request, {
        type: 'turn/completed',
        payload: {
          threadId: turn.request.threadId,
          turnId: turn.request.turnId,
          status,
          ...(turn.latestUsage !== undefined ? { usage: turn.latestUsage } : {}),
          ...(errorPayload !== undefined ? { error: errorPayload } : {}),
        },
      });
      turn.settled = true;
      session.activeTurn = null;
      turn.resolve();
    }
  }

  private async handleServerRequest(
    session: CodexThreadSession,
    req: CodexServerRequest,
  ): Promise<void> {
    const turn = session.activeTurn;
    const proc = session.proc;
    if (!proc?.isAlive()) {
      return;
    }

    if (req.method === 'item/commandExecution/requestApproval') {
      const parsed = CodexCommandApprovalRequestSchema.parse(req);
      if (!turn || turn.settled) {
        proc.sendResponse(parsed.id, { decision: 'decline' });
        return;
      }
      const response = await turn.request.requestApproval({
        threadId: turn.request.threadId,
        turnId: turn.request.turnId,
        itemId: parsed.params.itemId,
        backend: 'codex',
        category: 'command_exec',
        title: parsed.params.command
          ? `Codex 请求执行命令: ${parsed.params.command}`
          : `Codex 请求执行命令 (${parsed.params.itemId})`,
        ...(parsed.params.command !== undefined ? { command: parsed.params.command } : {}),
        ...(parsed.params.cwd !== undefined ? { workdir: parsed.params.cwd } : {}),
        meta: {
          codexMethod: parsed.method,
          codexRequestId: parsed.id,
          ...(parsed.params.availableDecisions !== undefined
            ? { availableDecisions: parsed.params.availableDecisions }
            : {}),
        },
      });
      const decision = mapCodexDecision(response.decision, parsed.params.availableDecisions);
      if (proc.isAlive()) {
        proc.sendResponse(parsed.id, { decision });
      }
      return;
    }

    if (req.method === 'item/fileChange/requestApproval') {
      const parsed = CodexFileChangeApprovalRequestSchema.parse(req);
      if (!turn || turn.settled) {
        proc.sendResponse(parsed.id, { decision: 'decline' });
        return;
      }
      const response = await turn.request.requestApproval({
        threadId: turn.request.threadId,
        turnId: turn.request.turnId,
        itemId: parsed.params.itemId,
        backend: 'codex',
        category: 'file_change',
        title: `Codex 请求变更工作区文件 (${parsed.params.itemId})`,
        workdir: session.workdir,
        meta: {
          codexMethod: parsed.method,
          codexRequestId: parsed.id,
        },
      });
      const decision = mapCodexDecision(response.decision, undefined);
      if (proc.isAlive()) {
        proc.sendResponse(parsed.id, { decision });
      }
      return;
    }

    // Unsupported interactive server request: fail explicitly instead of hanging
    this.logger('warn', 'Unsupported Codex server request', {
      method: req.method,
      id: req.id,
    });
    if (turn && !turn.settled) {
      const response = await turn.request.requestApproval({
        threadId: turn.request.threadId,
        turnId: turn.request.turnId,
        backend: 'codex',
        category: 'permissions',
        title: `Codex 请求确认: ${req.method}`,
        meta: { codexMethod: req.method, codexRequestId: req.id, params: req.params },
      });
      if (proc.isAlive()) {
        proc.sendResponse(parsedId(req.id), {
          decision: response.decision === 'deny' ? 'decline' : 'accept',
        });
      }
    }
  }

  private async ensureSessionReady(
    session: CodexThreadSession,
    request: BackendTurnRequest,
  ): Promise<ManagedStdioJsonRpcProcess<CodexServerRequest, CodexNotification>> {
    if (session.proc?.isAlive() && session.codexThreadId) {
      return session.proc;
    }

    const resolved = this.resolveCommand();
    if (!resolved.available) {
      throw new NuhProtocolError(
        NUH_ERROR_CODES.BACKEND_UNAVAILABLE,
        resolved.reason ?? 'Codex backend unavailable',
        { backend: 'codex' },
      );
    }

    const mcpCliArgs = buildCodexMcpCliArgs(request.mcpServers ?? this.options.mcpServers);
    const proc = new ManagedStdioJsonRpcProcess<CodexServerRequest, CodexNotification>({
      source: 'codex-app-server',
      command: resolved.command,
      args: [...resolved.args, ...mcpCliArgs],
      cwd: session.workdir,
      ...(this.options.env ? { env: this.options.env } : {}),
      logger: this.logger,
      parseWireMessage: parseCodexWireMessage,
      onServerRequest: (req) => this.handleServerRequest(session, req),
      onNotification: (notif) => this.handleNotification(session, notif),
      onFatalError: (err) => {
        const turn = session.activeTurn;
        if (turn && !turn.settled) {
          turn.settled = true;
          session.activeTurn = null;
          turn.reject(err);
        }
      },
      onExit: ({ code, signal, expected }) => {
        if (session.proc === proc) {
          session.proc = null;
        }
        const turn = session.activeTurn;
        if (turn && !turn.settled) {
          turn.settled = true;
          session.activeTurn = null;
          if (expected || turn.interruptRequested || turn.request.signal.aborted) {
            void this.finishInterruptedTurn(turn);
          } else {
            turn.reject(
              new NuhProtocolError(
                NUH_ERROR_CODES.BACKEND_PROCESS_ERROR,
                `codex app-server 意外退出 (code=${String(code)}, signal=${String(signal)})`,
                { code, signal },
              ),
            );
          }
        }
      },
    });
    session.proc = proc;

    try {
      const initResultRaw = await this.sendCodexRequest(proc, 'initialize', {
        clientInfo: {
          name: 'nuh-daemon',
          title: 'NUH Daemon',
          version: '0.1.0',
        },
        capabilities: {
          experimentalApi: false,
          requestAttestation: false,
        },
      });
      parseExternalSchema(
        CodexInitializeResultSchema,
        initResultRaw,
        'Codex initialize 响应校验失败',
      );
      proc.sendNotification('initialized');

      const knownCodexThreadId = session.codexThreadId ?? request.backendSessionId;
      if (knownCodexThreadId) {
        const resumeRaw = await this.sendCodexRequest(proc, 'thread/resume', {
          threadId: knownCodexThreadId,
          cwd: session.workdir,
          approvalPolicy: session.approvalPolicy,
          sandbox: session.sandboxMode,
        });
        const resumeParsed = parseExternalSchema(
          CodexThreadStartResultSchema,
          resumeRaw,
          'Codex thread/resume 响应校验失败',
        );
        session.codexThreadId = resumeParsed.thread.id;
      } else {
        const startRaw = await this.sendCodexRequest(proc, 'thread/start', {
          cwd: session.workdir,
          approvalPolicy: session.approvalPolicy,
          sandbox: session.sandboxMode,
          ephemeral: false,
          ...(request.model !== undefined ? { model: request.model } : {}),
        });
        const startParsed = parseExternalSchema(
          CodexThreadStartResultSchema,
          startRaw,
          'Codex thread/start 响应校验失败',
        );
        session.codexThreadId = startParsed.thread.id;
      }

      request.onBackendSessionId?.(session.codexThreadId);
      return proc;
    } catch (cause) {
      await proc.dispose();
      session.proc = null;
      throw cause;
    }
  }

  private async finishInterruptedTurn(turn: ActiveCodexTurn): Promise<void> {
    for (const openItemId of turn.startedItems.keys()) {
      await this.emitValidated(turn.request, {
        type: 'item/completed',
        payload: {
          threadId: turn.request.threadId,
          turnId: turn.request.turnId,
          itemId: openItemId,
          status: 'cancelled',
        },
      });
    }
    turn.startedItems.clear();
    await this.emitValidated(turn.request, {
      type: 'turn/completed',
      payload: {
        threadId: turn.request.threadId,
        turnId: turn.request.turnId,
        status: 'interrupted',
      },
    });
    turn.resolve();
  }

  async runTurn(request: BackendTurnRequest): Promise<void> {
    let session = this.sessions.get(request.threadId);
    if (!session) {
      session = {
        threadId: request.threadId,
        workdir: request.workdir,
        approvalPolicy: request.approvalPolicy,
        sandboxMode: request.sandboxMode,
        proc: null,
        ...(request.backendSessionId !== undefined
          ? { codexThreadId: request.backendSessionId }
          : {}),
        activeTurn: null,
      };
      this.sessions.set(request.threadId, session);
    }

    const proc = await this.ensureSessionReady(session, request);
    const codexThreadId = session.codexThreadId;
    if (!codexThreadId) {
      throw new NuhProtocolError(
        NUH_ERROR_CODES.INTERNAL_ERROR,
        'Codex threadId 未在会话初始化后生成',
      );
    }

    await this.emitValidated(request, {
      type: 'turn/started',
      payload: {
        threadId: request.threadId,
        turnId: request.turnId,
        backend: 'codex',
      },
    });

    if (request.signal.aborted) {
      await this.emitValidated(request, {
        type: 'turn/completed',
        payload: {
          threadId: request.threadId,
          turnId: request.turnId,
          status: 'interrupted',
        },
      });
      return;
    }

    await new Promise<void>((resolve, reject) => {
      let interruptTimer: ReturnType<typeof setTimeout> | null = null;

      const cleanupListeners = (): void => {
        request.signal.removeEventListener('abort', onAbort);
        if (interruptTimer) {
          clearTimeout(interruptTimer);
          interruptTimer = null;
        }
      };

      const turnState: ActiveCodexTurn = {
        request,
        codexTurnId: null,
        startedItems: new Map(),
        itemHasTextDelta: new Set(),
        itemTextBuffer: new Map(),
        itemHasOutputDelta: new Set(),
        settled: false,
        interruptRequested: false,
        resolve: () => {
          cleanupListeners();
          resolve();
        },
        reject: (err) => {
          cleanupListeners();
          reject(err);
        },
      };

      const onAbort = (): void => {
        if (turnState.settled || turnState.interruptRequested) {
          return;
        }
        turnState.interruptRequested = true;
        if (proc.isAlive() && turnState.codexTurnId) {
          void this.sendCodexRequest(proc, 'turn/interrupt', {
            threadId: codexThreadId,
            turnId: turnState.codexTurnId,
          }).catch((err: unknown) => {
            this.logger('warn', 'Codex turn/interrupt failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
        interruptTimer = setTimeout(() => {
          if (!turnState.settled) {
            turnState.settled = true;
            session.activeTurn = null;
            void this.finishInterruptedTurn(turnState).catch(reject);
          }
        }, this.interruptGraceMs);
        interruptTimer.unref();
      };

      request.signal.addEventListener('abort', onAbort, { once: true });
      session.activeTurn = turnState;

      void this.sendCodexRequest(proc, 'turn/start', {
        threadId: codexThreadId,
        input: [{ type: 'text', text: request.prompt, text_elements: [] }],
        ...(request.model !== undefined ? { model: request.model } : {}),
      })
        .then((turnStartRaw) => {
          const turnStartParsed = parseExternalSchema(
            CodexTurnStartResultSchema,
            turnStartRaw,
            'Codex turn/start 响应校验失败',
          );
          turnState.codexTurnId = turnStartParsed.turn.id;
          if (turnState.interruptRequested && proc.isAlive()) {
            void this.sendCodexRequest(proc, 'turn/interrupt', {
              threadId: codexThreadId,
              turnId: turnStartParsed.turn.id,
            }).catch(() => undefined);
          }
        })
        .catch((err: unknown) => {
          if (!turnState.settled) {
            turnState.settled = true;
            session.activeTurn = null;
            const protoErr =
              err instanceof NuhProtocolError
                ? err
                : new NuhProtocolError(
                    NUH_ERROR_CODES.BACKEND_PROCESS_ERROR,
                    `Codex turn/start 失败: ${err instanceof Error ? err.message : String(err)}`,
                  );
            turnState.reject(protoErr);
          }
        });
    });
  }

  async closeThread(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) {
      return;
    }
    this.sessions.delete(threadId);
    if (session.proc) {
      await session.proc.dispose();
    }
  }

  async dispose(): Promise<void> {
    const closing = [...this.sessions.keys()].map((threadId) => this.closeThread(threadId));
    await Promise.all(closing);
  }
}

function parsedId(id: number | string): number | string {
  return id;
}
