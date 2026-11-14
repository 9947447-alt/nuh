import { z } from 'zod';
import { formatZodValidationError, NUH_ERROR_CODES, NuhProtocolError } from '../errors.ts';
import {
  classifyJsonRpcMessage,
  type ExternalJsonRpcErrorResponseEnvelope,
  type ExternalJsonRpcSuccessResponseEnvelope,
  JsonRpcIdSchema,
} from '../jsonrpc.ts';

// ---------------------------------------------------------------------------
// Codex App-Server Client -> Server Requests (Spike 01 实测锁定)
// ---------------------------------------------------------------------------

/**
 * Spike 01 坑点 5：传非 null 的 capabilities 时，experimentalApi 与 requestAttestation 为必填布尔值。
 */
export const CodexInitializeCapabilitiesSchema = z
  .object({
    experimentalApi: z.boolean(),
    requestAttestation: z.boolean(),
  })
  .passthrough();

export const CodexInitializeParamsSchema = z
  .object({
    clientInfo: z
      .object({
        name: z.string().min(1),
        title: z.string().optional(),
        version: z.string().min(1),
      })
      .passthrough(),
    capabilities: CodexInitializeCapabilitiesSchema.nullable().optional(),
  })
  .passthrough();

export const CodexThreadStartParamsSchema = z
  .object({
    cwd: z.string().min(1),
    approvalPolicy: z.enum(['untrusted', 'on-failure', 'on-request', 'never']).optional(),
    sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
    ephemeral: z.boolean().optional(),
    model: z.string().optional(),
  })
  .passthrough();

export const CodexTurnInputItemSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
    text_elements: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const CodexTurnStartParamsSchema = z
  .object({
    threadId: z.string().min(1),
    input: z.array(CodexTurnInputItemSchema).min(1),
    model: z.string().min(1).optional(),
  })
  .passthrough();

export const CodexThreadResumeParamsSchema = z
  .object({
    threadId: z.string().min(1),
    cwd: z.string().min(1).optional(),
    approvalPolicy: z.enum(['untrusted', 'on-failure', 'on-request', 'never']).optional(),
    sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
  })
  .passthrough();

export const CodexTurnInterruptParamsSchema = z
  .object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
  })
  .passthrough();

export const CodexInitializeResultSchema = z
  .object({
    userAgent: z.string().optional(),
    codexHome: z.string().optional(),
    platformFamily: z.string().optional(),
    platformOs: z.string().optional(),
  })
  .passthrough();

export const CodexThreadStartResultSchema = z
  .object({
    thread: z
      .object({
        id: z.string().min(1),
      })
      .passthrough(),
  })
  .passthrough();

export const CodexTurnStartResultSchema = z
  .object({
    turn: z
      .object({
        id: z.string().min(1),
        status: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const CodexCommandExecutionDecisionSchema = z.union([
  z.enum(['accept', 'acceptForSession', 'decline', 'cancel']),
  z
    .object({
      acceptWithExecpolicyAmendment: z
        .object({
          execpolicy_amendment: z.array(z.string()),
        })
        .passthrough(),
    })
    .passthrough(),
  z
    .object({
      applyNetworkPolicyAmendment: z
        .object({
          network_policy_amendment: z.record(z.string(), z.unknown()),
        })
        .passthrough(),
    })
    .passthrough(),
]);

// ---------------------------------------------------------------------------
// Codex App-Server Server -> Client Items & Turn Structures
// ---------------------------------------------------------------------------

export const CodexUserMessageItemSchema = z
  .object({
    type: z.literal('userMessage'),
    id: z.string().min(1),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
  })
  .passthrough();

export const CodexAgentMessageItemSchema = z
  .object({
    type: z.literal('agentMessage'),
    id: z.string().min(1),
    text: z.string(),
    phase: z.string().nullable().optional(),
  })
  .passthrough();

export const CodexCommandExecutionItemSchema = z
  .object({
    type: z.literal('commandExecution'),
    id: z.string().min(1),
    command: z.string(),
    cwd: z.string(),
    status: z.string(),
    aggregatedOutput: z.string().nullable().optional(),
    exitCode: z.number().int().nullable().optional(),
    durationMs: z.number().nullable().optional(),
  })
  .passthrough();

export const CodexGenericItemSchema = z
  .object({
    type: z.string().min(1),
    id: z.string().min(1),
  })
  .passthrough();

export const CodexItemSchema = z.union([
  CodexUserMessageItemSchema,
  CodexAgentMessageItemSchema,
  CodexCommandExecutionItemSchema,
  CodexGenericItemSchema,
]);
export type CodexItem = z.infer<typeof CodexItemSchema>;

export const CodexTurnSchema = z
  .object({
    id: z.string().min(1),
    rootTurnId: z.string().optional(),
    items: z.array(CodexItemSchema),
    itemsView: z.string().optional(),
    status: z.string(),
    error: z.unknown().nullable().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Codex Server-Initiated Requests (id: number | string, 独立命名空间)
// ---------------------------------------------------------------------------

export const CodexCommandApprovalRequestSchema = z
  .object({
    jsonrpc: z.literal('2.0').optional(),
    id: JsonRpcIdSchema,
    method: z.literal('item/commandExecution/requestApproval'),
    params: z
      .object({
        threadId: z.string().min(1),
        turnId: z.string().min(1),
        itemId: z.string().min(1),
        command: z.string().optional(),
        cwd: z.string().optional(),
        availableDecisions: z.array(z.unknown()).optional(),
      })
      .passthrough(),
  })
  .passthrough();

export const CodexFileChangeApprovalRequestSchema = z
  .object({
    jsonrpc: z.literal('2.0').optional(),
    id: JsonRpcIdSchema,
    method: z.literal('item/fileChange/requestApproval'),
    params: z
      .object({
        threadId: z.string().min(1),
        turnId: z.string().min(1),
        itemId: z.string().min(1),
      })
      .passthrough(),
  })
  .passthrough();

export const CodexGenericServerRequestSchema = z
  .object({
    jsonrpc: z.literal('2.0').optional(),
    id: JsonRpcIdSchema,
    method: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export const CodexServerRequestSchema = z.union([
  CodexCommandApprovalRequestSchema,
  CodexFileChangeApprovalRequestSchema,
  CodexGenericServerRequestSchema,
]);
export type CodexServerRequest = z.infer<typeof CodexServerRequestSchema>;

// ---------------------------------------------------------------------------
// Codex Notifications (Spike 01 实测省略 jsonrpc 字段，顶层带 emittedAtMs)
// ---------------------------------------------------------------------------

export const CodexTurnStartedNotificationSchema = z
  .object({
    jsonrpc: z.literal('2.0').optional(),
    method: z.literal('turn/started'),
    params: z
      .object({
        threadId: z.string().min(1),
        turn: CodexTurnSchema,
      })
      .passthrough(),
    emittedAtMs: z.number().optional(),
  })
  .passthrough();

export const CodexTurnCompletedNotificationSchema = z
  .object({
    jsonrpc: z.literal('2.0').optional(),
    method: z.literal('turn/completed'),
    params: z
      .object({
        threadId: z.string().min(1),
        turn: CodexTurnSchema,
      })
      .passthrough(),
    emittedAtMs: z.number().optional(),
  })
  .passthrough();

export const CodexItemStartedNotificationSchema = z
  .object({
    jsonrpc: z.literal('2.0').optional(),
    method: z.literal('item/started'),
    params: z
      .object({
        threadId: z.string().min(1),
        turnId: z.string().min(1),
        item: CodexItemSchema,
      })
      .passthrough(),
    emittedAtMs: z.number().optional(),
  })
  .passthrough();

export const CodexItemCompletedNotificationSchema = z
  .object({
    jsonrpc: z.literal('2.0').optional(),
    method: z.literal('item/completed'),
    params: z
      .object({
        threadId: z.string().min(1),
        turnId: z.string().min(1),
        item: CodexItemSchema,
      })
      .passthrough(),
    emittedAtMs: z.number().optional(),
  })
  .passthrough();

export const CodexAgentMessageDeltaNotificationSchema = z
  .object({
    jsonrpc: z.literal('2.0').optional(),
    method: z.literal('item/agentMessage/delta'),
    params: z
      .object({
        threadId: z.string().min(1),
        turnId: z.string().min(1),
        itemId: z.string().min(1),
        delta: z.string(),
      })
      .passthrough(),
    emittedAtMs: z.number().optional(),
  })
  .passthrough();

export const CodexServerRequestResolvedNotificationSchema = z
  .object({
    jsonrpc: z.literal('2.0').optional(),
    method: z.literal('serverRequest/resolved'),
    params: z
      .object({
        threadId: z.string().min(1),
        requestId: JsonRpcIdSchema,
      })
      .passthrough(),
    emittedAtMs: z.number().optional(),
  })
  .passthrough();

export const CodexTokenUsageUpdatedNotificationSchema = z
  .object({
    jsonrpc: z.literal('2.0').optional(),
    method: z.literal('thread/tokenUsage/updated'),
    params: z
      .object({
        threadId: z.string().min(1),
        turnId: z.string().min(1),
        tokenUsage: z
          .object({
            total: z
              .object({
                totalTokens: z.number(),
                inputTokens: z.number(),
                outputTokens: z.number(),
                cachedInputTokens: z.number().optional(),
                reasoningOutputTokens: z.number().optional(),
              })
              .passthrough(),
          })
          .passthrough(),
      })
      .passthrough(),
    emittedAtMs: z.number().optional(),
  })
  .passthrough();

export const CodexOtherNotificationSchema = z
  .object({
    jsonrpc: z.literal('2.0').optional(),
    method: z.string().min(1),
    params: z.unknown().optional(),
    emittedAtMs: z.number().optional(),
  })
  .passthrough();

export type CodexNotification =
  | z.infer<typeof CodexTurnStartedNotificationSchema>
  | z.infer<typeof CodexTurnCompletedNotificationSchema>
  | z.infer<typeof CodexItemStartedNotificationSchema>
  | z.infer<typeof CodexItemCompletedNotificationSchema>
  | z.infer<typeof CodexAgentMessageDeltaNotificationSchema>
  | z.infer<typeof CodexServerRequestResolvedNotificationSchema>
  | z.infer<typeof CodexTokenUsageUpdatedNotificationSchema>
  | z.infer<typeof CodexOtherNotificationSchema>;

export type CodexWireMessage =
  | { readonly kind: 'server_request'; readonly message: CodexServerRequest }
  | { readonly kind: 'notification'; readonly message: CodexNotification }
  | { readonly kind: 'response_success'; readonly message: ExternalJsonRpcSuccessResponseEnvelope }
  | { readonly kind: 'response_error'; readonly message: ExternalJsonRpcErrorResponseEnvelope };

/**
 * 解析并校验来自 `codex app-server --stdio` 的单条下行 JSON 对象。
 * - 允许省略 `"jsonrpc": "2.0"`
 * - 允许未知字段透传（`.passthrough()`）
 * - 先识别 `id && method` 为 `server_request`，避免与客户端请求 ID 碰撞
 */
export function parseCodexWireMessage(raw: unknown): CodexWireMessage {
  const classified = classifyJsonRpcMessage(raw, { requireJsonRpcVersion: false });

  switch (classified.kind) {
    case 'request': {
      const parsed = CodexServerRequestSchema.safeParse(raw);
      if (!parsed.success) {
        throw formatZodValidationError('Codex ServerRequest 校验失败', parsed.error);
      }
      return { kind: 'server_request', message: parsed.data };
    }
    case 'notification': {
      const method = classified.message.method;
      const schemaMap = {
        'turn/started': CodexTurnStartedNotificationSchema,
        'turn/completed': CodexTurnCompletedNotificationSchema,
        'item/started': CodexItemStartedNotificationSchema,
        'item/completed': CodexItemCompletedNotificationSchema,
        'item/agentMessage/delta': CodexAgentMessageDeltaNotificationSchema,
        'serverRequest/resolved': CodexServerRequestResolvedNotificationSchema,
        'thread/tokenUsage/updated': CodexTokenUsageUpdatedNotificationSchema,
      } as const;

      const specificSchema =
        method in schemaMap ? schemaMap[method as keyof typeof schemaMap] : undefined;
      if (specificSchema) {
        const parsed = specificSchema.safeParse(raw);
        if (!parsed.success) {
          throw formatZodValidationError(`Codex 通知校验失败 (${method})`, parsed.error);
        }
        return { kind: 'notification', message: parsed.data };
      }

      const fallback = CodexOtherNotificationSchema.safeParse(raw);
      if (!fallback.success) {
        throw formatZodValidationError(`Codex 通用通知校验失败 (${method})`, fallback.error);
      }
      return { kind: 'notification', message: fallback.data };
    }
    case 'response_success':
      return { kind: 'response_success', message: classified.message };
    case 'response_error':
      return { kind: 'response_error', message: classified.message };
  }
}

/**
 * 校验客户端发往 `codex app-server` 的上行请求（确保 capabilities 坑点在发包前即被拦截）。
 */
export function parseCodexClientRequest(raw: unknown): {
  readonly id?: number | string;
  readonly method: string;
  readonly params?: unknown;
} {
  const classified = classifyJsonRpcMessage(raw, { requireJsonRpcVersion: false });
  if (classified.kind !== 'request' && classified.kind !== 'notification') {
    throw new NuhProtocolError(
      NUH_ERROR_CODES.INVALID_REQUEST,
      `期望 Codex 上行 Request/Notification，实际为 ${classified.kind}`,
    );
  }
  const msg = classified.message;
  if (msg.method === 'initialize') {
    const parsed = CodexInitializeParamsSchema.safeParse(msg.params);
    if (!parsed.success) {
      throw formatZodValidationError(
        'Codex initialize 参数校验失败',
        parsed.error,
        NUH_ERROR_CODES.INVALID_PARAMS,
      );
    }
  } else if (msg.method === 'thread/start') {
    const parsed = CodexThreadStartParamsSchema.safeParse(msg.params);
    if (!parsed.success) {
      throw formatZodValidationError(
        'Codex thread/start 参数校验失败',
        parsed.error,
        NUH_ERROR_CODES.INVALID_PARAMS,
      );
    }
  } else if (msg.method === 'turn/start') {
    const parsed = CodexTurnStartParamsSchema.safeParse(msg.params);
    if (!parsed.success) {
      throw formatZodValidationError(
        'Codex turn/start 参数校验失败',
        parsed.error,
        NUH_ERROR_CODES.INVALID_PARAMS,
      );
    }
  } else if (msg.method === 'thread/resume') {
    const parsed = CodexThreadResumeParamsSchema.safeParse(msg.params);
    if (!parsed.success) {
      throw formatZodValidationError(
        'Codex thread/resume 参数校验失败',
        parsed.error,
        NUH_ERROR_CODES.INVALID_PARAMS,
      );
    }
  } else if (msg.method === 'turn/interrupt') {
    const parsed = CodexTurnInterruptParamsSchema.safeParse(msg.params);
    if (!parsed.success) {
      throw formatZodValidationError(
        'Codex turn/interrupt 参数校验失败',
        parsed.error,
        NUH_ERROR_CODES.INVALID_PARAMS,
      );
    }
  }

  if (classified.kind === 'request') {
    return {
      id: classified.message.id,
      method: classified.message.method,
      params: classified.message.params,
    };
  }
  return {
    method: classified.message.method,
    params: classified.message.params,
  };
}
