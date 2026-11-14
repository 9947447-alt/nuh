import net from 'node:net';
import type { Writable } from 'node:stream';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import {
  type McpBridgeIpcRequest,
  McpBridgeIpcResponseSchema,
  type McpBridgeListToolsResult,
  McpBridgeListToolsResultSchema,
  type McpBridgeToolOutcome,
  McpBridgeToolOutcomeSchema,
} from './ipc.ts';

interface PendingIpcCall {
  readonly resolve: (value: McpBridgeListToolsResult | McpBridgeToolOutcome) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_IPC_REQUEST_TIMEOUT_MS = 35_000;

/**
 * Reconnecting Unix socket NDJSON client shared by stateless stdio proxy calls.
 * Supports transient Daemon socket reconnects and parallel MCP requests.
 */
export class McpBridgeIpcClient {
  private readonly socketPath: string;
  private readonly requestTimeoutMs: number;
  private socket: net.Socket | undefined;
  private connecting: Promise<net.Socket> | undefined;
  private buffer = '';
  private nextId = 0;
  private closed = false;
  private readonly pending = new Map<string, PendingIpcCall>();

  constructor(socketPath: string, requestTimeoutMs = DEFAULT_IPC_REQUEST_TIMEOUT_MS) {
    this.socketPath = socketPath;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  async listTools(): Promise<McpBridgeListToolsResult> {
    const raw = await this.send({
      id: `ipc_${++this.nextId}`,
      method: 'tools/list',
    });
    return McpBridgeListToolsResultSchema.parse(raw);
  }

  async callTool(params: {
    readonly name: string;
    readonly arguments: Record<string, unknown>;
    readonly cwd?: string;
  }): Promise<McpBridgeToolOutcome> {
    const raw = await this.send({
      id: `ipc_${++this.nextId}`,
      method: 'tools/call',
      params,
    });
    return McpBridgeToolOutcomeSchema.parse(raw);
  }

  close(): void {
    this.closed = true;
    const error = new Error('MCP Bridge IPC client closed');
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
    this.connecting = undefined;
    if (this.socket) {
      this.socket.destroy();
      this.socket = undefined;
    }
  }

  private async ensureSocket(): Promise<net.Socket> {
    if (this.closed) {
      throw new Error('MCP Bridge IPC client is closed');
    }
    if (
      this.socket &&
      !this.socket.destroyed &&
      this.socket.writable &&
      !this.socket.writableEnded
    ) {
      return this.socket;
    }
    if (!this.connecting) {
      this.connecting = new Promise<net.Socket>((resolve, reject) => {
        const socket = net.createConnection(this.socketPath);
        socket.setEncoding('utf8');

        const onConnectError = (err: Error) => {
          this.connecting = undefined;
          socket.destroy();
          reject(
            new Error(`Failed to connect to NUH MCP IPC socket ${this.socketPath}: ${err.message}`),
          );
        };

        const onConnect = () => {
          socket.off('error', onConnectError);
          this.connecting = undefined;
          this.socket = socket;
          this.buffer = '';
          this.attachSocketEvents(socket);
          resolve(socket);
        };

        socket.once('error', onConnectError);
        socket.once('connect', onConnect);
      });
    }
    return this.connecting;
  }

  private attachSocketEvents(socket: net.Socket): void {
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newlineIndex = this.buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = this.buffer.slice(0, newlineIndex).trim();
        this.buffer = this.buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          this.handleResponseLine(line);
        }
        newlineIndex = this.buffer.indexOf('\n');
      }
    });

    const failPending = (reason: string) => {
      if (this.socket === socket) {
        this.socket = undefined;
      }
      const error = new Error(reason);
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(error);
        this.pending.delete(id);
      }
    };

    socket.on('error', (err) => {
      failPending(`NUH MCP IPC socket error: ${err.message}`);
    });

    socket.on('close', () => {
      failPending('NUH MCP IPC socket disconnected');
    });
  }

  private handleResponseLine(rawLine: string): void {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawLine);
    } catch {
      return;
    }
    const parsed = McpBridgeIpcResponseSchema.safeParse(parsedJson);
    if (!parsed.success) {
      return;
    }
    const response = parsed.data;
    const entry = this.pending.get(response.id);
    if (!entry) {
      return;
    }
    clearTimeout(entry.timer);
    this.pending.delete(response.id);
    if (response.ok) {
      entry.resolve(response.result);
    } else {
      entry.reject(new Error(`${response.error.message} (code=${response.error.code})`));
    }
  }

  private async send(
    request: McpBridgeIpcRequest,
  ): Promise<McpBridgeListToolsResult | McpBridgeToolOutcome> {
    const hadExistingSocket = Boolean(this.socket && !this.socket.destroyed);
    try {
      return await this.sendOnce(request);
    } catch (error) {
      if (hadExistingSocket && !this.closed && isReconnectableError(error)) {
        return this.sendOnce({
          ...request,
          id: `ipc_${++this.nextId}`,
        });
      }
      throw error;
    }
  }

  private async sendOnce(
    request: McpBridgeIpcRequest,
  ): Promise<McpBridgeListToolsResult | McpBridgeToolOutcome> {
    const socket = await this.ensureSocket();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new Error(`NUH MCP IPC request ${request.method} timed out`));
      }, this.requestTimeoutMs);

      this.pending.set(request.id, { resolve, reject, timer });

      try {
        socket.write(`${JSON.stringify(request)}\n`);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(request.id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}

function isReconnectableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const msg = error.message;
  return (
    msg.includes('NUH MCP IPC socket disconnected') ||
    msg.includes('NUH MCP IPC socket error') ||
    msg.includes('EPIPE') ||
    msg.includes('ECONNRESET')
  );
}

export interface StartStdioProxyOptions {
  readonly socketPath: string;
  readonly cwd?: string;
  readonly stderr?: Writable;
  readonly requestTimeoutMs?: number;
}

export interface StdioProxyHandle {
  close(): Promise<void>;
}

/**
 * Starts the stateless `stdio` MCP Server forwarding read-only tool requests
 * over local IPC to the NUH Daemon. All diagnostics go strictly to `stderr`.
 */
export async function startMcpBridgeStdioProxy(
  options: StartStdioProxyOptions,
): Promise<StdioProxyHandle> {
  const stderr = options.stderr ?? process.stderr;
  const ipcClient = new McpBridgeIpcClient(options.socketPath, options.requestTimeoutMs);

  const server = new Server(
    {
      name: 'nuh-mcp-bridge',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      const listed = await ipcClient.listTools();
      return {
        tools: listed.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        })),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderr.write(`[nuh-mcp-bridge] tools/list failed: ${message}\n`);
      throw new McpError(ErrorCode.InternalError, message);
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const outcome = await ipcClient.callTool({
        name: request.params.name,
        arguments: request.params.arguments ?? {},
        ...(options.cwd ? { cwd: options.cwd } : {}),
      });
      if (outcome.isError) {
        return {
          content: [{ type: 'text', text: outcome.text }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text', text: outcome.text }],
        ...(outcome.structuredContent ? { structuredContent: outcome.structuredContent } : {}),
        isError: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      stderr.write(`[nuh-mcp-bridge] tools/call (${request.params.name}) failed: ${message}\n`);
      throw new McpError(ErrorCode.InternalError, message);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  return {
    async close() {
      ipcClient.close();
      await server.close();
    },
  };
}
