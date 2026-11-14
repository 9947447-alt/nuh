import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Writable } from 'node:stream';
import { NUH_ERROR_CODES } from '@nuh/protocol';
import {
  McpBridgeIpcRequestSchema,
  type McpBridgeIpcResponse,
  type McpBridgeToolProvider,
  type McpBridgeWireTool,
} from './ipc.ts';

const MACOS_SUN_PATH_SAFE_MAX = 96;

export interface McpBridgeIpcServerOptions {
  readonly provider: McpBridgeToolProvider;
  readonly socketPath?: string;
  readonly nuhHome?: string;
  readonly stderr?: Writable;
}

/**
 * Computes a short, local-only Unix Domain Socket path obeying macOS's
 * 104-byte `sockaddr_un.sun_path` limit.
 */
export function resolveMcpBridgeSocketPath(nuhHome?: string): string {
  const suffix = `nuh-mcp-${process.pid}-${randomBytes(4).toString('hex')}.sock`;
  if (nuhHome) {
    const preferred = path.join(nuhHome, 'run', suffix);
    if (Buffer.byteLength(preferred, 'utf8') <= MACOS_SUN_PATH_SAFE_MAX) {
      return preferred;
    }
  }
  const sysTmp = os.tmpdir();
  const inTmpDir = path.join(sysTmp, suffix);
  if (Buffer.byteLength(inTmpDir, 'utf8') <= MACOS_SUN_PATH_SAFE_MAX) {
    return inTmpDir;
  }
  return path.join('/tmp', suffix);
}

/**
 * Daemon-resident Unix socket server exposing strictly read-only tool
 * listings and invocations to stateless `stdio` MCP proxies spawned by CLIs.
 */
export class McpBridgeIpcServer {
  readonly socketPath: string;
  private readonly provider: McpBridgeToolProvider;
  private readonly stderr: Writable;
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();
  private readonly activeCalls = new Set<AbortController>();
  private disposed = false;
  private disposePromise: Promise<void> | undefined;
  private cleanupRegistered = false;

  private readonly onProcessExit = () => {
    this.removeSocketFileSync();
  };

  private readonly onProcessSignal = () => {
    void this.dispose();
  };

  private constructor(
    socketPath: string,
    provider: McpBridgeToolProvider,
    server: net.Server,
    stderr: Writable,
  ) {
    this.socketPath = socketPath;
    this.provider = provider;
    this.server = server;
    this.stderr = stderr;
  }

  static async start(options: McpBridgeIpcServerOptions): Promise<McpBridgeIpcServer> {
    const socketPath = options.socketPath ?? resolveMcpBridgeSocketPath(options.nuhHome);
    if (Buffer.byteLength(socketPath, 'utf8') > 103) {
      throw new Error(`MCP bridge Unix socket path exceeds 103 bytes: ${socketPath}`);
    }

    mkdirSync(path.dirname(socketPath), { recursive: true });
    rmSync(socketPath, { force: true });

    const server = net.createServer();
    const instance = new McpBridgeIpcServer(
      socketPath,
      options.provider,
      server,
      options.stderr ?? process.stderr,
    );

    server.on('connection', (socket) => {
      instance.attachConnection(socket);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        try {
          chmodSync(socketPath, 0o600);
        } catch (err) {
          reject(err);
          return;
        }
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(socketPath);
    });

    instance.registerExitHooks();
    return instance;
  }

  async dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.disposePromise = (async () => {
        this.disposed = true;
        this.unregisterExitHooks();
        for (const controller of this.activeCalls) {
          controller.abort(new Error('NUH MCP Bridge IPC server shutting down'));
        }
        this.activeCalls.clear();
        for (const socket of this.sockets) {
          socket.destroy();
        }
        this.sockets.clear();
        await new Promise<void>((resolve) => {
          this.server.close(() => {
            resolve();
          });
        });
        this.removeSocketFileSync();
      })();
    }
    await this.disposePromise;
  }

  private registerExitHooks(): void {
    if (this.cleanupRegistered) {
      return;
    }
    this.cleanupRegistered = true;
    process.once('exit', this.onProcessExit);
    process.once('SIGINT', this.onProcessSignal);
    process.once('SIGTERM', this.onProcessSignal);
  }

  private unregisterExitHooks(): void {
    if (!this.cleanupRegistered) {
      return;
    }
    this.cleanupRegistered = false;
    process.off('exit', this.onProcessExit);
    process.off('SIGINT', this.onProcessSignal);
    process.off('SIGTERM', this.onProcessSignal);
  }

  private removeSocketFileSync(): void {
    try {
      rmSync(this.socketPath, { force: true });
    } catch {
      // Best-effort unlink inside synchronous exit handler
    }
  }

  private attachConnection(socket: net.Socket): void {
    if (this.disposed) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    socket.setEncoding('utf8');

    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line.length > 0) {
          void this.handleLine(socket, line);
        }
        newlineIndex = buffer.indexOf('\n');
      }
    });

    socket.on('error', (error) => {
      this.logError(`IPC socket error: ${error.message}`);
    });

    socket.on('close', () => {
      this.sockets.delete(socket);
    });
  }

  private async handleLine(socket: net.Socket, rawLine: string): Promise<void> {
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawLine);
    } catch (error) {
      this.writeResponse(socket, {
        id: 'unknown',
        ok: false,
        error: {
          code: NUH_ERROR_CODES.PARSE_ERROR,
          message: `Invalid IPC JSON frame: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
      return;
    }

    const requestParsed = McpBridgeIpcRequestSchema.safeParse(parsedJson);
    if (!requestParsed.success) {
      const candidateId =
        typeof parsedJson === 'object' &&
        parsedJson !== null &&
        'id' in parsedJson &&
        typeof parsedJson.id === 'string'
          ? parsedJson.id
          : 'unknown';
      this.writeResponse(socket, {
        id: candidateId,
        ok: false,
        error: {
          code: NUH_ERROR_CODES.INVALID_PARAMS,
          message: `Invalid IPC request schema: ${requestParsed.error.message}`,
        },
      });
      return;
    }

    const request = requestParsed.data;
    if (this.disposed) {
      this.writeResponse(socket, {
        id: request.id,
        ok: false,
        error: {
          code: NUH_ERROR_CODES.INTERNAL_ERROR,
          message: 'NUH MCP Bridge IPC server is shutting down',
        },
      });
      return;
    }

    if (request.method === 'tools/list') {
      try {
        const rawTools = await this.provider.listTools();
        const safeTools: McpBridgeWireTool[] = rawTools.map((tool) => {
          if (tool.readOnly !== true) {
            throw new Error(`Tool "${tool.name}" rejected: readOnly must be true`);
          }
          return {
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            readOnly: true,
          };
        });
        this.writeResponse(socket, {
          id: request.id,
          ok: true,
          result: { tools: safeTools },
        });
      } catch (error) {
        this.writeResponse(socket, {
          id: request.id,
          ok: false,
          error: {
            code: NUH_ERROR_CODES.INTERNAL_ERROR,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
      return;
    }

    const controller = new AbortController();
    this.activeCalls.add(controller);
    try {
      const listed = await this.provider.listTools();
      const target = listed.find((tool) => tool.name === request.params.name);
      if (target?.readOnly !== true) {
        this.writeResponse(socket, {
          id: request.id,
          ok: false,
          error: {
            code: NUH_ERROR_CODES.INVALID_PARAMS,
            message: `Tool "${request.params.name}" is not exposed as a read-only MCP bridge tool`,
          },
        });
        return;
      }

      const outcome = await this.provider.callTool(request.params.name, request.params.arguments, {
        ...(request.params.cwd ? { cwd: request.params.cwd } : {}),
        signal: controller.signal,
      });
      this.writeResponse(socket, {
        id: request.id,
        ok: true,
        result: outcome,
      });
    } catch (error) {
      this.writeResponse(socket, {
        id: request.id,
        ok: false,
        error: {
          code: NUH_ERROR_CODES.INTERNAL_ERROR,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      this.activeCalls.delete(controller);
    }
  }

  private writeResponse(socket: net.Socket, response: McpBridgeIpcResponse): void {
    if (socket.destroyed || !socket.writable) {
      return;
    }
    socket.write(`${JSON.stringify(response)}\n`);
  }

  private logError(message: string): void {
    if (!this.stderr.writableEnded) {
      this.stderr.write(`[nuh-mcp-bridge-ipc] ${message}\n`);
    }
  }
}
