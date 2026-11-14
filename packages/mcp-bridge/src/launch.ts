import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCP_BRIDGE_DEFAULT_SERVER_NAME, type McpBridgeLaunchSpec } from './ipc.ts';

/**
 * Resolves the compiled stdio MCP proxy script (`dist/bin.js`) so external
 * CLIs (`codex`, `agy`) can spawn it reliably regardless of `--conditions=development`.
 */
export function resolveMcpBridgeBinPath(): string {
  const currentFile = fileURLToPath(import.meta.url);
  const currentDir = path.dirname(currentFile);
  const candidates = [path.join(currentDir, 'bin.js'), path.resolve(currentDir, '../dist/bin.js')];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    `NUH MCP Bridge stdio entrypoint not found (expected built dist/bin.js; checked ${candidates.join(', ')}). Run pnpm --filter @nuh/mcp-bridge build.`,
  );
}

export interface CreateMcpBridgeLaunchSpecOptions {
  readonly socketPath: string;
  readonly cwd?: string;
  readonly serverName?: string;
  readonly binPath?: string;
  readonly nodeCommand?: string;
}

export function createMcpBridgeLaunchSpec(
  options: CreateMcpBridgeLaunchSpecOptions,
): McpBridgeLaunchSpec {
  const binPath = options.binPath ?? resolveMcpBridgeBinPath();
  const env: Record<string, string> = {
    NUH_MCP_SOCKET: options.socketPath,
  };
  if (options.cwd) {
    env.NUH_MCP_CWD = options.cwd;
  }
  return {
    serverName: options.serverName ?? MCP_BRIDGE_DEFAULT_SERVER_NAME,
    command: options.nodeCommand ?? process.execPath,
    args: [binPath],
    env,
  };
}
