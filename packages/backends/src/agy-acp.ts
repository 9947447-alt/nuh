import {
  AgyAcpInitializeResultSchema,
  type AgyAcpNotification,
  AgyAcpPermissionRequestSchema,
  AgyAcpPromptResultSchema,
  type AgyAcpServerRequest,
  AgyAcpSessionResultSchema,
  AgyAcpSessionUpdateNotificationSchema,
  AgyAcpSetConfigOptionParamsSchema,
  AgyAcpSetConfigOptionResultSchema,
  type ApprovalCategory,
  type ApprovalPolicy,
  type BackendStatus,
  buildAgyAcpPermissionResponse,
  type ItemCompletionStatus,
  type ItemKind,
  NUH_ERROR_CODES,
  type NuhNormalizedEvent,
  NuhNormalizedEventSchema,
  NuhProtocolError,
  type NuhUsage,
  parseAgyAcpWireMessage,
  type ThoughtLevel,
} from '@nuh/protocol';
import {
  ManagedStdioJsonRpcProcess,
  parseExternalSchema,
  resolveBackendCommand,
} from './stdio-rpc-client.ts';
import type {
  AgentBackend,
  BackendDiagnosticLogger,
  BackendMcpServerConfig,
  BackendSessionConfig,
  BackendTurnRequest,
} from './types.ts';

export interface AgyBackendOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: BackendDiagnosticLogger;
  readonly interruptGraceMs?: number;
  readonly mcpServers?: readonly BackendMcpServerConfig[];
}

export interface AgyAcpMcpServerEntry {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

/**
 * Formats dynamic stdio MCP server descriptors for AGY ACP `session/new` and
 * `session/resume` payloads.
 */
export function buildAgyMcpServersPayload(
  mcpServers?: readonly BackendMcpServerConfig[],
): AgyAcpMcpServerEntry[] {
  if (!mcpServers || mcpServers.length === 0) {
    return [];
  }
  return mcpServers.map((server) => ({
    name: server.name,
    command: server.command,
    args: [...server.args],
    env: Object.entries(server.env ?? {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, value]) => ({ name, value })),
  }));
}

interface ActiveTextItem {
  readonly itemId: string;
  readonly kind: 'agent_message' | 'reasoning';
}

interface ToolItemState {
  readonly itemId: string;
  readonly kind: ItemKind;
  started: boolean;
  completed: boolean;
  denied: boolean;
  name?: string;
  title?: string;
}

interface ActiveAgyTurn {
  readonly request: BackendTurnRequest;
  readonly sessionId: string;
  activeTextItem: ActiveTextItem | null;
  itemSeq: number;
  emittedAgentText: boolean;
  deniedToolCount: number;
  readonly toolItems: Map<string, ToolItemState>;
  settled: boolean;
  interruptRequested: boolean;
  readonly resolve: () => void;
  readonly reject: (err: Error) => void;
}

interface AgyThreadSession {
  readonly threadId: string;
  readonly workdir: string;
  readonly approvalPolicy: ApprovalPolicy;
  proc: ManagedStdioJsonRpcProcess<AgyAcpServerRequest, AgyAcpNotification> | null;
  acpSessionId?: string;
  appliedModel?: string;
  appliedThoughtLevel?: ThoughtLevel;
  appliedMode?: string;
  activeTurn: ActiveAgyTurn | null;
}

function noopLogger(): void {
  // default silent diagnostic logger
}

function mapAcpToolKind(kind: unknown): ItemKind {
  if (kind === 'execute') {
    return 'command_exec';
  }
  if (kind === 'edit' || kind === 'write') {
    return 'file_change';
  }
  return 'tool_call';
}

function mapAcpApprovalCategory(kind: unknown): ApprovalCategory {
  if (kind === 'execute') {
    return 'command_exec';
  }
  if (kind === 'edit' || kind === 'write') {
    return 'file_change';
  }
  return 'permissions';
}

function extractAcpCommand(toolCall: {
  readonly args?: Record<string, unknown>;
  readonly title?: string;
  readonly rawInput?: unknown;
}): string | undefined {
  if (toolCall.args && typeof toolCall.args.CommandLine === 'string') {
    return toolCall.args.CommandLine;
  }
  if (
    typeof toolCall.rawInput === 'object' &&
    toolCall.rawInput !== null &&
    !Array.isArray(toolCall.rawInput)
  ) {
    const rawCmd = (toolCall.rawInput as Record<string, unknown>).CommandLine;
    if (typeof rawCmd === 'string') {
      return rawCmd;
    }
  }
  return toolCall.title;
}

function extractRawOutputText(rawOutput: unknown): string {
  if (typeof rawOutput === 'string') {
    return rawOutput;
  }
  if (typeof rawOutput === 'object' && rawOutput !== null && !Array.isArray(rawOutput)) {
    const record = rawOutput as Record<string, unknown>;
    if (typeof record.output === 'string') {
      return record.output;
    }
  }
  return '';
}

function selectAcpOptionId(
  options: ReadonlyArray<{ readonly optionId: string; readonly kind: string }>,
  decision: 'allow_once' | 'allow_for_session' | 'deny',
): string {
  if (decision === 'deny') {
    const match = options.find((opt) => opt.optionId === 'deny' || opt.kind === 'reject_once');
    return match?.optionId ?? 'deny';
  }
  if (decision === 'allow_for_session') {
    const match = options.find(
      (opt) => opt.kind === 'allow_always' || opt.optionId === 'allow' || opt.kind === 'allow_once',
    );
    return match?.optionId ?? 'allow';
  }
  const match = options.find((opt) => opt.optionId === 'allow' || opt.kind === 'allow_once');
  return match?.optionId ?? 'allow';
}

/**
 * Antigravity ACP 后端适配器（单轨 `agy acp --stdio`，严禁降级到 `agy -p`）。
 * 严格对齐 Spike 04 实测结论：
 * - 兼容服务端字符串请求 ID（如 `"1"`）与混合命名扩展字段
 * - 接管 `session/request_permission` 双向审批，并在 `deny` 无回复文本时补齐拒绝反馈
 * - 支持 `session/new`、`session/resume` 与 `session/set_config_option`（模型/思考强度切换）
 */
export class AgyAcpBackend implements AgentBackend {
  readonly kind = 'agy' as const;
  private readonly options: AgyBackendOptions;
  private readonly logger: BackendDiagnosticLogger;
  private readonly interruptGraceMs: number;
  private readonly sessions = new Map<string, AgyThreadSession>();

  constructor(options: AgyBackendOptions = {}) {
    this.options = options;
    this.logger = options.logger ?? noopLogger;
    this.interruptGraceMs = options.interruptGraceMs ?? 1500;
  }

  private resolveCommand() {
    return resolveBackendCommand({
      ...(this.options.command !== undefined ? { explicitCommand: this.options.command } : {}),
      ...(this.options.args !== undefined ? { explicitArgs: this.options.args } : {}),
      envBinVar: 'NUH_AGY_BIN',
      envArgsVar: 'NUH_AGY_ARGS',
      defaultCommand: 'agy',
      defaultArgs: ['acp', '--stdio'],
    });
  }

  async getStatus(): Promise<BackendStatus> {
    const resolved = this.resolveCommand();
    if (!resolved.available) {
      return {
        kind: 'agy',
        available: false,
        authenticated: false,
        ...(resolved.reason !== undefined ? { reason: resolved.reason } : {}),
      };
    }
    return {
      kind: 'agy',
      available: true,
      authenticated: true,
      reason: resolved.overridden ? 'configured agy acp binary ready' : 'agy acp --stdio ready',
    };
  }

  private async emitValidated(
    request: BackendTurnRequest,
    event: NuhNormalizedEvent,
  ): Promise<void> {
    const validated = NuhNormalizedEventSchema.parse(event);
    await request.emit(validated);
  }

  private async closeActiveTextItem(
    turn: ActiveAgyTurn,
    status: ItemCompletionStatus = 'ok',
  ): Promise<void> {
    const active = turn.activeTextItem;
    if (!active) {
      return;
    }
    turn.activeTextItem = null;
    await this.emitValidated(turn.request, {
      type: 'item/completed',
      payload: {
        threadId: turn.request.threadId,
        turnId: turn.request.turnId,
        itemId: active.itemId,
        status,
      },
    });
  }

  private async ensureTextItem(
    turn: ActiveAgyTurn,
    kind: 'agent_message' | 'reasoning',
  ): Promise<string> {
    if (turn.activeTextItem?.kind === kind) {
      return turn.activeTextItem.itemId;
    }
    await this.closeActiveTextItem(turn, 'ok');
    turn.itemSeq += 1;
    const itemId = `agy_${kind === 'agent_message' ? 'msg' : 'think'}_${turn.request.turnId}_${String(turn.itemSeq)}`;
    turn.activeTextItem = { itemId, kind };
    await this.emitValidated(turn.request, {
      type: 'item/started',
      payload: {
        threadId: turn.request.threadId,
        turnId: turn.request.turnId,
        itemId,
        kind,
      },
    });
    return itemId;
  }

  private async handleNotification(
    session: AgyThreadSession,
    notif: AgyAcpNotification,
  ): Promise<void> {
    const turn = session.activeTurn;
    if (!turn || turn.settled || notif.method !== 'session/update') {
      return;
    }
    const parsed = AgyAcpSessionUpdateNotificationSchema.parse(notif);
    const update = parsed.params.update;

    if (update.sessionUpdate === 'agent_message_chunk') {
      const content = update.content as { readonly type: 'text'; readonly text: string };
      const itemId = await this.ensureTextItem(turn, 'agent_message');
      if (content.text.length > 0) {
        turn.emittedAgentText = true;
      }
      await this.emitValidated(turn.request, {
        type: 'item/delta',
        payload: {
          threadId: turn.request.threadId,
          turnId: turn.request.turnId,
          itemId,
          channel: 'text',
          delta: content.text,
        },
      });
      return;
    }

    if (update.sessionUpdate === 'agent_thought_chunk') {
      const content = update.content as { readonly type: 'text'; readonly text: string };
      const itemId = await this.ensureTextItem(turn, 'reasoning');
      await this.emitValidated(turn.request, {
        type: 'item/delta',
        payload: {
          threadId: turn.request.threadId,
          turnId: turn.request.turnId,
          itemId,
          channel: 'thinking',
          delta: content.text,
        },
      });
      return;
    }

    if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      await this.closeActiveTextItem(turn, 'ok');
      const toolUpdate = update as {
        readonly sessionUpdate: 'tool_call' | 'tool_call_update';
        readonly toolCallId: string;
        readonly name?: string;
        readonly status: string;
        readonly kind?: string;
        readonly title?: string;
        readonly rawInput?: unknown;
        readonly rawOutput?: unknown;
      };

      let toolState = turn.toolItems.get(toolUpdate.toolCallId);
      if (!toolState) {
        toolState = {
          itemId: toolUpdate.toolCallId,
          kind: mapAcpToolKind(toolUpdate.kind),
          started: false,
          completed: false,
          denied: false,
          ...(toolUpdate.name !== undefined ? { name: toolUpdate.name } : {}),
          ...(toolUpdate.title !== undefined ? { title: toolUpdate.title } : {}),
        };
        turn.toolItems.set(toolUpdate.toolCallId, toolState);
      } else {
        if (toolUpdate.name !== undefined) {
          toolState.name = toolUpdate.name;
        }
        if (toolUpdate.title !== undefined) {
          toolState.title = toolUpdate.title;
        }
      }

      if (!toolState.started) {
        toolState.started = true;
        await this.emitValidated(turn.request, {
          type: 'item/started',
          payload: {
            threadId: turn.request.threadId,
            turnId: turn.request.turnId,
            itemId: toolState.itemId,
            kind: toolState.kind,
            meta: {
              ...(toolState.name !== undefined ? { name: toolState.name } : {}),
              ...(toolState.title !== undefined ? { title: toolState.title } : {}),
              ...(toolUpdate.rawInput !== undefined ? { rawInput: toolUpdate.rawInput } : {}),
            },
          },
        });
      }

      if (
        !toolState.completed &&
        (toolUpdate.status === 'completed' ||
          toolUpdate.status === 'failed' ||
          toolUpdate.status === 'cancelled')
      ) {
        toolState.completed = true;
        const rawOutputText = extractRawOutputText(toolUpdate.rawOutput);
        if (rawOutputText.length > 0 && toolUpdate.status === 'completed') {
          await this.emitValidated(turn.request, {
            type: 'item/delta',
            payload: {
              threadId: turn.request.threadId,
              turnId: turn.request.turnId,
              itemId: toolState.itemId,
              channel: toolState.kind === 'command_exec' ? 'stdout' : 'text',
              delta: rawOutputText,
            },
          });
        }

        const completionStatus: ItemCompletionStatus =
          toolUpdate.status === 'completed'
            ? 'ok'
            : toolState.denied
              ? 'denied'
              : toolUpdate.status === 'cancelled'
                ? 'cancelled'
                : 'failed';

        await this.emitValidated(turn.request, {
          type: 'item/completed',
          payload: {
            threadId: turn.request.threadId,
            turnId: turn.request.turnId,
            itemId: toolState.itemId,
            status: completionStatus,
            summary: {
              ...(toolState.name !== undefined ? { name: toolState.name } : {}),
              ...(toolState.title !== undefined ? { title: toolState.title } : {}),
              ...(toolState.denied ? { denied: true, reason: 'Permission denied by user' } : {}),
              ...(rawOutputText.length > 0 ? { output: rawOutputText } : {}),
            },
          },
        });
      }
    }
  }

  private async handleServerRequest(
    session: AgyThreadSession,
    req: AgyAcpServerRequest,
  ): Promise<void> {
    const turn = session.activeTurn;
    const proc = session.proc;
    if (!proc?.isAlive()) {
      return;
    }

    if (req.method === 'session/request_permission') {
      const parsed = AgyAcpPermissionRequestSchema.parse(req);
      if (!turn || turn.settled) {
        proc.sendRaw(buildAgyAcpPermissionResponse(parsed.id, 'deny'));
        return;
      }

      const toolCall = parsed.params.toolCall;
      let toolState = turn.toolItems.get(toolCall.toolCallId);
      if (!toolState) {
        toolState = {
          itemId: toolCall.toolCallId,
          kind: mapAcpToolKind(toolCall.kind),
          started: true,
          completed: false,
          denied: false,
          ...(toolCall.name !== undefined ? { name: toolCall.name } : {}),
          ...(toolCall.title !== undefined ? { title: toolCall.title } : {}),
        };
        turn.toolItems.set(toolCall.toolCallId, toolState);
        await this.emitValidated(turn.request, {
          type: 'item/started',
          payload: {
            threadId: turn.request.threadId,
            turnId: turn.request.turnId,
            itemId: toolState.itemId,
            kind: toolState.kind,
          },
        });
      }

      const command = extractAcpCommand(toolCall);
      const response = await turn.request.requestApproval({
        threadId: turn.request.threadId,
        turnId: turn.request.turnId,
        itemId: toolCall.toolCallId,
        backend: 'agy',
        category: mapAcpApprovalCategory(toolCall.kind),
        title: toolCall.title ?? toolCall.name ?? 'AGY 请求执行受控工具',
        ...(command !== undefined ? { command } : {}),
        workdir: session.workdir,
        meta: {
          acpRequestId: parsed.id,
          ...(toolCall.name !== undefined ? { toolName: toolCall.name } : {}),
          options: parsed.params.options,
        },
      });

      if (response.decision === 'deny') {
        toolState.denied = true;
        turn.deniedToolCount += 1;
      }
      const optionId = selectAcpOptionId(parsed.params.options, response.decision);
      if (proc.isAlive()) {
        proc.sendRaw(buildAgyAcpPermissionResponse(parsed.id, optionId));
      }
      return;
    }

    this.logger('warn', 'Unsupported AGY ACP server request', {
      method: req.method,
      id: req.id,
    });
    if (proc.isAlive()) {
      proc.sendRaw({
        jsonrpc: '2.0',
        id: req.id,
        error: {
          code: NUH_ERROR_CODES.METHOD_NOT_FOUND,
          message: `Unsupported ACP client method: ${req.method}`,
        },
      });
    }
  }

  private async setConfigOption(
    proc: ManagedStdioJsonRpcProcess<AgyAcpServerRequest, AgyAcpNotification>,
    sessionId: string,
    configId: string,
    value: string,
  ): Promise<void> {
    const params = parseExternalSchema(
      AgyAcpSetConfigOptionParamsSchema,
      { sessionId, configId, value },
      'AGY ACP session/set_config_option 参数校验失败',
    );
    const resultRaw = await proc.sendRequest('session/set_config_option', params);
    parseExternalSchema(
      AgyAcpSetConfigOptionResultSchema,
      resultRaw,
      'AGY ACP session/set_config_option 响应校验失败',
    );
  }

  private async applySessionConfig(
    session: AgyThreadSession,
    proc: ManagedStdioJsonRpcProcess<AgyAcpServerRequest, AgyAcpNotification>,
    sessionId: string,
    config: BackendSessionConfig & { readonly approvalPolicy?: ApprovalPolicy },
  ): Promise<void> {
    if (config.model !== undefined && config.model !== session.appliedModel) {
      await this.setConfigOption(proc, sessionId, 'model', config.model);
      session.appliedModel = config.model;
    }
    if (config.thoughtLevel !== undefined && config.thoughtLevel !== session.appliedThoughtLevel) {
      await this.setConfigOption(proc, sessionId, 'thought_level', config.thoughtLevel);
      session.appliedThoughtLevel = config.thoughtLevel;
    }
    if (config.approvalPolicy !== undefined) {
      const targetMode = config.approvalPolicy === 'never' ? 'auto' : 'default';
      if (targetMode !== session.appliedMode && targetMode !== 'default') {
        await this.setConfigOption(proc, sessionId, 'mode', targetMode);
        session.appliedMode = targetMode;
      } else if (session.appliedMode === undefined) {
        session.appliedMode = 'default';
      }
    }
  }

  private async ensureSessionReady(
    session: AgyThreadSession,
    request: BackendTurnRequest,
  ): Promise<ManagedStdioJsonRpcProcess<AgyAcpServerRequest, AgyAcpNotification>> {
    if (session.proc?.isAlive() && session.acpSessionId) {
      await this.applySessionConfig(session, session.proc, session.acpSessionId, {
        ...(request.model !== undefined ? { model: request.model } : {}),
        ...(request.thoughtLevel !== undefined ? { thoughtLevel: request.thoughtLevel } : {}),
        approvalPolicy: request.approvalPolicy,
      });
      return session.proc;
    }

    const resolved = this.resolveCommand();
    if (!resolved.available) {
      throw new NuhProtocolError(
        NUH_ERROR_CODES.BACKEND_UNAVAILABLE,
        resolved.reason ?? 'AGY ACP backend unavailable',
        { backend: 'agy' },
      );
    }

    const proc = new ManagedStdioJsonRpcProcess<AgyAcpServerRequest, AgyAcpNotification>({
      source: 'agy-acp',
      command: resolved.command,
      args: resolved.args,
      cwd: session.workdir,
      ...(this.options.env ? { env: this.options.env } : {}),
      logger: this.logger,
      parseWireMessage: parseAgyAcpWireMessage,
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
                `agy acp --stdio 意外退出 (code=${String(code)}, signal=${String(signal)})`,
                { code, signal },
              ),
            );
          }
        }
      },
    });
    session.proc = proc;

    try {
      const initRaw = await proc.sendRequest('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: {
          name: 'nuh-daemon',
          version: '0.1.0',
        },
      });
      parseExternalSchema(AgyAcpInitializeResultSchema, initRaw, 'AGY ACP initialize 响应校验失败');

      const mcpServers = buildAgyMcpServersPayload(request.mcpServers ?? this.options.mcpServers);
      const knownSessionId = session.acpSessionId ?? request.backendSessionId;
      if (knownSessionId) {
        const resumeRaw = await proc.sendRequest('session/resume', {
          sessionId: knownSessionId,
          cwd: session.workdir,
          mcpServers,
        });
        const resumeParsed = parseExternalSchema(
          AgyAcpSessionResultSchema,
          resumeRaw,
          'AGY ACP session/resume 响应校验失败',
        );
        session.acpSessionId = resumeParsed.sessionId;
      } else {
        const newRaw = await proc.sendRequest('session/new', {
          cwd: session.workdir,
          mcpServers,
        });
        const newParsed = parseExternalSchema(
          AgyAcpSessionResultSchema,
          newRaw,
          'AGY ACP session/new 响应校验失败',
        );
        session.acpSessionId = newParsed.sessionId;
      }

      request.onBackendSessionId?.(session.acpSessionId);

      await this.applySessionConfig(session, proc, session.acpSessionId, {
        ...(request.model !== undefined ? { model: request.model } : {}),
        ...(request.thoughtLevel !== undefined ? { thoughtLevel: request.thoughtLevel } : {}),
        approvalPolicy: request.approvalPolicy,
      });

      return proc;
    } catch (cause) {
      await proc.dispose();
      session.proc = null;
      throw cause;
    }
  }

  private async finishInterruptedTurn(turn: ActiveAgyTurn): Promise<void> {
    await this.closeActiveTextItem(turn, 'cancelled');
    for (const tool of turn.toolItems.values()) {
      if (tool.started && !tool.completed) {
        tool.completed = true;
        await this.emitValidated(turn.request, {
          type: 'item/completed',
          payload: {
            threadId: turn.request.threadId,
            turnId: turn.request.turnId,
            itemId: tool.itemId,
            status: tool.denied ? 'denied' : 'cancelled',
          },
        });
      }
    }
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

  async configureSession(threadId: string, config: BackendSessionConfig): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session?.proc?.isAlive() || !session.acpSessionId) {
      return;
    }
    await this.applySessionConfig(session, session.proc, session.acpSessionId, config);
  }

  async runTurn(request: BackendTurnRequest): Promise<void> {
    let session = this.sessions.get(request.threadId);
    if (!session) {
      session = {
        threadId: request.threadId,
        workdir: request.workdir,
        approvalPolicy: request.approvalPolicy,
        proc: null,
        ...(request.backendSessionId !== undefined
          ? { acpSessionId: request.backendSessionId }
          : {}),
        activeTurn: null,
      };
      this.sessions.set(request.threadId, session);
    }

    const proc = await this.ensureSessionReady(session, request);
    const acpSessionId = session.acpSessionId;
    if (!acpSessionId) {
      throw new NuhProtocolError(
        NUH_ERROR_CODES.INTERNAL_ERROR,
        'AGY ACP sessionId 未在会话初始化后生成',
      );
    }

    await this.emitValidated(request, {
      type: 'turn/started',
      payload: {
        threadId: request.threadId,
        turnId: request.turnId,
        backend: 'agy',
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

      const turnState: ActiveAgyTurn = {
        request,
        sessionId: acpSessionId,
        activeTextItem: null,
        itemSeq: 0,
        emittedAgentText: false,
        deniedToolCount: 0,
        toolItems: new Map(),
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
        if (proc.isAlive()) {
          try {
            proc.sendNotification('session/cancel', { sessionId: acpSessionId });
          } catch (err: unknown) {
            this.logger('warn', 'AGY ACP session/cancel failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
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

      void proc
        .sendRequest('session/prompt', {
          sessionId: acpSessionId,
          prompt: [{ type: 'text', text: request.prompt }],
        })
        .then(async (promptRaw) => {
          await proc.flushEvents();
          if (turnState.settled) {
            return;
          }
          const promptRes = parseExternalSchema(
            AgyAcpPromptResultSchema,
            promptRaw,
            'AGY ACP session/prompt 响应校验失败',
          );
          const cancelled =
            promptRes.stopReason === 'cancelled' ||
            turnState.interruptRequested ||
            request.signal.aborted;

          if (cancelled) {
            turnState.settled = true;
            session.activeTurn = null;
            await this.finishInterruptedTurn(turnState);
            return;
          }

          await this.closeActiveTextItem(turnState, 'ok');
          for (const tool of turnState.toolItems.values()) {
            if (tool.started && !tool.completed) {
              tool.completed = true;
              await this.emitValidated(request, {
                type: 'item/completed',
                payload: {
                  threadId: request.threadId,
                  turnId: request.turnId,
                  itemId: tool.itemId,
                  status: tool.denied ? 'denied' : 'failed',
                },
              });
            }
          }

          // Spike 04 实测约束：deny 后若模型未输出补充文本，归一化层须输出明确的拒绝反馈
          if (turnState.deniedToolCount > 0 && !turnState.emittedAgentText) {
            const feedbackItemId = await this.ensureTextItem(turnState, 'agent_message');
            const denialNotice = '[permission denied] 工具执行请求已被用户拒绝。';
            await this.emitValidated(request, {
              type: 'item/delta',
              payload: {
                threadId: request.threadId,
                turnId: request.turnId,
                itemId: feedbackItemId,
                channel: 'text',
                delta: denialNotice,
              },
            });
            await this.closeActiveTextItem(turnState, 'ok');
          }

          const usage: NuhUsage | undefined = promptRes.usage
            ? {
                billingType: 'oauth',
                backend: 'agy',
                inputTokens: promptRes.usage.inputTokens,
                outputTokens: promptRes.usage.outputTokens,
                ...(promptRes.usage.cachedReadTokens !== undefined
                  ? { cachedInputTokens: promptRes.usage.cachedReadTokens }
                  : {}),
                ...(promptRes.usage.thoughtTokens !== undefined
                  ? { reasoningTokens: promptRes.usage.thoughtTokens }
                  : {}),
                ...(promptRes.usage.totalTokens !== undefined
                  ? { totalTokens: promptRes.usage.totalTokens }
                  : {}),
              }
            : undefined;

          const turnStatus = promptRes.stopReason === 'error' ? 'failed' : 'completed';
          await this.emitValidated(request, {
            type: 'turn/completed',
            payload: {
              threadId: request.threadId,
              turnId: request.turnId,
              status: turnStatus,
              ...(usage !== undefined ? { usage } : {}),
            },
          });

          turnState.settled = true;
          session.activeTurn = null;
          turnState.resolve();
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
                    `AGY ACP session/prompt 失败: ${err instanceof Error ? err.message : String(err)}`,
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
