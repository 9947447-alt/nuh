import { z } from 'zod';

export const MCP_BRIDGE_DEFAULT_SERVER_NAME = 'nuh_memory' as const;

export const McpBridgeJsonSchemaObjectSchema = z
  .object({
    type: z.literal('object'),
  })
  .catchall(z.unknown());

export type McpBridgeJsonSchemaObject = z.infer<typeof McpBridgeJsonSchemaObjectSchema>;

export const McpBridgeWireToolSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  inputSchema: McpBridgeJsonSchemaObjectSchema,
  readOnly: z.literal(true),
});

export type McpBridgeWireTool = z.infer<typeof McpBridgeWireToolSchema>;

export const McpBridgeListToolsResultSchema = z.object({
  tools: z.array(McpBridgeWireToolSchema),
});

export type McpBridgeListToolsResult = z.infer<typeof McpBridgeListToolsResultSchema>;

export const McpBridgeToolOutcomeSchema = z.object({
  isError: z.boolean(),
  text: z.string(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  errorMessage: z.string().optional(),
});

export type McpBridgeToolOutcome = z.infer<typeof McpBridgeToolOutcomeSchema>;

export const McpBridgeIpcListRequestSchema = z.object({
  id: z.string().min(1),
  method: z.literal('tools/list'),
});

export const McpBridgeIpcCallRequestSchema = z.object({
  id: z.string().min(1),
  method: z.literal('tools/call'),
  params: z.object({
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).default({}),
    cwd: z.string().min(1).optional(),
  }),
});

export const McpBridgeIpcRequestSchema = z.discriminatedUnion('method', [
  McpBridgeIpcListRequestSchema,
  McpBridgeIpcCallRequestSchema,
]);

export type McpBridgeIpcRequest = z.infer<typeof McpBridgeIpcRequestSchema>;

export const McpBridgeIpcErrorSchema = z.object({
  code: z.number().int(),
  message: z.string(),
});

export const McpBridgeIpcResponseSchema = z.discriminatedUnion('ok', [
  z.object({
    id: z.string(),
    ok: z.literal(true),
    result: z.union([McpBridgeListToolsResultSchema, McpBridgeToolOutcomeSchema]),
  }),
  z.object({
    id: z.string(),
    ok: z.literal(false),
    error: McpBridgeIpcErrorSchema,
  }),
]);

export type McpBridgeIpcResponse = z.infer<typeof McpBridgeIpcResponseSchema>;

export interface McpBridgeToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: McpBridgeJsonSchemaObject;
  readonly readOnly: true;
}

export interface McpBridgeToolProvider {
  listTools(): Promise<readonly McpBridgeToolSpec[]> | readonly McpBridgeToolSpec[];
  callTool(
    name: string,
    args: Record<string, unknown>,
    options?: {
      readonly cwd?: string;
      readonly signal?: AbortSignal;
    },
  ): Promise<McpBridgeToolOutcome>;
}

export interface McpBridgeLaunchSpec {
  readonly serverName: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}
