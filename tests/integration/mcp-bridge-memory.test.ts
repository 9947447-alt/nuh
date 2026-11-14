import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  McpBridgeIpcServer,
  type McpBridgeToolProvider,
  type McpBridgeToolSpec,
  resolveMcpBridgeBinPath,
} from '@nuh/mcp-bridge';
import {
  classifyJsonRpcMessage,
  InitializeResultSchema,
  type JsonRpcId,
  NUH_PROTOCOL_VERSION,
  type NuhNotification,
  parseNdjsonJson,
  parseNuhNotification,
  serializeNdjsonLine,
  ThreadSetBackendResultSchema,
  ThreadStartResultSchema,
} from '@nuh/protocol';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const DAEMON_BIN = path.join(REPO_ROOT, 'packages/core/dist/bin.js');
const FAKE_CODEX_MCP = path.join(__dirname, 'fakes/fake-codex-mcp.mjs');
const FAKE_AGY_MCP = path.join(__dirname, 'fakes/fake-agy-mcp.mjs');

class StdioMcpProxyHarness {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  private seq = 0;

  constructor(socketPath: string, cwd: string) {
    this.child = spawn(process.execPath, [resolveMcpBridgeBinPath()], {
      env: {
        ...process.env,
        NUH_MCP_SOCKET: socketPath,
        NUH_MCP_CWD: cwd,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const rl = createInterface({ input: this.child.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      const parsed = JSON.parse(trimmed) as {
        id?: number;
        result?: unknown;
        error?: { code?: number; message?: string };
      };
      if (parsed.id !== undefined && this.pending.has(parsed.id)) {
        const entry = this.pending.get(parsed.id);
        this.pending.delete(parsed.id);
        if (!entry) {
          return;
        }
        if (parsed.error) {
          entry.reject(
            new Error(`${parsed.error.message ?? 'MCP error'} (code=${String(parsed.error.code)})`),
          );
        } else {
          entry.resolve(parsed.result);
        }
      }
    });

    this.exitPromise = new Promise((resolve) => {
      this.child.once('exit', (code, signal) => {
        rl.close();
        for (const [id, entry] of this.pending.entries()) {
          this.pending.delete(id);
          entry.reject(new Error(`stdio proxy exited unexpectedly (code=${String(code)})`));
        }
        resolve({ code, signal });
      });
    });
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'integration-test', version: '0.1.0' },
    });
    this.notify('notifications/initialized', {});
  }

  async close(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (!this.child.stdin.destroyed && this.child.stdin.writable) {
      this.child.stdin.end();
    }
    const timer = setTimeout(() => {
      if (this.child.exitCode === null) {
        this.child.kill('SIGTERM');
      }
    }, 3_000);
    const result = await this.exitPromise;
    clearTimeout(timer);
    return result;
  }
}

class NuhDaemonHarness {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exitPromise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly pending = new Map<
    JsonRpcId,
    { resolve: (result: unknown) => void; reject: (err: Error) => void }
  >();
  private readonly notifications: NuhNotification[] = [];
  private readonly waiters: Array<() => void> = [];
  private nextId = 1;

  constructor(nuhHome: string, dshHome: string, homeDir: string) {
    this.child = spawn(process.execPath, [DAEMON_BIN], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HOME: homeDir,
        DSH_HOME: dshHome,
        NUH_HOME: nuhHome,
        DSH_TELEMETRY_DISABLED: '1',
        NUH_DISABLE_EXTERNAL_LLM: '1',
        NUH_CODEX_BIN: FAKE_CODEX_MCP,
        NUH_AGY_BIN: FAKE_AGY_MCP,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutRl = createInterface({ input: this.child.stdout });
    stdoutRl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      const msg = parseNdjsonJson(trimmed);
      const frame = classifyJsonRpcMessage(msg, { requireJsonRpcVersion: true });
      if (frame.kind === 'response_success') {
        const entry = this.pending.get(frame.message.id);
        this.pending.delete(frame.message.id);
        entry?.resolve(frame.message.result);
        return;
      }
      if (frame.kind === 'response_error') {
        if (frame.message.id !== null) {
          const entry = this.pending.get(frame.message.id);
          this.pending.delete(frame.message.id);
          entry?.reject(
            new Error(`${frame.message.error.message} (code=${String(frame.message.error.code)})`),
          );
        }
        return;
      }
      if (frame.kind === 'notification') {
        this.notifications.push(parseNuhNotification(msg));
        for (const wake of this.waiters.splice(0, this.waiters.length)) {
          wake();
        }
      }
    });

    this.exitPromise = new Promise((resolve) => {
      this.child.once('exit', (code, signal) => {
        stdoutRl.close();
        for (const [id, entry] of this.pending.entries()) {
          this.pending.delete(id);
          entry.reject(new Error(`Daemon exited while request ${String(id)} pending`));
        }
        for (const wake of this.waiters.splice(0, this.waiters.length)) {
          wake();
        }
        resolve({ code, signal });
      });
    });
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(serializeNdjsonLine({ jsonrpc: '2.0', id, method, params }));
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.child.stdin.write(
      serializeNdjsonLine({
        jsonrpc: '2.0',
        method,
        ...(params !== undefined ? { params } : {}),
      }),
    );
  }

  async waitForNotification(
    predicate: (note: NuhNotification) => boolean,
    timeoutMs = 15_000,
  ): Promise<NuhNotification> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const hit = this.notifications.find(predicate);
      if (hit) {
        return hit;
      }
      if (this.child.exitCode !== null) {
        throw new Error('Daemon exited before expected notification');
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error('Timed out waiting for daemon notification');
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, 100));
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  allNotifications(): readonly NuhNotification[] {
    return this.notifications;
  }

  turnMessageText(turnId: string): string {
    return this.notifications
      .filter((n) => n.method === 'item/delta' && n.params.turnId === turnId)
      .map((n) => (n.method === 'item/delta' ? n.params.delta : ''))
      .join('');
  }

  async close(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    try {
      await this.request('shutdown', {});
    } catch {
      // Fall through to stdin close
    }
    if (!this.child.stdin.destroyed && this.child.stdin.writable) {
      this.child.stdin.end();
    }
    const timer = setTimeout(() => {
      if (this.child.exitCode === null) {
        this.child.kill('SIGKILL');
      }
    }, 5_000);
    const result = await this.exitPromise;
    clearTimeout(timer);
    return result;
  }
}

const cleanupPaths: string[] = [];

afterEach(() => {
  while (cleanupPaths.length > 0) {
    const target = cleanupPaths.pop();
    if (target) {
      rmSync(target, { recursive: true, force: true });
    }
  }
});

describe('MCP Bridge & dsh-mnemon integration', () => {
  it('supports concurrent stdio proxies, reconnection after IPC restart, read-only enforcement, and socket cleanup', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'nuh-int-mcp-'));
    cleanupPaths.push(tempDir);
    const socketPath = `/tmp/nuh-int-${process.pid}-${Date.now().toString(36)}.sock`;

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
        description: 'Status check',
        inputSchema: { type: 'object', properties: {} },
        readOnly: true,
      },
    ];

    let generation = 1;
    const provider: McpBridgeToolProvider = {
      listTools: () => tools,
      callTool: async (name, args, options) => ({
        isError: false,
        text: JSON.stringify({ generation, name, args, cwd: options?.cwd ?? null }),
        structuredContent: { generation, name, cwd: options?.cwd ?? null },
      }),
    };

    const nullStderr = new Writable({
      write(_chunk, _enc, cb) {
        cb();
      },
    });

    const server1 = await McpBridgeIpcServer.start({ socketPath, provider, stderr: nullStderr });
    let server2: McpBridgeIpcServer | undefined;
    const proxy1 = new StdioMcpProxyHarness(socketPath, '/tmp/ws-one');
    const proxy2 = new StdioMcpProxyHarness(socketPath, '/tmp/ws-two');

    try {
      assert.equal(existsSync(socketPath), true);
      await Promise.all([proxy1.initialize(), proxy2.initialize()]);

      const [list1Raw, list2Raw] = await Promise.all([
        proxy1.request('tools/list'),
        proxy2.request('tools/list'),
      ]);
      const list1 = list1Raw as {
        tools: Array<{
          name: string;
          annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
        }>;
      };
      const list2 = list2Raw as { tools: Array<{ name: string }> };

      assert.deepEqual(
        list1.tools.map((t) => t.name),
        ['mnemon_recall', 'mnemon_status'],
      );
      assert.deepEqual(
        list2.tools.map((t) => t.name),
        ['mnemon_recall', 'mnemon_status'],
      );
      assert.equal(
        list1.tools.every(
          (t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false,
        ),
        true,
      );

      const [call1Raw, call2Raw] = await Promise.all([
        proxy1.request('tools/call', { name: 'mnemon_recall', arguments: { query: 'q1' } }),
        proxy2.request('tools/call', { name: 'mnemon_status', arguments: {} }),
      ]);
      const call1 = call1Raw as {
        isError: boolean;
        structuredContent?: { generation?: number; cwd?: string };
      };
      const call2 = call2Raw as {
        isError: boolean;
        structuredContent?: { generation?: number; cwd?: string };
      };
      assert.equal(call1.isError, false);
      assert.equal(call1.structuredContent?.generation, 1);
      assert.equal(call1.structuredContent?.cwd, '/tmp/ws-one');
      assert.equal(call2.isError, false);
      assert.equal(call2.structuredContent?.cwd, '/tmp/ws-two');

      await assert.rejects(
        () =>
          proxy1.request('tools/call', { name: 'mnemon_remember', arguments: { content: 'x' } }),
        /not exposed as a read-only/,
      );

      // Restart Daemon IPC at the same socket path and verify existing proxy1 reconnects seamlessly.
      await server1.dispose();
      assert.equal(existsSync(socketPath), false);

      generation = 2;
      server2 = await McpBridgeIpcServer.start({ socketPath, provider, stderr: nullStderr });
      const reconnectedCall = (await proxy1.request('tools/call', {
        name: 'mnemon_recall',
        arguments: { query: 'after-restart' },
      })) as { isError: boolean; structuredContent?: { generation?: number } };
      assert.equal(reconnectedCall.isError, false);
      assert.equal(reconnectedCall.structuredContent?.generation, 2);
    } finally {
      const [exit1, exit2] = await Promise.all([proxy1.close(), proxy2.close()]);
      assert.equal(exit1.code, 0);
      assert.equal(exit2.code, 0);
      await server2?.dispose();
      await server1.dispose();
      assert.equal(existsSync(socketPath), false);
    }
  });

  it('injects live dsh-mnemon MCP bridge dynamically into codex (-c) and agy (session/new + session/resume) and cleans up on shutdown', async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), 'nuh-int-daemon-mcp-'));
    cleanupPaths.push(tempRoot);
    const nuhHome = path.join(tempRoot, 'nuh-home');
    const dshHome = path.join(tempRoot, 'dsh-home');
    const fakeUserHome = path.join(tempRoot, 'user-home');
    const workdir = path.join(tempRoot, 'workspace');

    mkdirSync(nuhHome, { recursive: true });
    mkdirSync(dshHome, { recursive: true });
    mkdirSync(fakeUserHome, { recursive: true });
    mkdirSync(workdir, { recursive: true });

    const daemon = new NuhDaemonHarness(nuhHome, dshHome, fakeUserHome);
    try {
      const initResult = InitializeResultSchema.parse(
        await daemon.request('initialize', {
          protocolVersion: NUH_PROTOCOL_VERSION,
          clientInfo: { name: 'mcp-int-client', version: '0.1.0' },
        }),
      );
      assert.equal(initResult.protocolVersion, NUH_PROTOCOL_VERSION);
      daemon.notify('initialized');

      const started = ThreadStartResultSchema.parse(
        await daemon.request('thread/start', {
          defaultBackend: 'codex',
          workdir,
        }),
      );
      const threadId = started.threadId;

      // 1) Codex turn: verifies -c mcp_servers.nuh_memory=... injection + concurrent MCP bridges + ~/.codex untouched
      const turn1Started = (await daemon.request('turn/start', {
        threadId,
        input: 'check memory via codex',
      })) as { turnId: string };
      const turn1Done = await daemon.waitForNotification(
        (n) => n.method === 'turn/completed' && n.params.turnId === turn1Started.turnId,
      );
      const codexText = daemon.turnMessageText(turn1Started.turnId);
      assert.ok(
        codexText.length > 0,
        `expected codex agent delta summary; turn1Done=${JSON.stringify(turn1Done)}; notes=${JSON.stringify(daemon.allNotifications())}`,
      );
      const codexSummary = JSON.parse(codexText) as {
        backend: string;
        rawOverridePresent: boolean;
        toolNamesA: string[];
        toolNamesB: string[];
        allReadOnlyHints: boolean;
        memoryBodiesTotal: number;
        statusHealthy: boolean;
        docsQuery: string;
        blockedWriteError: string;
      };
      assert.equal(codexSummary.backend, 'codex');
      assert.equal(codexSummary.rawOverridePresent, true);
      assert.equal(codexSummary.allReadOnlyHints, true);
      assert.equal(
        new Set(codexSummary.toolNamesA).size,
        5,
        `expected 5 read-only tools, got ${codexSummary.toolNamesA.join(',')}`,
      );
      assert.ok(!codexSummary.toolNamesA.includes('mnemon_remember'));
      assert.equal(typeof codexSummary.memoryBodiesTotal, 'number');
      assert.equal(codexSummary.statusHealthy, true);
      assert.equal(codexSummary.docsQuery, 'test');
      assert.ok(codexSummary.blockedWriteError.includes('not exposed as a read-only'));
      assert.equal(existsSync(path.join(fakeUserHome, '.codex', 'config.toml')), false);

      // 2) Switch to AGY -> session/new receives mcpServers and talks to live Daemon dsh-mnemon
      ThreadSetBackendResultSchema.parse(
        await daemon.request('thread/setBackend', {
          threadId,
          backend: 'agy',
        }),
      );
      const turn2Started = (await daemon.request('turn/start', {
        threadId,
        input: 'check memory via agy session/new',
      })) as { turnId: string };
      await daemon.waitForNotification(
        (n) => n.method === 'turn/completed' && n.params.turnId === turn2Started.turnId,
      );

      const agyNewText = daemon.turnMessageText(turn2Started.turnId);
      assert.ok(agyNewText.length > 0, 'expected agy session/new delta summary');
      const agyNewSummary = JSON.parse(agyNewText) as {
        backend: string;
        sessionMethod: string;
        mcpServerCount: number;
        mcpServerName: string;
        toolNames: string[];
        allReadOnlyHints: boolean;
        statusHealthy: boolean;
        docsQuery: string;
      };
      assert.equal(agyNewSummary.backend, 'agy');
      assert.equal(agyNewSummary.sessionMethod, 'session/new');
      assert.equal(agyNewSummary.mcpServerCount, 1);
      assert.equal(agyNewSummary.mcpServerName, 'nuh_memory');
      assert.equal(agyNewSummary.allReadOnlyHints, true);
      assert.equal(agyNewSummary.statusHealthy, true);
      assert.equal(agyNewSummary.docsQuery, 'agy-check');

      // 3) Switch away and back to AGY so existing backendSessionId triggers session/resume with mcpServers
      ThreadSetBackendResultSchema.parse(
        await daemon.request('thread/setBackend', {
          threadId,
          backend: 'codex',
        }),
      );
      ThreadSetBackendResultSchema.parse(
        await daemon.request('thread/setBackend', {
          threadId,
          backend: 'agy',
        }),
      );

      const turn3Started = (await daemon.request('turn/start', {
        threadId,
        input: 'check memory via agy session/resume',
      })) as { turnId: string };
      await daemon.waitForNotification(
        (n) => n.method === 'turn/completed' && n.params.turnId === turn3Started.turnId,
      );

      const agyResumeText = daemon.turnMessageText(turn3Started.turnId);
      assert.ok(agyResumeText.length > 0, 'expected agy session/resume delta summary');
      const agyResumeSummary = JSON.parse(agyResumeText) as {
        sessionMethod: string;
        mcpServerName: string;
        statusHealthy: boolean;
      };
      assert.equal(agyResumeSummary.sessionMethod, 'session/resume');
      assert.equal(agyResumeSummary.mcpServerName, 'nuh_memory');
      assert.equal(agyResumeSummary.statusHealthy, true);
    } finally {
      const exit = await daemon.close();
      assert.equal(exit.code, 0);
      const runDir = path.join(nuhHome, 'run');
      if (existsSync(runDir)) {
        const remainingSocks = readdirSync(runDir).filter((f) => f.endsWith('.sock'));
        assert.deepEqual(remainingSocks, []);
      }
    }
  });
});
