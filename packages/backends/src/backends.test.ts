import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { NUH_ERROR_CODES, NuhProtocolError } from '@nuh/protocol';
import {
  AgyAcpBackend,
  buildAgyMcpServersPayload,
  buildCodexMcpCliArgs,
  ClaudeBackendPlaceholder,
  CodexBackend,
  createDefaultBackendRegistry,
  formatCodexMcpServerOverride,
  resolveBackendCommand,
} from './index.ts';

describe('@nuh/backends registry and command resolution', () => {
  it('returns explicit NOT_CONFIGURED error for claude placeholder', async () => {
    const claude = new ClaudeBackendPlaceholder();
    const status = await claude.getStatus();
    assert.equal(status.kind, 'claude');
    assert.equal(status.available, false);
    assert.equal(status.reason, 'NOT_CONFIGURED');

    await assert.rejects(
      () =>
        claude.runTurn({
          threadId: 'thr_1',
          turnId: 'turn_1',
          workdir: process.cwd(),
          prompt: 'hello',
          sandboxMode: 'workspace-write',
          approvalPolicy: 'on-request',
          signal: new AbortController().signal,
          emit: () => undefined,
          requestApproval: async () => ({ decision: 'deny' }),
        }),
      (err: unknown) =>
        err instanceof NuhProtocolError &&
        err.code === NUH_ERROR_CODES.BACKEND_UNAVAILABLE &&
        err.message.includes('NOT_CONFIGURED'),
    );
  });

  it('blocks auto-detecting real external CLIs when NUH_DISABLE_EXTERNAL_LLM=1 without explicit override', async () => {
    const prevDisable = process.env.NUH_DISABLE_EXTERNAL_LLM;
    const prevCodexBin = process.env.NUH_CODEX_BIN;
    const prevAgyBin = process.env.NUH_AGY_BIN;
    try {
      process.env.NUH_DISABLE_EXTERNAL_LLM = '1';
      delete process.env.NUH_CODEX_BIN;
      delete process.env.NUH_AGY_BIN;

      const codex = new CodexBackend();
      const agy = new AgyAcpBackend();
      const codexStatus = await codex.getStatus();
      const agyStatus = await agy.getStatus();

      assert.equal(codexStatus.available, false);
      assert.equal(agyStatus.available, false);

      const registry = createDefaultBackendRegistry();
      const statuses = await registry.listStatuses();
      assert.deepEqual(
        statuses.map((s) => s.kind),
        ['native-dsh', 'codex', 'claude', 'agy'],
      );
    } finally {
      if (prevDisable === undefined) {
        delete process.env.NUH_DISABLE_EXTERNAL_LLM;
      } else {
        process.env.NUH_DISABLE_EXTERNAL_LLM = prevDisable;
      }
      if (prevCodexBin === undefined) {
        delete process.env.NUH_CODEX_BIN;
      } else {
        process.env.NUH_CODEX_BIN = prevCodexBin;
      }
      if (prevAgyBin === undefined) {
        delete process.env.NUH_AGY_BIN;
      } else {
        process.env.NUH_AGY_BIN = prevAgyBin;
      }
    }
  });

  it('rejects non-existent explicit backend binary path cleanly', () => {
    const resolved = resolveBackendCommand({
      explicitCommand: '/nonexistent/path/to/fake-cli',
      envBinVar: 'NUH_CODEX_BIN',
      envArgsVar: 'NUH_CODEX_ARGS',
      defaultCommand: 'codex',
      defaultArgs: ['app-server', '--stdio'],
    });
    assert.equal(resolved.available, false);
    assert.ok(resolved.reason?.includes('not found'));
  });

  it('formats Codex -c mcp_servers overrides and AGY ACP mcpServers payloads deterministically', () => {
    const server = {
      name: 'nuh_memory',
      command: '/usr/local/bin/node',
      args: ['/tmp/nuh/dist/bin.js'],
      env: {
        NUH_MCP_SOCKET: '/tmp/nuh-mcp.sock',
        NUH_MCP_CWD: '/tmp/repo',
      },
    };
    const servers = [server];

    assert.equal(
      formatCodexMcpServerOverride(server),
      'mcp_servers.nuh_memory={command="/usr/local/bin/node",args=["/tmp/nuh/dist/bin.js"],env={NUH_MCP_CWD="/tmp/repo",NUH_MCP_SOCKET="/tmp/nuh-mcp.sock"}}',
    );
    assert.deepEqual(buildCodexMcpCliArgs(servers), [
      '-c',
      'mcp_servers.nuh_memory={command="/usr/local/bin/node",args=["/tmp/nuh/dist/bin.js"],env={NUH_MCP_CWD="/tmp/repo",NUH_MCP_SOCKET="/tmp/nuh-mcp.sock"}}',
    ]);
    assert.throws(
      () =>
        formatCodexMcpServerOverride({
          name: 'bad-name',
          command: '/bin/node',
          args: [],
        }),
      /Invalid Codex MCP server name/,
    );

    assert.deepEqual(buildAgyMcpServersPayload(servers), [
      {
        name: 'nuh_memory',
        command: '/usr/local/bin/node',
        args: ['/tmp/nuh/dist/bin.js'],
        env: [
          { name: 'NUH_MCP_CWD', value: '/tmp/repo' },
          { name: 'NUH_MCP_SOCKET', value: '/tmp/nuh-mcp.sock' },
        ],
      },
    ]);
  });
});
