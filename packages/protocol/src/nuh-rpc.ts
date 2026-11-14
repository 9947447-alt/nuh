import { z } from 'zod';
import { formatZodValidationError, NUH_ERROR_CODES, NuhProtocolError } from './errors.ts';
import { classifyJsonRpcMessage, JsonRpcIdSchema } from './jsonrpc.ts';

export const NUH_PROTOCOL_VERSION = '0.1' as const;

export const BackendKindSchema = z.enum(['native-dsh', 'codex', 'claude', 'agy']);
export type BackendKind = z.infer<typeof BackendKindSchema>;

export const SandboxModeSchema = z.enum(['read-only', 'workspace-write', 'danger-full-access']);
export type SandboxMode = z.infer<typeof SandboxModeSchema>;

export const ApprovalPolicySchema = z.enum(['untrusted', 'on-request', 'never']);
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;

export const ItemKindSchema = z.enum([
  'agent_message',
  'reasoning',
  'tool_call',
  'command_exec',
  'file_change',
  'delegation',
]);
export type ItemKind = z.infer<typeof ItemKindSchema>;

export const ItemDeltaChannelSchema = z.enum(['text', 'thinking', 'stdout', 'stderr', 'diff']);
export type ItemDeltaChannel = z.infer<typeof ItemDeltaChannelSchema>;

export const ItemCompletionStatusSchema = z.enum(['ok', 'failed', 'denied', 'cancelled']);
export type ItemCompletionStatus = z.infer<typeof ItemCompletionStatusSchema>;

export const TurnCompletionStatusSchema = z.enum(['completed', 'failed', 'interrupted']);
export type TurnCompletionStatus = z.infer<typeof TurnCompletionStatusSchema>;

export const ApprovalDecisionSchema = z.enum(['allow_once', 'allow_for_session', 'deny']);
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ApprovalCategorySchema = z.enum([
  'command_exec',
  'file_change',
  'permissions',
  'mcp_tool',
  'user_input',
]);
export type ApprovalCategory = z.infer<typeof ApprovalCategorySchema>;

export const BillingTypeSchema = z.enum(['api', 'subscription', 'oauth']);
export type BillingType = z.infer<typeof BillingTypeSchema>;

export const NuhUsageSchema = z.object({
  billingType: BillingTypeSchema.optional(),
  backend: BackendKindSchema,
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
});
export type NuhUsage = z.infer<typeof NuhUsageSchema>;

// ---------------------------------------------------------------------------
// Client -> Daemon Requests & Results
// ---------------------------------------------------------------------------

export const InitializeParamsSchema = z.object({
  clientInfo: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
  }),
  protocolVersion: z.string().min(1),
});
export type InitializeParams = z.infer<typeof InitializeParamsSchema>;

export const BackendStatusSchema = z.object({
  kind: BackendKindSchema,
  available: z.boolean(),
  authenticated: z.boolean(),
  version: z.string().optional(),
  reason: z.string().optional(),
});
export type BackendStatus = z.infer<typeof BackendStatusSchema>;

export const InitializeResultSchema = z.object({
  serverInfo: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
  }),
  protocolVersion: z.string().min(1),
  backends: z.array(BackendStatusSchema),
  loadedDshPlugins: z.array(z.string()),
});
export type InitializeResult = z.infer<typeof InitializeResultSchema>;

export const ThreadStartParamsSchema = z.object({
  workdir: z.string().min(1),
  defaultBackend: BackendKindSchema.default('native-dsh'),
  model: z.string().min(1).optional(),
  sandboxMode: SandboxModeSchema.default('workspace-write'),
  approvalPolicy: ApprovalPolicySchema.default('on-request'),
});
export type ThreadStartParams = z.infer<typeof ThreadStartParamsSchema>;

export const ThreadStartResultSchema = z.object({
  threadId: z.string().min(1),
  createdAt: z.string().min(1),
});
export type ThreadStartResult = z.infer<typeof ThreadStartResultSchema>;

export const LedgerSummaryEntrySchema = z.object({
  role: z.enum(['user', 'assistant', 'tool']),
  backend: BackendKindSchema,
  summary: z.string(),
  timestamp: z.string().min(1),
});
export type LedgerSummaryEntry = z.infer<typeof LedgerSummaryEntrySchema>;

export const ThreadResumeParamsSchema = z.object({
  threadId: z.string().min(1),
  workdir: z.string().min(1).optional(),
});
export type ThreadResumeParams = z.infer<typeof ThreadResumeParamsSchema>;

export const ThreadResumeResultSchema = z.object({
  threadId: z.string().min(1),
  activeBackend: BackendKindSchema,
  ledgerSummary: z.array(LedgerSummaryEntrySchema),
});
export type ThreadResumeResult = z.infer<typeof ThreadResumeResultSchema>;

export const ThreadListParamsSchema = z.object({
  workdir: z.string().min(1).optional(),
});
export type ThreadListParams = z.infer<typeof ThreadListParamsSchema>;

export const ThreadSummarySchema = z.object({
  threadId: z.string().min(1),
  workdir: z.string().min(1),
  activeBackend: BackendKindSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type ThreadSummary = z.infer<typeof ThreadSummarySchema>;

export const ThreadListResultSchema = z.object({
  threads: z.array(ThreadSummarySchema),
});
export type ThreadListResult = z.infer<typeof ThreadListResultSchema>;

export const ThoughtLevelSchema = z.enum(['low', 'medium', 'high']);
export type ThoughtLevel = z.infer<typeof ThoughtLevelSchema>;

export const ThreadSetBackendParamsSchema = z.object({
  threadId: z.string().min(1),
  backend: BackendKindSchema,
  model: z.string().min(1).optional(),
  thoughtLevel: ThoughtLevelSchema.optional(),
});
export type ThreadSetBackendParams = z.infer<typeof ThreadSetBackendParamsSchema>;

export const ThreadSetBackendResultSchema = z.object({
  threadId: z.string().min(1),
  backend: BackendKindSchema,
  model: z.string().min(1).optional(),
  thoughtLevel: ThoughtLevelSchema.optional(),
});
export type ThreadSetBackendResult = z.infer<typeof ThreadSetBackendResultSchema>;

export const TurnStartParamsSchema = z.object({
  threadId: z.string().min(1),
  input: z.string().min(1),
  backendOverride: BackendKindSchema.nullable().optional(),
  modelOverride: z.string().min(1).nullable().optional(),
  worktree: z.boolean().default(false),
});
export type TurnStartParams = z.infer<typeof TurnStartParamsSchema>;

export const TurnStartResultSchema = z.object({
  turnId: z.string().min(1),
  resolvedBackend: BackendKindSchema,
});
export type TurnStartResult = z.infer<typeof TurnStartResultSchema>;

export const TurnInterruptParamsSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
});
export type TurnInterruptParams = z.infer<typeof TurnInterruptParamsSchema>;

export const TurnInterruptResultSchema = z.object({
  interrupted: z.boolean(),
});
export type TurnInterruptResult = z.infer<typeof TurnInterruptResultSchema>;

export const NuhClientRequestSchema = z.discriminatedUnion('method', [
  z.object({
    jsonrpc: z.literal('2.0'),
    id: JsonRpcIdSchema,
    method: z.literal('initialize'),
    params: InitializeParamsSchema,
  }),
  z.object({
    jsonrpc: z.literal('2.0'),
    id: JsonRpcIdSchema,
    method: z.literal('thread/start'),
    params: ThreadStartParamsSchema,
  }),
  z.object({
    jsonrpc: z.literal('2.0'),
    id: JsonRpcIdSchema,
    method: z.literal('thread/resume'),
    params: ThreadResumeParamsSchema,
  }),
  z.object({
    jsonrpc: z.literal('2.0'),
    id: JsonRpcIdSchema,
    method: z.literal('thread/list'),
    params: ThreadListParamsSchema,
  }),
  z.object({
    jsonrpc: z.literal('2.0'),
    id: JsonRpcIdSchema,
    method: z.literal('thread/setBackend'),
    params: ThreadSetBackendParamsSchema,
  }),
  z.object({
    jsonrpc: z.literal('2.0'),
    id: JsonRpcIdSchema,
    method: z.literal('turn/start'),
    params: TurnStartParamsSchema,
  }),
  z.object({
    jsonrpc: z.literal('2.0'),
    id: JsonRpcIdSchema,
    method: z.literal('turn/interrupt'),
    params: TurnInterruptParamsSchema,
  }),
]);
export type NuhClientRequest = z.infer<typeof NuhClientRequestSchema>;

export const InitializedParamsSchema = z.object({}).passthrough().optional();
export type InitializedParams = z.infer<typeof InitializedParamsSchema>;

export const NuhClientNotificationSchema = z.discriminatedUnion('method', [
  z.object({
    jsonrpc: z.literal('2.0'),
    method: z.literal('initialized'),
    params: InitializedParamsSchema,
  }),
]);
export type NuhClientNotification = z.infer<typeof NuhClientNotificationSchema>;

// ---------------------------------------------------------------------------
// Daemon -> Client Server-Initiated Requests (Approval)
// ---------------------------------------------------------------------------

export const ApprovalRequestedParamsSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  itemId: z.string().min(1).optional(),
  backend: BackendKindSchema,
  category: ApprovalCategorySchema,
  title: z.string().min(1),
  command: z.string().optional(),
  workdir: z.string().optional(),
  reason: z.string().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type ApprovalRequestedParams = z.infer<typeof ApprovalRequestedParamsSchema>;

export const ApprovalRequestedResultSchema = z.object({
  decision: ApprovalDecisionSchema,
  note: z.string().nullable().optional(),
});
export type ApprovalRequestedResult = z.infer<typeof ApprovalRequestedResultSchema>;

export const NuhServerRequestSchema = z.discriminatedUnion('method', [
  z.object({
    jsonrpc: z.literal('2.0'),
    id: JsonRpcIdSchema,
    method: z.literal('approval/requested'),
    params: ApprovalRequestedParamsSchema,
  }),
]);
export type NuhServerRequest = z.infer<typeof NuhServerRequestSchema>;

// ---------------------------------------------------------------------------
// Daemon -> Client Notifications & Normalized Internal Events
// ---------------------------------------------------------------------------

export const TurnStartedParamsSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  backend: BackendKindSchema,
});
export type TurnStartedParams = z.infer<typeof TurnStartedParamsSchema>;

export const ItemStartedParamsSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  itemId: z.string().min(1),
  kind: ItemKindSchema,
  meta: z.record(z.string(), z.unknown()).optional(),
});
export type ItemStartedParams = z.infer<typeof ItemStartedParamsSchema>;

export const ItemDeltaParamsSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  itemId: z.string().min(1),
  channel: ItemDeltaChannelSchema,
  delta: z.string(),
});
export type ItemDeltaParams = z.infer<typeof ItemDeltaParamsSchema>;

export const ItemCompletedParamsSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  itemId: z.string().min(1),
  status: ItemCompletionStatusSchema,
  summary: z.record(z.string(), z.unknown()).optional(),
});
export type ItemCompletedParams = z.infer<typeof ItemCompletedParamsSchema>;

export const TurnCompletedParamsSchema = z.object({
  threadId: z.string().min(1),
  turnId: z.string().min(1),
  status: TurnCompletionStatusSchema,
  usage: NuhUsageSchema.optional(),
  error: z
    .object({
      code: z.number().int(),
      message: z.string(),
    })
    .optional(),
});
export type TurnCompletedParams = z.infer<typeof TurnCompletedParamsSchema>;

export const NuhNotificationSchema = z.discriminatedUnion('method', [
  z.object({
    jsonrpc: z.literal('2.0'),
    method: z.literal('turn/started'),
    params: TurnStartedParamsSchema,
  }),
  z.object({
    jsonrpc: z.literal('2.0'),
    method: z.literal('item/started'),
    params: ItemStartedParamsSchema,
  }),
  z.object({
    jsonrpc: z.literal('2.0'),
    method: z.literal('item/delta'),
    params: ItemDeltaParamsSchema,
  }),
  z.object({
    jsonrpc: z.literal('2.0'),
    method: z.literal('item/completed'),
    params: ItemCompletedParamsSchema,
  }),
  z.object({
    jsonrpc: z.literal('2.0'),
    method: z.literal('turn/completed'),
    params: TurnCompletedParamsSchema,
  }),
]);
export type NuhNotification = z.infer<typeof NuhNotificationSchema>;

/**
 * NUH 内部归一化事件契约：所有后端适配器（native-dsh / codex / claude / agy）
 * 必须将各自私有流式输出转换为此结构，严禁向核心调度层泄漏底层 CLI 原始格式。
 */
export const NuhNormalizedEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('turn/started'),
    payload: TurnStartedParamsSchema,
  }),
  z.object({
    type: z.literal('item/started'),
    payload: ItemStartedParamsSchema,
  }),
  z.object({
    type: z.literal('item/delta'),
    payload: ItemDeltaParamsSchema,
  }),
  z.object({
    type: z.literal('item/completed'),
    payload: ItemCompletedParamsSchema,
  }),
  z.object({
    type: z.literal('turn/completed'),
    payload: TurnCompletedParamsSchema,
  }),
]);
export type NuhNormalizedEvent = z.infer<typeof NuhNormalizedEventSchema>;

/**
 * 将规范内部事件封装为对外 JSON-RPC 2.0 Notification。
 */
export function toNuhNotification(event: NuhNormalizedEvent): NuhNotification {
  switch (event.type) {
    case 'turn/started':
      return { jsonrpc: '2.0', method: 'turn/started', params: event.payload };
    case 'item/started':
      return { jsonrpc: '2.0', method: 'item/started', params: event.payload };
    case 'item/delta':
      return { jsonrpc: '2.0', method: 'item/delta', params: event.payload };
    case 'item/completed':
      return { jsonrpc: '2.0', method: 'item/completed', params: event.payload };
    case 'turn/completed':
      return { jsonrpc: '2.0', method: 'turn/completed', params: event.payload };
  }
}

const KNOWN_CLIENT_METHODS = new Set([
  'initialize',
  'thread/start',
  'thread/resume',
  'thread/list',
  'thread/setBackend',
  'turn/start',
  'turn/interrupt',
]);

const KNOWN_CLIENT_NOTIFICATION_METHODS = new Set(['initialized']);

/**
 * 严格校验 Client -> Daemon 请求帧（强制 `"jsonrpc": "2.0"`，未知方法抛 METHOD_NOT_FOUND）。
 */
export function parseNuhClientRequest(raw: unknown): NuhClientRequest {
  const classified = classifyJsonRpcMessage(raw, { requireJsonRpcVersion: true });
  if (classified.kind !== 'request') {
    throw new NuhProtocolError(
      NUH_ERROR_CODES.INVALID_REQUEST,
      `期望 Client->Daemon Request 帧，实际收到: ${classified.kind}`,
    );
  }
  if (!KNOWN_CLIENT_METHODS.has(classified.message.method)) {
    throw new NuhProtocolError(
      NUH_ERROR_CODES.METHOD_NOT_FOUND,
      `未知的 NUH RPC 方法: ${classified.message.method}`,
      { method: classified.message.method },
    );
  }
  const parsed = NuhClientRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw formatZodValidationError(
      `NUH Request 参数校验失败 (${classified.message.method})`,
      parsed.error,
      NUH_ERROR_CODES.INVALID_PARAMS,
    );
  }
  return parsed.data;
}

/**
 * 严格校验 Client -> Daemon 通知帧（如 `initialized`）。
 */
export function parseNuhClientNotification(raw: unknown): NuhClientNotification {
  const classified = classifyJsonRpcMessage(raw, { requireJsonRpcVersion: true });
  if (classified.kind !== 'notification') {
    throw new NuhProtocolError(
      NUH_ERROR_CODES.INVALID_REQUEST,
      `期望 Client->Daemon Notification 帧，实际收到: ${classified.kind}`,
    );
  }
  if (!KNOWN_CLIENT_NOTIFICATION_METHODS.has(classified.message.method)) {
    throw new NuhProtocolError(
      NUH_ERROR_CODES.METHOD_NOT_FOUND,
      `未知的 NUH Notification 方法: ${classified.message.method}`,
      { method: classified.message.method },
    );
  }
  const parsed = NuhClientNotificationSchema.safeParse(raw);
  if (!parsed.success) {
    throw formatZodValidationError(
      `NUH Notification 参数校验失败 (${classified.message.method})`,
      parsed.error,
      NUH_ERROR_CODES.INVALID_PARAMS,
    );
  }
  return parsed.data;
}

/**
 * 严格校验 Daemon -> Client 服务端主动审批请求帧。
 */
export function parseNuhServerRequest(raw: unknown): NuhServerRequest {
  const classified = classifyJsonRpcMessage(raw, { requireJsonRpcVersion: true });
  if (classified.kind !== 'request') {
    throw new NuhProtocolError(
      NUH_ERROR_CODES.INVALID_REQUEST,
      `期望 Daemon->Client Request 帧，实际收到: ${classified.kind}`,
    );
  }
  if (classified.message.method !== 'approval/requested') {
    throw new NuhProtocolError(
      NUH_ERROR_CODES.METHOD_NOT_FOUND,
      `未知的 NUH 服务端请求方法: ${classified.message.method}`,
    );
  }
  const parsed = NuhServerRequestSchema.safeParse(raw);
  if (!parsed.success) {
    throw formatZodValidationError(
      'NUH 服务端审批请求校验失败',
      parsed.error,
      NUH_ERROR_CODES.INVALID_PARAMS,
    );
  }
  return parsed.data;
}

/**
 * 严格校验 Daemon -> Client 流式通知帧。
 */
export function parseNuhNotification(raw: unknown): NuhNotification {
  const classified = classifyJsonRpcMessage(raw, { requireJsonRpcVersion: true });
  if (classified.kind !== 'notification') {
    throw new NuhProtocolError(
      NUH_ERROR_CODES.INVALID_REQUEST,
      `期望 NUH Notification 帧，实际收到: ${classified.kind}`,
    );
  }
  const parsed = NuhNotificationSchema.safeParse(raw);
  if (!parsed.success) {
    throw formatZodValidationError(
      `NUH Notification 校验失败 (${classified.message.method})`,
      parsed.error,
      NUH_ERROR_CODES.PROTOCOL_VALIDATION_ERROR,
    );
  }
  return parsed.data;
}
