import { z } from 'zod';
import {
  formatZodValidationError,
  JsonRpcErrorSchema,
  NUH_ERROR_CODES,
  NuhProtocolError,
} from './errors.ts';

/**
 * 合法 JSON-RPC 请求 ID：兼容数字（如 Codex 自增 ID `0`）与字符串（如 ACP `"1"`）。
 */
export const JsonRpcIdSchema = z.union([z.number().int().finite(), z.string().min(1)]);
export type JsonRpcId = z.infer<typeof JsonRpcIdSchema>;

export const JsonRpcResponseIdSchema = z.union([JsonRpcIdSchema, z.null()]);
export type JsonRpcResponseId = z.infer<typeof JsonRpcResponseIdSchema>;

/**
 * NUH Daemon <-> Client 规范 JSON-RPC 2.0 帧（强制携带 `"jsonrpc": "2.0"`）。
 */
export const NuhJsonRpcRequestEnvelopeSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: JsonRpcIdSchema,
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export const NuhJsonRpcNotificationEnvelopeSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

export const NuhJsonRpcSuccessResponseEnvelopeSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: JsonRpcIdSchema,
  result: z.unknown(),
});

export const NuhJsonRpcErrorResponseEnvelopeSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: JsonRpcResponseIdSchema,
  error: JsonRpcErrorSchema,
});

export type NuhJsonRpcRequestEnvelope = z.infer<typeof NuhJsonRpcRequestEnvelopeSchema>;
export type NuhJsonRpcNotificationEnvelope = z.infer<typeof NuhJsonRpcNotificationEnvelopeSchema>;
export type NuhJsonRpcSuccessResponseEnvelope = z.infer<
  typeof NuhJsonRpcSuccessResponseEnvelopeSchema
>;
export type NuhJsonRpcErrorResponseEnvelope = z.infer<typeof NuhJsonRpcErrorResponseEnvelopeSchema>;

/**
 * 外部 CLI 宽容 JSON-RPC 帧（Spike 01 实测 Codex 省略 `"jsonrpc": "2.0"`，且含未知扩展字段）。
 */
export const ExternalJsonRpcRequestEnvelopeSchema = z
  .object({
    jsonrpc: z.literal('2.0').optional(),
    id: JsonRpcIdSchema,
    method: z.string().min(1),
    params: z.unknown().optional(),
  })
  .passthrough();

export const ExternalJsonRpcNotificationEnvelopeSchema = z
  .object({
    jsonrpc: z.literal('2.0').optional(),
    method: z.string().min(1),
    params: z.unknown().optional(),
  })
  .passthrough();

export const ExternalJsonRpcSuccessResponseEnvelopeSchema = z
  .object({
    jsonrpc: z.literal('2.0').optional(),
    id: JsonRpcIdSchema,
    result: z.unknown(),
  })
  .passthrough();

export const ExternalJsonRpcErrorResponseEnvelopeSchema = z
  .object({
    jsonrpc: z.literal('2.0').optional(),
    id: JsonRpcResponseIdSchema,
    error: JsonRpcErrorSchema,
  })
  .passthrough();

export type ExternalJsonRpcRequestEnvelope = z.infer<typeof ExternalJsonRpcRequestEnvelopeSchema>;
export type ExternalJsonRpcNotificationEnvelope = z.infer<
  typeof ExternalJsonRpcNotificationEnvelopeSchema
>;
export type ExternalJsonRpcSuccessResponseEnvelope = z.infer<
  typeof ExternalJsonRpcSuccessResponseEnvelopeSchema
>;
export type ExternalJsonRpcErrorResponseEnvelope = z.infer<
  typeof ExternalJsonRpcErrorResponseEnvelopeSchema
>;

export type ClassifiedJsonRpcMessage<
  TReq = ExternalJsonRpcRequestEnvelope,
  TNotif = ExternalJsonRpcNotificationEnvelope,
  TSucc = ExternalJsonRpcSuccessResponseEnvelope,
  TErr = ExternalJsonRpcErrorResponseEnvelope,
> =
  | { readonly kind: 'request'; readonly message: TReq }
  | { readonly kind: 'notification'; readonly message: TNotif }
  | { readonly kind: 'response_success'; readonly message: TSucc }
  | { readonly kind: 'response_error'; readonly message: TErr };

const RawJsonObjectSchema = z.record(z.string(), z.unknown());

/**
 * 判断与分发 JSON-RPC 帧类型。
 * 关键规则（Spike 01/04）：必须先检测 `id !== undefined && method !== undefined`，
 * 防止服务端主动请求的独立 ID（如 `0` 或 `"1"`）与客户端 pending ID 发生碰撞误判。
 */
export function classifyJsonRpcMessage(
  raw: unknown,
  options: { readonly requireJsonRpcVersion?: boolean } = {},
): ClassifiedJsonRpcMessage {
  const requireVersion = options.requireJsonRpcVersion ?? false;
  const objParsed = RawJsonObjectSchema.safeParse(raw);
  if (!objParsed.success) {
    throw formatZodValidationError(
      'JSON-RPC 帧必须为非数组 JSON 对象',
      objParsed.error,
      NUH_ERROR_CODES.INVALID_REQUEST,
    );
  }
  const record = objParsed.data;
  const hasId = record.id !== undefined;
  const hasMethod = record.method !== undefined;

  if (hasId && hasMethod) {
    const schema = requireVersion
      ? NuhJsonRpcRequestEnvelopeSchema
      : ExternalJsonRpcRequestEnvelopeSchema;
    const parsed = schema.safeParse(record);
    if (!parsed.success) {
      throw formatZodValidationError(
        '非法 JSON-RPC Request 帧',
        parsed.error,
        NUH_ERROR_CODES.INVALID_REQUEST,
      );
    }
    return { kind: 'request', message: parsed.data };
  }

  if (hasMethod) {
    const schema = requireVersion
      ? NuhJsonRpcNotificationEnvelopeSchema
      : ExternalJsonRpcNotificationEnvelopeSchema;
    const parsed = schema.safeParse(record);
    if (!parsed.success) {
      throw formatZodValidationError(
        '非法 JSON-RPC Notification 帧',
        parsed.error,
        NUH_ERROR_CODES.INVALID_REQUEST,
      );
    }
    return { kind: 'notification', message: parsed.data };
  }

  if (hasId && 'error' in record && record.error !== undefined) {
    const schema = requireVersion
      ? NuhJsonRpcErrorResponseEnvelopeSchema
      : ExternalJsonRpcErrorResponseEnvelopeSchema;
    const parsed = schema.safeParse(record);
    if (!parsed.success) {
      throw formatZodValidationError(
        '非法 JSON-RPC Error Response 帧',
        parsed.error,
        NUH_ERROR_CODES.INVALID_REQUEST,
      );
    }
    return { kind: 'response_error', message: parsed.data };
  }

  if (hasId && 'result' in record) {
    const schema = requireVersion
      ? NuhJsonRpcSuccessResponseEnvelopeSchema
      : ExternalJsonRpcSuccessResponseEnvelopeSchema;
    const parsed = schema.safeParse(record);
    if (!parsed.success) {
      throw formatZodValidationError(
        '非法 JSON-RPC Result Response 帧',
        parsed.error,
        NUH_ERROR_CODES.INVALID_REQUEST,
      );
    }
    return { kind: 'response_success', message: parsed.data };
  }

  throw new NuhProtocolError(
    NUH_ERROR_CODES.INVALID_REQUEST,
    '无法识别的 JSON-RPC 帧：缺少 method 或 result/error 字段',
    { keys: Object.keys(record) },
  );
}

/**
 * 严格解析单行 NDJSON 文本（禁止静默返回 null）。
 */
export function parseNdjsonJson(line: string): unknown {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    throw new NuhProtocolError(NUH_ERROR_CODES.PARSE_ERROR, 'NDJSON 行不能为空白字符串');
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new NuhProtocolError(NUH_ERROR_CODES.PARSE_ERROR, `NDJSON JSON 解析失败: ${detail}`, {
      linePreview: trimmed.slice(0, 120),
    });
  }
}

/**
 * 严格按给定 Zod Schema 解析单行 NDJSON 报文。
 */
export function parseNdjsonWithSchema<TSchema extends z.ZodType>(
  line: string,
  schema: TSchema,
  context = 'NDJSON 报文校验失败',
): z.infer<TSchema> {
  const raw = parseNdjsonJson(line);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw formatZodValidationError(context, parsed.error);
  }
  return parsed.data;
}

/**
 * 序列化对象为单行 NDJSON（含尾部 `\n`）。
 */
export function serializeNdjsonLine(payload: unknown): string {
  return `${JSON.stringify(payload)}\n`;
}
