export const PACKAGE_NAME = '@nuh/mcp-bridge' as const;

export {
  MCP_BRIDGE_DEFAULT_SERVER_NAME,
  McpBridgeIpcCallRequestSchema,
  McpBridgeIpcErrorSchema,
  McpBridgeIpcListRequestSchema,
  type McpBridgeIpcRequest,
  McpBridgeIpcRequestSchema,
  type McpBridgeIpcResponse,
  McpBridgeIpcResponseSchema,
  type McpBridgeJsonSchemaObject,
  McpBridgeJsonSchemaObjectSchema,
  type McpBridgeLaunchSpec,
  type McpBridgeListToolsResult,
  McpBridgeListToolsResultSchema,
  type McpBridgeToolOutcome,
  McpBridgeToolOutcomeSchema,
  type McpBridgeToolProvider,
  type McpBridgeToolSpec,
  type McpBridgeWireTool,
  McpBridgeWireToolSchema,
} from './ipc.ts';

export {
  type CreateMcpBridgeLaunchSpecOptions,
  createMcpBridgeLaunchSpec,
  resolveMcpBridgeBinPath,
} from './launch.ts';

export {
  McpBridgeIpcServer,
  type McpBridgeIpcServerOptions,
  resolveMcpBridgeSocketPath,
} from './server.ts';

export {
  McpBridgeIpcClient,
  type StartStdioProxyOptions,
  type StdioProxyHandle,
  startMcpBridgeStdioProxy,
} from './stdio-proxy.ts';
