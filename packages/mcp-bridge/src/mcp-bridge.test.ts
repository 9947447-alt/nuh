import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { describe, it } from 'node:test';
import {
  createMcpBridgeLaunchSpec,
  MCP_BRIDGE_DEFAULT_SERVER_NAME,
  McpBridgeIpcClient,
  McpBridgeIpcServer,
  type McpBridgeToolProvider,
  type McpBridgeToolSpec,
  resolveMcpBridgeSocketPath,
} from './index.ts';

function createNullStderr(): Writable {
  return new Writable({
    write(_chunk, _encoding, cb) {
      cb();
    },
  });
}

describe('@nuh/mcp-bridge IPC server and reconnect client', () => {
  it('resolves macOS-safe Unix socket paths within 96 bytes', () => {
    const longHome = path.join(os.tmpdir(), 'a'.repeat(110));
    const sockPath = resolveMcpBridgeSocketPath(longHome);
    assert.ok(Buffer.byteLength(sockPath, 'utf8') <= 96, `too long: ${sockPath}`);
  });

  it('serves concurrent clients, rejects unlisted write tools, reconnects after restart, and unlinks socket', async () => {
    const tempDir = mkdtempSync('/tmp/nuh-mcp-unit-');
    const socketPath = path.join(tempDir, 'bridge.sock');

    const tools: McpBridgeToolSpec[] = [
      {
        name: 'mnemon_recall',
        description: 'Recall durable memory',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
        readOnly: true,
      },
      {
        name: 'mnemon_status',
        description: 'Check memory health',
        inputSchema: { type: 'object', properties: {} },
        readOnly: true,
      },
    ];

    let callSeq = 0;
    const provider: McpBridgeToolProvider = {
      listTools: () => tools,
      callTool: async (name, args, options) => {
        callSeq += 1;
        return {
          isError: false,
          text: `ok:${name}:${callSeq}:${String(args.query ?? '')}`,
          structuredContent: {
            name,
            seq: callSeq,
            cwd: options?.cwd ?? null,
          },
        };
      },
    };

    const server1 = await McpBridgeIpcServer.start({
      socketPath,
      provider,
      stderr: createNullStderr(),
    });
    assert.equal(existsSync(socketPath), true);

    const clientA = new McpBridgeIpcClient(socketPath, 5_000);
    const clientB = new McpBridgeIpcClient(socketPath, 5_000);

    try {
      const [listA, listB] = await Promise.all([clientA.listTools(), clientB.listTools()]);
      assert.equal(listA.tools.length, 2);
      assert.equal(listB.tools.length, 2);
      assert.equal(listA.tools[0]?.readOnly, true);

      const [resA, resB] = await Promise.all([
        clientA.callTool({
          name: 'mnemon_recall',
          arguments: { query: 'alpha' },
          cwd: '/tmp/ws-a',
        }),
        clientB.callTool({ name: 'mnemon_status', arguments: {} }),
      ]);
      assert.equal(resA.isError, false);
      assert.ok(resA.text.includes('alpha'));
      assert.equal(resA.structuredContent?.cwd, '/tmp/ws-a');
      assert.equal(resB.isError, false);

      await assert.rejects(
        () => clientA.callTool({ name: 'mnemon_remember', arguments: { content: 'mutating' } }),
        /not exposed as a read-only/,
      );

      // Simulate Daemon IPC restart on the same socket path and confirm clientA reconnects cleanly.
      await server1.dispose();
      assert.equal(existsSync(socketPath), false);

      const server2 = await McpBridgeIpcServer.start({
        socketPath,
        provider,
        stderr: createNullStderr(),
      });
      try {
        const resAfterRestart = await clientA.callTool({
          name: 'mnemon_recall',
          arguments: { query: 'reconnected' },
        });
        assert.equal(resAfterRestart.isError, false);
        assert.ok(resAfterRestart.text.includes('reconnected'));
      } finally {
        await server2.dispose();
        assert.equal(existsSync(socketPath), false);
      }
    } finally {
      clientA.close();
      clientB.close();
      await server1.dispose();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('creates launch spec targeting the compiled dist/bin.js', () => {
    const spec = createMcpBridgeLaunchSpec({
      socketPath: '/tmp/test.sock',
      cwd: '/tmp/work',
    });
    assert.equal(spec.serverName, MCP_BRIDGE_DEFAULT_SERVER_NAME);
    assert.equal(spec.command, process.execPath);
    assert.ok(spec.args[0]?.endsWith(path.join('dist', 'bin.js')));
    assert.deepEqual(spec.env, {
      NUH_MCP_SOCKET: '/tmp/test.sock',
      NUH_MCP_CWD: '/tmp/work',
    });
  });
});
