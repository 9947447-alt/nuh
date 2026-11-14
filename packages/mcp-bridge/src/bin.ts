#!/usr/bin/env node
import { startMcpBridgeStdioProxy } from './stdio-proxy.ts';

async function main(): Promise<void> {
  const socketPath = process.env.NUH_MCP_SOCKET?.trim();
  if (!socketPath) {
    process.stderr.write('[nuh-mcp-bridge] Missing required environment variable NUH_MCP_SOCKET\n');
    process.exitCode = 1;
    return;
  }

  const cwd = process.env.NUH_MCP_CWD?.trim() || undefined;
  const proxy = await startMcpBridgeStdioProxy({
    socketPath,
    ...(cwd ? { cwd } : {}),
  });

  let closed = false;
  const shutdown = async () => {
    if (closed) {
      return;
    }
    closed = true;
    await proxy.close();
  };

  process.stdin.once('end', () => {
    void shutdown();
  });
  process.stdin.once('close', () => {
    void shutdown();
  });
  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[nuh-mcp-bridge] Fatal startup error: ${message}\n`);
  process.exitCode = 1;
});
