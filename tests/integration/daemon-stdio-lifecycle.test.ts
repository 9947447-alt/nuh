import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  classifyJsonRpcMessage,
  InitializeResultSchema,
  type JsonRpcErrorObject,
  type JsonRpcId,
  NUH_ERROR_CODES,
  NUH_PROTOCOL_VERSION,
  type NuhNotification,
  parseNdjsonJson,
  parseNuhNotification,
  serializeNdjsonLine,
  ThreadResumeResultSchema,
  ThreadStartResultSchema,
  TurnInterruptResultSchema,
  TurnStartResultSchema,
} from '@nuh/protocol';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DAEMON_BIN = path.join(ROOT_DIR, 'packages/core/dist/bin.js');
const CLI_REPL_BIN = path.join(ROOT_DIR, 'apps/cli-repl/dist/bin.js');

interface DaemonHarness {
  readonly child: ChildProcessWithoutNullStreams;
  readonly dshHome: string;
  readonly nuhHome: string;
  readonly notifications: NuhNotification[];
  readonly stderrLines: string[];
  sendRawLine(line: string): void;
  sendNotification(method: string, params?: unknown): void;
  request(method: string, params: unknown, id?: JsonRpcId): Promise<unknown>;
  requestExpectError(rawFrame: unknown): Promise<{
    readonly id: JsonRpcId | null;
    readonly error: JsonRpcErrorObject;
  }>;
  waitForNotification(
    predicate: (notif: NuhNotification) => boolean,
    timeoutMs?: number,
  ): Promise<NuhNotification>;
  waitForExit(
    timeoutMs?: number,
  ): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
}

function spawnDaemonHarness(
  tempDirs: string[],
  envOverrides: Record<string, string> = {},
): DaemonHarness {
  const baseDir = mkdtempSync(path.join(tmpdir(), 'nuh-daemon-int-'));
  tempDirs.push(baseDir);
  const dshHome = path.join(baseDir, 'dsh');
  const nuhHome = path.join(baseDir, 'nuh');

  const child = spawn(process.execPath, [DAEMON_BIN], {
    cwd: ROOT_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      NUH_HOME: nuhHome,
      DSH_TELEMETRY_DISABLED: '1',
      NUH_DISABLE_EXTERNAL_LLM: '1',
      ...envOverrides,
    },
  });

  const notifications: NuhNotification[] = [];
  const stderrLines: string[] = [];
  const pendingResponses = new Map<
    JsonRpcId,
    {
      resolve: (
        res:
          | { ok: true; result: unknown }
          | { ok: false; id: JsonRpcId | null; error: JsonRpcErrorObject },
      ) => void;
    }
  >();
  const nullErrorWaiters: Array<
    (err: { id: JsonRpcId | null; error: JsonRpcErrorObject }) => void
  > = [];
  const notificationWaiters: Array<{
    predicate: (notif: NuhNotification) => boolean;
    resolve: (notif: NuhNotification) => void;
  }> = [];

  let nextId = 1;

  const stderrRl = createInterface({ input: child.stderr, crlfDelay: Infinity });
  stderrRl.on('line', (line) => {
    stderrLines.push(line);
  });

  const stdoutRl = createInterface({ input: child.stdout, crlfDelay: Infinity });
  stdoutRl.on('line', (line) => {
    const raw = parseNdjsonJson(line);
    const frame = classifyJsonRpcMessage(raw, { requireJsonRpcVersion: true });
    if (frame.kind === 'response_success') {
      const waiter = pendingResponses.get(frame.message.id);
      if (waiter) {
        pendingResponses.delete(frame.message.id);
        waiter.resolve({ ok: true, result: frame.message.result });
      }
      return;
    }
    if (frame.kind === 'response_error') {
      const id = frame.message.id;
      if (id !== null) {
        const waiter = pendingResponses.get(id);
        if (waiter) {
          pendingResponses.delete(id);
          waiter.resolve({ ok: false, id, error: frame.message.error });
          return;
        }
      }
      const nullWaiter = nullErrorWaiters.shift();
      if (nullWaiter) {
        nullWaiter({ id, error: frame.message.error });
      }
      return;
    }
    if (frame.kind === 'notification') {
      const notif = parseNuhNotification(raw);
      notifications.push(notif);
      for (let i = notificationWaiters.length - 1; i >= 0; i -= 1) {
        const waiter = notificationWaiters[i];
        if (waiter?.predicate(notif)) {
          notificationWaiters.splice(i, 1);
          waiter.resolve(notif);
        }
      }
    }
  });

  const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve) => {
      child.on('exit', (code, signal) => {
        stdoutRl.close();
        stderrRl.close();
        resolve({ code, signal });
      });
    },
  );

  return {
    child,
    dshHome,
    nuhHome,
    notifications,
    stderrLines,
    sendRawLine(line: string) {
      child.stdin.write(line.endsWith('\n') ? line : `${line}\n`);
    },
    sendNotification(method: string, params?: unknown) {
      child.stdin.write(
        serializeNdjsonLine({
          jsonrpc: '2.0',
          method,
          ...(params !== undefined ? { params } : {}),
        }),
      );
    },
    async request(method: string, params: unknown, explicitId?: JsonRpcId): Promise<unknown> {
      const id = explicitId ?? nextId;
      if (explicitId === undefined) {
        nextId += 1;
      }
      const outcome = await new Promise<
        | { ok: true; result: unknown }
        | { ok: false; id: JsonRpcId | null; error: JsonRpcErrorObject }
      >((resolve) => {
        pendingResponses.set(id, { resolve });
        child.stdin.write(
          serializeNdjsonLine({
            jsonrpc: '2.0',
            id,
            method,
            params,
          }),
        );
      });
      if (!outcome.ok) {
        throw new Error(
          `Unexpected JSON-RPC error (${String(outcome.error.code)}): ${outcome.error.message}`,
        );
      }
      return outcome.result;
    },
    async requestExpectError(rawFrame: unknown) {
      const hasValidId =
        typeof rawFrame === 'object' &&
        rawFrame !== null &&
        !Array.isArray(rawFrame) &&
        'id' in rawFrame &&
        (typeof (rawFrame as Record<string, unknown>).id === 'number' ||
          typeof (rawFrame as Record<string, unknown>).id === 'string');

      if (hasValidId) {
        const id = (rawFrame as { id: JsonRpcId }).id;
        const outcome = await new Promise<
          | { ok: true; result: unknown }
          | { ok: false; id: JsonRpcId | null; error: JsonRpcErrorObject }
        >((resolve) => {
          pendingResponses.set(id, { resolve });
          child.stdin.write(serializeNdjsonLine(rawFrame));
        });
        assert.equal(outcome.ok, false);
        return { id: outcome.id, error: outcome.error };
      }

      return await new Promise<{ id: JsonRpcId | null; error: JsonRpcErrorObject }>((resolve) => {
        nullErrorWaiters.push(resolve);
        if (typeof rawFrame === 'string') {
          child.stdin.write(rawFrame.endsWith('\n') ? rawFrame : `${rawFrame}\n`);
        } else {
          child.stdin.write(serializeNdjsonLine(rawFrame));
        }
      });
    },
    waitForNotification(predicate, timeoutMs = 5000) {
      const existing = notifications.find(predicate);
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Timed out waiting for notification after ${String(timeoutMs)}ms`));
        }, timeoutMs);
        notificationWaiters.push({
          predicate,
          resolve: (notif) => {
            clearTimeout(timer);
            resolve(notif);
          },
        });
      });
    },
    async waitForExit(timeoutMs = 5000) {
      return await Promise.race([
        exitPromise,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Daemon exit timed out after ${String(timeoutMs)}ms`)),
            timeoutMs,
          ),
        ),
      ]);
    },
  };
}

describe('Fake Integration: built @nuh/core daemon & @nuh/cli-repl over stdio (no external LLM)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('completes initialize/initialized/thread/turn roundtrip and appends normalized events to ledger.jsonl', async () => {
    const harness = spawnDaemonHarness(tempDirs, { NUH_ECHO_STEP_MS: '5' });

    const initRes = InitializeResultSchema.parse(
      await harness.request('initialize', {
        clientInfo: { name: 'integration-test', version: '0.1.0' },
        protocolVersion: NUH_PROTOCOL_VERSION,
      }),
    );
    assert.equal(initRes.serverInfo.name, 'nuh-daemon');
    assert.equal(initRes.protocolVersion, NUH_PROTOCOL_VERSION);
    assert.ok(initRes.loadedDshPlugins.includes('settings'));
    assert.ok(initRes.loadedDshPlugins.includes('tools'));
    assert.equal(initRes.loadedDshPlugins.includes('hmr'), false);

    harness.sendNotification('initialized');

    const threadRes = ThreadStartResultSchema.parse(
      await harness.request('thread/start', {
        workdir: ROOT_DIR,
        defaultBackend: 'native-dsh',
      }),
    );

    const turnRes = TurnStartResultSchema.parse(
      await harness.request('turn/start', {
        threadId: threadRes.threadId,
        input: 'hello headless dsh',
      }),
    );
    assert.equal(turnRes.resolvedBackend, 'native-dsh');

    const completedNotif = await harness.waitForNotification(
      (n) => n.method === 'turn/completed' && n.params.turnId === turnRes.turnId,
    );
    assert.equal(completedNotif.method, 'turn/completed');
    if (completedNotif.method === 'turn/completed') {
      assert.equal(completedNotif.params.status, 'completed');
    }

    const turnEvents = harness.notifications.filter((n) => n.params.turnId === turnRes.turnId);
    assert.equal(turnEvents[0]?.method, 'turn/started');
    assert.equal(turnEvents[1]?.method, 'item/started');
    assert.ok(turnEvents.some((n) => n.method === 'item/delta'));
    assert.equal(turnEvents[turnEvents.length - 2]?.method, 'item/completed');
    assert.equal(turnEvents[turnEvents.length - 1]?.method, 'turn/completed');

    const deltaText = turnEvents
      .filter((n) => n.method === 'item/delta')
      .map((n) => (n.method === 'item/delta' ? n.params.delta : ''))
      .join('');
    assert.equal(deltaText, '[nuh-echo] hello headless dsh');

    const resumeRes = ThreadResumeResultSchema.parse(
      await harness.request('thread/resume', { threadId: threadRes.threadId }),
    );
    assert.equal(resumeRes.ledgerSummary.length, 2);
    assert.equal(resumeRes.ledgerSummary[0]?.summary, 'hello headless dsh');
    assert.equal(resumeRes.ledgerSummary[1]?.summary, '[nuh-echo] hello headless dsh');

    const ledgerPath = path.join(harness.nuhHome, 'threads', threadRes.threadId, 'ledger.jsonl');
    const ledgerLines = readFileSync(ledgerPath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { seq: number; kind: string });
    assert.ok(ledgerLines.length >= 6);
    assert.equal(ledgerLines[0]?.kind, 'thread/started');
    assert.equal(ledgerLines[1]?.kind, 'turn/input');
    assert.equal(ledgerLines[ledgerLines.length - 1]?.kind, 'turn/completed');
    for (let i = 0; i < ledgerLines.length; i += 1) {
      assert.equal(ledgerLines[i]?.seq, i + 1);
    }

    harness.child.stdin.end();
    const exitInfo = await harness.waitForExit();
    assert.equal(exitInfo.code, 0);
    assert.ok(
      harness.stderrLines.some(
        (line) =>
          line.includes('"event":"daemon_disposed"') && line.includes('"fiberDisposed":true'),
      ),
    );
  });

  it('deterministically cancels an in-flight turn on turn/interrupt and records cancellation in ledger', async () => {
    const harness = spawnDaemonHarness(tempDirs, { NUH_ECHO_STEP_MS: '300' });

    await harness.request('initialize', {
      clientInfo: { name: 'interrupt-test', version: '0.1.0' },
      protocolVersion: NUH_PROTOCOL_VERSION,
    });
    harness.sendNotification('initialized');

    const threadRes = ThreadStartResultSchema.parse(
      await harness.request('thread/start', { workdir: ROOT_DIR }),
    );

    const turnRes = TurnStartResultSchema.parse(
      await harness.request('turn/start', {
        threadId: threadRes.threadId,
        input: 'long running payload for deterministic cancellation test',
      }),
    );

    await harness.waitForNotification(
      (n) => n.method === 'item/delta' && n.params.turnId === turnRes.turnId,
    );

    const interruptRes = TurnInterruptResultSchema.parse(
      await harness.request('turn/interrupt', {
        threadId: threadRes.threadId,
        turnId: turnRes.turnId,
      }),
    );
    assert.equal(interruptRes.interrupted, true);

    const completedNotif = await harness.waitForNotification(
      (n) => n.method === 'turn/completed' && n.params.turnId === turnRes.turnId,
    );
    assert.equal(completedNotif.method, 'turn/completed');
    if (completedNotif.method === 'turn/completed') {
      assert.equal(completedNotif.params.status, 'interrupted');
    }

    const itemCompleted = harness.notifications.find(
      (n) => n.method === 'item/completed' && n.params.turnId === turnRes.turnId,
    );
    assert.ok(itemCompleted);
    if (itemCompleted?.method === 'item/completed') {
      assert.equal(itemCompleted.params.status, 'cancelled');
    }

    const ledgerPath = path.join(harness.nuhHome, 'threads', threadRes.threadId, 'ledger.jsonl');
    const ledgerText = readFileSync(ledgerPath, 'utf8');
    assert.ok(ledgerText.includes('"status":"cancelled"'));
    assert.ok(ledgerText.includes('"status":"interrupted"'));

    harness.child.stdin.end();
    const exitInfo = await harness.waitForExit();
    assert.equal(exitInfo.code, 0);
  });

  it('returns explicit JSON-RPC error codes for broken, unknown, and invalid requests', async () => {
    const harness = spawnDaemonHarness(tempDirs, { NUH_ECHO_STEP_MS: '1' });

    const parseErr = await harness.requestExpectError('{broken-ndjson');
    assert.equal(parseErr.id, null);
    assert.equal(parseErr.error.code, NUH_ERROR_CODES.PARSE_ERROR);

    const missingVerErr = await harness.requestExpectError({
      id: 10,
      method: 'initialize',
      params: {},
    });
    assert.equal(missingVerErr.id, 10);
    assert.equal(missingVerErr.error.code, NUH_ERROR_CODES.INVALID_REQUEST);

    const unknownMethodErr = await harness.requestExpectError({
      jsonrpc: '2.0',
      id: 11,
      method: 'unknown/method',
      params: {},
    });
    assert.equal(unknownMethodErr.id, 11);
    assert.equal(unknownMethodErr.error.code, NUH_ERROR_CODES.METHOD_NOT_FOUND);

    const invalidParamsErr = await harness.requestExpectError({
      jsonrpc: '2.0',
      id: 12,
      method: 'turn/start',
      params: { threadId: '', input: '' },
    });
    assert.equal(invalidParamsErr.id, 12);
    assert.equal(invalidParamsErr.error.code, NUH_ERROR_CODES.INVALID_PARAMS);

    const missingThreadErr = await harness.requestExpectError({
      jsonrpc: '2.0',
      id: 13,
      method: 'turn/start',
      params: { threadId: 'nuh_thr_missing', input: 'ping' },
    });
    assert.equal(missingThreadErr.id, 13);
    assert.equal(missingThreadErr.error.code, NUH_ERROR_CODES.THREAD_NOT_FOUND);

    const threadRes = ThreadStartResultSchema.parse(
      await harness.request('thread/start', { workdir: ROOT_DIR }),
    );
    const missingTurnErr = await harness.requestExpectError({
      jsonrpc: '2.0',
      id: 14,
      method: 'turn/interrupt',
      params: { threadId: threadRes.threadId, turnId: 'nuh_turn_missing' },
    });
    assert.equal(missingTurnErr.id, 14);
    assert.equal(missingTurnErr.error.code, NUH_ERROR_CODES.TURN_NOT_FOUND);

    const unavailableBackendErr = await harness.requestExpectError({
      jsonrpc: '2.0',
      id: 15,
      method: 'turn/start',
      params: { threadId: threadRes.threadId, input: 'ping', backendOverride: 'codex' },
    });
    assert.equal(unavailableBackendErr.id, 15);
    assert.equal(unavailableBackendErr.error.code, NUH_ERROR_CODES.BACKEND_UNAVAILABLE);

    const unknownNotifErr = await harness.requestExpectError({
      jsonrpc: '2.0',
      method: 'unknown/notification',
    });
    assert.equal(unknownNotifErr.id, null);
    assert.equal(unknownNotifErr.error.code, NUH_ERROR_CODES.METHOD_NOT_FOUND);

    harness.child.stdin.end();
    const exitInfo = await harness.waitForExit();
    assert.equal(exitInfo.code, 0);
  });

  it('cleans up active turns and disposes Cordis fiber gracefully on SIGTERM', async () => {
    const harness = spawnDaemonHarness(tempDirs, { NUH_ECHO_STEP_MS: '400' });

    await harness.request('initialize', {
      clientInfo: { name: 'signal-test', version: '0.1.0' },
      protocolVersion: NUH_PROTOCOL_VERSION,
    });
    harness.sendNotification('initialized');

    const threadRes = ThreadStartResultSchema.parse(
      await harness.request('thread/start', { workdir: ROOT_DIR }),
    );
    const turnRes = TurnStartResultSchema.parse(
      await harness.request('turn/start', {
        threadId: threadRes.threadId,
        input: 'in flight turn before sigterm',
      }),
    );

    await harness.waitForNotification(
      (n) => n.method === 'turn/started' && n.params.turnId === turnRes.turnId,
    );

    harness.child.kill('SIGTERM');
    const exitInfo = await harness.waitForExit();
    assert.equal(exitInfo.code, 0);
    assert.ok(
      harness.stderrLines.some(
        (line) =>
          line.includes('"event":"daemon_disposed"') &&
          line.includes('"reason":"SIGTERM"') &&
          line.includes('"fiberDisposed":true'),
      ),
    );
  });

  it('drives @nuh/cli-repl subprocess end-to-end against built daemon without external LLM', async () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'nuh-repl-int-'));
    tempDirs.push(baseDir);

    const child = spawn(process.execPath, [CLI_REPL_BIN, '--daemon', DAEMON_BIN], {
      cwd: ROOT_DIR,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        DSH_HOME: path.join(baseDir, 'dsh'),
        NUH_HOME: path.join(baseDir, 'nuh'),
        DSH_TELEMETRY_DISABLED: '1',
        NUH_DISABLE_EXTERNAL_LLM: '1',
        NUH_ECHO_STEP_MS: '5',
      },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.stdin.write('hello from cli-repl integration\n');
    child.stdin.write('/threads\n');
    child.stdin.write('/quit\n');
    child.stdin.end();

    const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('cli-repl timed out')), 8000);
        child.on('exit', (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      },
    );

    assert.equal(exitInfo.code, 0, `stderr was: ${stderr}`);
    assert.ok(stdout.includes('[connected] nuh-daemon v0.1.0'));
    assert.ok(stdout.includes('[nuh-echo] hello from cli-repl integration'));
    assert.ok(stdout.includes('completed]'));
  });
});
