import { z } from 'zod';

/**
 * NUH 统一协议标准 JSON-RPC 2.0 与应用级错误码。
 * 遵循 AGENTS.md“无静默降级”纪律：任何解析或校验失败必须转换为明确的错误码。
 */
export const NUH_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  PROTOCOL_VALIDATION_ERROR: -32001,
  BACKEND_PROCESS_ERROR: -32002,
  BACKEND_UNAVAILABLE: -32003,
  APPROVAL_REJECTED: -32004,
  THREAD_NOT_FOUND: -32005,
  TURN_NOT_FOUND: -32006,
} as const;

export type NuhErrorCode = (typeof NUH_ERROR_CODES)[keyof typeof NUH_ERROR_CODES];

export const JsonRpcErrorSchema = z
  .object({
    code: z.number().int(),
    message: z.string(),
    data: z.unknown().optional(),
  })
  .passthrough();

export type JsonRpcErrorObject = z.infer<typeof JsonRpcErrorSchema>;

export interface JsonRpcErrorResponsePayload {
  readonly jsonrpc: '2.0';
  readonly id: number | string | null;
  readonly error: JsonRpcErrorObject;
}

/**
 * 协议解析、校验与边界转换失败时抛出的结构化异常。
 */
export class NuhProtocolError extends Error {
  readonly code: NuhErrorCode;
  readonly data?: unknown;

  constructor(code: NuhErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = 'NuhProtocolError';
    this.code = code;
    this.data = data;
  }

  toJsonRpcError(): JsonRpcErrorObject {
    if (this.data === undefined) {
      return {
        code: this.code,
        message: this.message,
      };
    }
    return {
      code: this.code,
      message: this.message,
      data: this.data,
    };
  }

  toJsonRpcErrorResponse(id: number | string | null): JsonRpcErrorResponsePayload {
    return {
      jsonrpc: '2.0',
      id,
      error: this.toJsonRpcError(),
    };
  }
}

/**
 * 将 ZodError 或未知校验错误转换为结构化 NuhProtocolError。
 */
export function formatZodValidationError(
  context: string,
  error: z.ZodError,
  code: NuhErrorCode = NUH_ERROR_CODES.PROTOCOL_VALIDATION_ERROR,
): NuhProtocolError {
  const issues = error.issues.map((issue) => ({
    path: issue.path.join('.'),
    code: issue.code,
    message: issue.message,
  }));
  const firstIssue = issues[0];
  const summary = firstIssue
    ? `${firstIssue.path || '<root>'}: ${firstIssue.message}`
    : error.message;
  return new NuhProtocolError(code, `${context}: ${summary}`, { issues });
}
