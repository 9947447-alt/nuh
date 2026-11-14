import { z } from 'zod';
import { formatZodValidationError, NUH_ERROR_CODES, NuhProtocolError } from '../errors.ts';
import {
  classifyJsonRpcMessage,
  type ExternalJsonRpcErrorResponseEnvelope,
  type ExternalJsonRpcSuccessResponseEnvelope,
  JsonRpcIdSchema,
} from '../jsonrpc.ts';

// ---------------------------------------------------------------------------
// AGY ACP (`agy acp --stdio`) Wire Schemas (Spike 04 实测锁定，单轨唯一通道)
// ---------------------------------------------------------------------------

export const AgyAcpTextContentSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
  })
  .passthrough();

export const AgyAcpToolCallUpdateBodySchema = z
  .object({
    sessionUpdate: z.enum(['tool_call', 'tool_call_update']),
    toolCallId: z.string().min(1),
    name: z.string().min(1).optional(),
    args: z.record(z.string(), z.unknown()).optional(),
    status: z.string(),
    kind: z.string().optional(),
    title: z.string().optional(),
    rawInput: z.unknown().optional(),
    rawOutput: z.unknown().optional(),
    content: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const AgyAcpSessionUpdateBodySchema = z.union([
  z
    .object({
      sessionUpdate: z.enum(['user_message_chunk', 'agent_message_chunk', 'agent_thought_chunk']),
      content: AgyAcpTextContentSchema,
    })
    .passthrough(),
  AgyAcpToolCallUpdateBodySchema,
  z
    .object({
      sessionUpdate: z.literal('available_commands_update'),
      availableCommands: z.array(z.object({ name: z.string() }).passthrough()),
    })
    .passthrough(),
  z
    .object({
      sessionUpdate: z.literal('session_info_update'),
      title: z.string().optional(),
    })
    .passthrough(),
  z
    .object({
      sessionUpdate: z.literal('config_option_update'),
      configOptions: z.array(z.unknown()),
    })
    .passthrough(),
  z
    .object({
      sessionUpdate: z.literal('usage_update'),
      used: z.number(),
      size: z.number(),
    })
    .passthrough(),
  z
    .object({
      sessionUpdate: z.string().min(1),
    })
    .passthrough(),
]);
export type AgyAcpSessionUpdateBody = z.infer<typeof AgyAcpSessionUpdateBodySchema>;

export const AgyAcpSessionUpdateNotificationSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    method: z.literal('session/update'),
    params: z
      .object({
        sessionId: z.string().min(1),
        update: AgyAcpSessionUpdateBodySchema,
      })
      .passthrough(),
  })
  .passthrough();
export type AgyAcpSessionUpdateNotification = z.infer<typeof AgyAcpSessionUpdateNotificationSchema>;

export const AgyAcpPermissionOptionSchema = z
  .object({
    optionId: z.string().min(1),
    name: z.string().min(1),
    kind: z.string().min(1),
  })
  .passthrough();

/**
 * Spike 04 实测：AGY ACP 服务端主动审批请求 `id` 为字符串（如 `"1"`）。
 */
export const AgyAcpPermissionRequestSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: JsonRpcIdSchema,
    method: z.literal('session/request_permission'),
    params: z
      .object({
        sessionId: z.string().min(1),
        toolCall: AgyAcpToolCallUpdateBodySchema,
        options: z.array(AgyAcpPermissionOptionSchema).min(1),
      })
      .passthrough(),
  })
  .passthrough();
export type AgyAcpPermissionRequest = z.infer<typeof AgyAcpPermissionRequestSchema>;

export const AgyAcpInitializeResultSchema = z
  .object({
    protocolVersion: z.number().int(),
    agentCapabilities: z.record(z.string(), z.unknown()),
    agentInfo: z
      .object({
        name: z.string().min(1),
        version: z.string().min(1),
      })
      .passthrough(),
    authMethods: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const AgyAcpSessionResultSchema = z
  .object({
    sessionId: z.string().min(1),
    models: z.record(z.string(), z.unknown()).optional(),
    modes: z.record(z.string(), z.unknown()).optional(),
    configOptions: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const AgyAcpPromptResultSchema = z
  .object({
    stopReason: z.string().min(1),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        cachedReadTokens: z.number().int().nonnegative().optional(),
        cachedWriteTokens: z.number().int().nonnegative().optional(),
        thoughtTokens: z.number().int().nonnegative().optional(),
        totalTokens: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const AgyAcpSetConfigOptionParamsSchema = z
  .object({
    sessionId: z.string().min(1),
    configId: z.string().min(1),
    value: z.string().min(1),
  })
  .passthrough();

export const AgyAcpSetConfigOptionResultSchema = z
  .object({
    configOptions: z.array(z.unknown()),
  })
  .passthrough();

export const AgyAcpOtherNotificationSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    method: z.string().min(1),
    params: z.unknown().optional(),
  })
  .passthrough();

export type AgyAcpNotification =
  | AgyAcpSessionUpdateNotification
  | z.infer<typeof AgyAcpOtherNotificationSchema>;

export const AgyAcpGenericServerRequestSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: JsonRpcIdSchema,
    method: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export type AgyAcpServerRequest =
  | AgyAcpPermissionRequest
  | z.infer<typeof AgyAcpGenericServerRequestSchema>;

export type AgyAcpWireMessage =
  | { readonly kind: 'server_request'; readonly message: AgyAcpServerRequest }
  | { readonly kind: 'notification'; readonly message: AgyAcpNotification }
  | { readonly kind: 'response_success'; readonly message: ExternalJsonRpcSuccessResponseEnvelope }
  | { readonly kind: 'response_error'; readonly message: ExternalJsonRpcErrorResponseEnvelope };

/**
 * 解析并校验来自 `agy acp --stdio` 的单条下行 JSON-RPC 2.0 报文。
 * - 强制要求 `"jsonrpc": "2.0"`
 * - 允许字符串与数字异构 ID（实测服务端审批请求 `id` 为字符串 `"1"`）
 * - 使用 `.passthrough()` 兼容 `agentCapabilities` 驼峰/下划线混用及 `_meta` 等扩展字段
 */
export function parseAgyAcpWireMessage(raw: unknown): AgyAcpWireMessage {
  const classified = classifyJsonRpcMessage(raw, { requireJsonRpcVersion: true });

  switch (classified.kind) {
    case 'request': {
      if (classified.message.method === 'session/request_permission') {
        const parsed = AgyAcpPermissionRequestSchema.safeParse(raw);
        if (!parsed.success) {
          throw formatZodValidationError(
            'AGY ACP session/request_permission 校验失败',
            parsed.error,
          );
        }
        return { kind: 'server_request', message: parsed.data };
      }
      const fallback = AgyAcpGenericServerRequestSchema.safeParse(raw);
      if (!fallback.success) {
        throw formatZodValidationError('AGY ACP 服务端请求校验失败', fallback.error);
      }
      return { kind: 'server_request', message: fallback.data };
    }
    case 'notification': {
      if (classified.message.method === 'session/update') {
        const parsed = AgyAcpSessionUpdateNotificationSchema.safeParse(raw);
        if (!parsed.success) {
          throw formatZodValidationError('AGY ACP session/update 校验失败', parsed.error);
        }
        return { kind: 'notification', message: parsed.data };
      }
      const fallback = AgyAcpOtherNotificationSchema.safeParse(raw);
      if (!fallback.success) {
        throw formatZodValidationError(
          `AGY ACP 通知校验失败 (${classified.message.method})`,
          fallback.error,
        );
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
 * 构造发送给 `agy acp --stdio` 的标准权限回复报文。
 */
export function buildAgyAcpPermissionResponse(
  id: number | string,
  optionId: string,
): {
  readonly jsonrpc: '2.0';
  readonly id: number | string;
  readonly result: {
    readonly outcome: { readonly outcome: 'selected'; readonly optionId: string };
  };
} {
  const idParsed = JsonRpcIdSchema.safeParse(id);
  if (!idParsed.success) {
    throw new NuhProtocolError(NUH_ERROR_CODES.INVALID_PARAMS, '无效的 ACP 权限请求 id', { id });
  }
  if (optionId.trim().length === 0) {
    throw new NuhProtocolError(NUH_ERROR_CODES.INVALID_PARAMS, '无效的 ACP 权限选项 optionId', {
      optionId,
    });
  }
  return {
    jsonrpc: '2.0',
    id: idParsed.data,
    result: {
      outcome: {
        outcome: 'selected',
        optionId,
      },
    },
  };
}
