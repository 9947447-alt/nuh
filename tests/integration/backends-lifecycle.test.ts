import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type ApprovalDecision,
  type ApprovalRequestedParams,
  classifyJsonRpcMessage,
  InitializeResultSchema,
  type JsonRpcErrorObject,
  type JsonRpcId,
  NUH_ERROR_CODES,
  NUH_PROTOCOL_VERSION,
  type NuhNotification,
  parseNdjsonJson,
  parseNuhNotification,
  parseNuhServerRequest,
  serializeNdjsonLine,
  ThreadSetBackendResultSchema,
  ThreadStartResultSchema,
  TurnInterruptResultSchema,
  TurnStartResultSchema,
} from '@nuh/protocol';

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DAEMON_BIN = path.join(ROOT_DIR, 'packages/core/dist/bin.js');
const CLI_REPL_BIN = path.join(ROOT_DIR, 'apps/cli-repl/dist/bin.js');
const FAKE_CODEX_BIN = path.join(ROOT_DIR, 'tests/integration/fakes/fake-codex.mjs');
const FAKE_AGY_BIN = path.join(ROOT_DIR, 'tests/integration/fakes/fake-agy.mjs');

interface DaemonWithBackendsHarness {
  readonly child: ChildProcessWithoutNullStreams;
  readonly baseDir: string;
  readonly nuhHome: string;
  readonly codexPidLog: string;
  readonly agyPidLog: string;
  readonly notifications: NuhNotification[];
  readonly approvalRequests: ApprovalRequestedParams[];
  readonly stderrLines: string[];
  setApprovalHandler(
    handler: (params: ApprovalRequestedParams) => ApprovalDecision | Promise<ApprovalDecision>,
  ): void;
  sendNotification(method: string, params?: unknown): void;
  request(method: string, params: unknown, id?: JsonRpcId): Promise<unknown>;
  requestExpectError(
    method: string,
    params: unknown,
    id?: JsonRpcId,
  ): Promise<{ readonly id: JsonRpcId | null; readonly error: JsonRpcErrorObject }>;
  waitForNotification(
    predicate: (notif: NuhNotification) => boolean,
    timeoutMs?: number,
  ): Promise<NuhNotification>;
  waitForExit(
    timeoutMs?: number,
  ): Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
}

function spawnDaemonWithFakes(
  tempDirs: string[],
  spawnedChildren: ChildProcessWithoutNullStreams[],
  envOverrides: Record<string, string> = {},
): DaemonWithBackendsHarness {
  const baseDir = mkdtempSync(path.join(tmpdir(), 'nuh-backends-int-'));
  tempDirs.push(baseDir);
  const dshHome = path.join(baseDir, 'dsh');
  const nuhHome = path.join(baseDir, 'nuh');
  const codexPidLog = path.join(baseDir, 'codex-pids.log');
  const agyPidLog = path.join(baseDir, 'agy-pids.log');

  const child = spawn(process.execPath, [DAEMON_BIN], {
    cwd: ROOT_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DSH_HOME: dshHome,
      NUH_HOME: nuhHome,
      DSH_TELEMETRY_DISABLED: '1',
      NUH_DISABLE_EXTERNAL_LLM: '1',
      NUH_CODEX_BIN: FAKE_CODEX_BIN,
      NUH_AGY_BIN: FAKE_AGY_BIN,
      NUH_FAKE_CODEX_PID_LOG: codexPidLog,
      NUH_FAKE_AGY_PID_LOG: agyPidLog,
      ...envOverrides,
    },
  });
  spawnedChildren.push(child);

  const notifications: NuhNotification[] = [];
  const approvalRequests: ApprovalRequestedParams[] = [];
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
  const notificationWaiters: Array<{
    predicate: (notif: NuhNotification) => boolean;
    resolve: (notif: NuhNotification) => void;
  }> = [];

  let nextId = 1;
  let approvalHandler: (
    params: ApprovalRequestedParams,
  ) => ApprovalDecision | Promise<ApprovalDecision> = () => 'deny';

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
        }
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
      return;
    }
    if (frame.kind === 'request') {
      const srvReq = parseNuhServerRequest(raw);
      approvalRequests.push(srvReq.params);
      void Promise.resolve(approvalHandler(srvReq.params)).then((decision) => {
        if (!child.stdin.writableEnded && !child.stdin.destroyed) {
          child.stdin.write(
            serializeNdjsonLine({
              jsonrpc: '2.0',
              id: srvReq.id,
              result: { decision },
            }),
          );
        }
      });
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
    baseDir,
    nuhHome,
    codexPidLog,
    agyPidLog,
    notifications,
    approvalRequests,
    stderrLines,
    setApprovalHandler(handler) {
      approvalHandler = handler;
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
    async requestExpectError(method: string, params: unknown, explicitId?: JsonRpcId) {
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
      assert.equal(outcome.ok, false);
      return { id: outcome.id, error: outcome.error };
    },
    waitForNotification(predicate, timeoutMs = 8000) {
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
    async waitForExit(timeoutMs = 8000) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          exitPromise,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Daemon exit timed out after ${String(timeoutMs)}ms`)),
              timeoutMs,
            );
          }),
        ]);
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    },
  };
}

function readLoggedPids(pidFile: string): number[] {
  if (!existsSync(pidFile)) {
    return [];
  }
  return readFileSync(pidFile, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('Fake Integration: codex & agy backends, bidirectional approvals, handoff & cleanup', () => {
  const tempDirs: string[] = [];
  const spawnedChildren: ChildProcessWithoutNullStreams[] = [];

  afterEach(() => {
    while (spawnedChildren.length > 0) {
      const child = spawnedChildren.pop();
      if (child && child.exitCode === null && !child.killed) {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        child.kill('SIGKILL');
      }
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('runs codex streaming, approval allow/deny, and archives full item/* history despite summary turn/completed', async () => {
    const harness = spawnDaemonWithFakes(tempDirs, spawnedChildren);

    const initRes = InitializeResultSchema.parse(
      await harness.request('initialize', {
        clientInfo: { name: 'codex-int-test', version: '0.1.0' },
        protocolVersion: NUH_PROTOCOL_VERSION,
      }),
    );
    const codexStatus = initRes.backends.find((b) => b.kind === 'codex');
    const agyStatus = initRes.backends.find((b) => b.kind === 'agy');
    const claudeStatus = initRes.backends.find((b) => b.kind === 'claude');
    assert.equal(codexStatus?.available, true);
    assert.equal(agyStatus?.available, true);
    assert.equal(claudeStatus?.available, false);
    assert.equal(claudeStatus?.reason, 'NOT_CONFIGURED');

    harness.sendNotification('initialized');

    const threadRes = ThreadStartResultSchema.parse(
      await harness.request('thread/start', {
        workdir: ROOT_DIR,
        defaultBackend: 'codex',
      }),
    );

    // 1) Allow approval
    harness.setApprovalHandler(() => 'allow_once');
    const turn1 = TurnStartResultSchema.parse(
      await harness.request('turn/start', {
        threadId: threadRes.threadId,
        input: 'NEED_APPROVAL allow test',
      }),
    );
    assert.equal(turn1.resolvedBackend, 'codex');

    const turn1Done = await harness.waitForNotification(
      (n) => n.method === 'turn/completed' && n.params.turnId === turn1.turnId,
    );
    assert.equal(turn1Done.method, 'turn/completed');
    if (turn1Done.method === 'turn/completed') {
      assert.equal(turn1Done.params.status, 'completed');
      assert.equal(turn1Done.params.usage?.backend, 'codex');
      assert.equal(turn1Done.params.usage?.totalTokens, 120);
    }

    const turn1Events = harness.notifications.filter((n) => n.params.turnId === turn1.turnId);
    assert.ok(
      turn1Events.some((n) => n.method === 'item/started' && n.params.kind === 'command_exec'),
    );
    assert.ok(
      turn1Events.some(
        (n) => n.method === 'item/delta' && n.params.delta.includes('FAKE_CODEX_CMD_OK'),
      ),
    );
    assert.ok(turn1Events.some((n) => n.method === 'item/completed' && n.params.status === 'ok'));

    // 2) Deny approval
    harness.setApprovalHandler(() => 'deny');
    const turn2 = TurnStartResultSchema.parse(
      await harness.request('turn/start', {
        threadId: threadRes.threadId,
        input: 'NEED_APPROVAL deny test',
      }),
    );
    await harness.waitForNotification(
      (n) => n.method === 'turn/completed' && n.params.turnId === turn2.turnId,
    );
    const turn2Events = harness.notifications.filter((n) => n.params.turnId === turn2.turnId);
    assert.ok(
      turn2Events.some((n) => n.method === 'item/completed' && n.params.status === 'denied'),
    );

    harness.child.stdin.end();
    const exitInfo = await harness.waitForExit();
    assert.equal(exitInfo.code, 0);
  });

  it('runs agy acp --stdio with set_config_option, string request id permissions (allow & silent deny), and handoff summary', async () => {
    const harness = spawnDaemonWithFakes(tempDirs, spawnedChildren);

    await harness.request('initialize', {
      clientInfo: { name: 'agy-handoff-test', version: '0.1.0' },
      protocolVersion: NUH_PROTOCOL_VERSION,
    });
    harness.sendNotification('initialized');

    // Start on codex first to create canonical ledger history
    const threadRes = ThreadStartResultSchema.parse(
      await harness.request('thread/start', {
        workdir: ROOT_DIR,
        defaultBackend: 'codex',
      }),
    );

    const codexTurn = TurnStartResultSchema.parse(
      await harness.request('turn/start', {
        threadId: threadRes.threadId,
        input: 'secret context NUH_HANDOFF_99',
      }),
    );
    await harness.waitForNotification(
      (n) => n.method === 'turn/completed' && n.params.turnId === codexTurn.turnId,
    );

    // Reject switching to unconfigured claude with explicit NOT_CONFIGURED
    const claudeErr = await harness.requestExpectError('thread/setBackend', {
      threadId: threadRes.threadId,
      backend: 'claude',
    });
    assert.equal(claudeErr.error.code, NUH_ERROR_CODES.BACKEND_UNAVAILABLE);
    assert.ok(claudeErr.error.message.includes('NOT_CONFIGURED'));

    // Switch to agy with model + thoughtLevel config
    const switchRes = ThreadSetBackendResultSchema.parse(
      await harness.request('thread/setBackend', {
        threadId: threadRes.threadId,
        backend: 'agy',
        model: 'gemini-3.8-flash',
        thoughtLevel: 'high',
      }),
    );
    assert.equal(switchRes.backend, 'agy');
    assert.equal(switchRes.model, 'gemini-3.8-flash');
    assert.equal(switchRes.thoughtLevel, 'high');

    // Turn 2 on agy should receive Handoff Summary from ledger.jsonl & emit thinking + model deltas
    const agyTurn1 = TurnStartResultSchema.parse(
      await harness.request('turn/start', {
        threadId: threadRes.threadId,
        input: 'continue on agy',
      }),
    );
    assert.equal(agyTurn1.resolvedBackend, 'agy');
    await harness.waitForNotification(
      (n) => n.method === 'turn/completed' && n.params.turnId === agyTurn1.turnId,
    );

    const agyTurn1Events = harness.notifications.filter((n) => n.params.turnId === agyTurn1.turnId);
    assert.ok(
      agyTurn1Events.some((n) => n.method === 'item/delta' && n.params.channel === 'thinking'),
    );
    const agyTurn1Text = agyTurn1Events
      .filter((n) => n.method === 'item/delta' && n.params.channel === 'text')
      .map((n) => (n.method === 'item/delta' ? n.params.delta : ''))
      .join('');
    assert.ok(agyTurn1Text.includes('model=gemini-3.8-flash'));
    assert.ok(agyTurn1Text.includes('thought=high'));
    assert.ok(agyTurn1Text.includes('[NUH Handoff Summary (codex -> agy)]'));
    assert.ok(agyTurn1Text.includes('secret context NUH_HANDOFF_99'));

    // Ensure ledger.jsonl kept raw user input without duplicating handoff wrapper
    const ledgerPath = path.join(harness.nuhHome, 'threads', threadRes.threadId, 'ledger.jsonl');
    const ledgerContent = readFileSync(ledgerPath, 'utf8');
    assert.ok(ledgerContent.includes('"input":"continue on agy"'));

    // Test AGY permission allow & silent deny (Spike 04: no agent_message_chunk on deny)
    harness.setApprovalHandler(() => 'allow_once');
    const agyAllowTurn = TurnStartResultSchema.parse(
      await harness.request('turn/start', {
        threadId: threadRes.threadId,
        input: 'NEED_APPROVAL allow agy',
      }),
    );
    await harness.waitForNotification(
      (n) => n.method === 'turn/completed' && n.params.turnId === agyAllowTurn.turnId,
    );
    const agyAllowText = harness.notifications
      .filter(
        (n) =>
          n.params.turnId === agyAllowTurn.turnId &&
          n.method === 'item/delta' &&
          n.params.channel === 'text',
      )
      .map((n) => (n.method === 'item/delta' ? n.params.delta : ''))
      .join('');
    assert.ok(agyAllowText.includes('agy-approved: FAKE_AGY_CMD_OK'));

    harness.setApprovalHandler(() => 'deny');
    const agyDenyTurn = TurnStartResultSchema.parse(
      await harness.request('turn/start', {
        threadId: threadRes.threadId,
        input: 'NEED_APPROVAL deny agy',
      }),
    );
    await harness.waitForNotification(
      (n) => n.method === 'turn/completed' && n.params.turnId === agyDenyTurn.turnId,
    );
    const agyDenyEvents = harness.notifications.filter(
      (n) => n.params.turnId === agyDenyTurn.turnId,
    );
    assert.ok(
      agyDenyEvents.some((n) => n.method === 'item/completed' && n.params.status === 'denied'),
    );
    assert.ok(
      agyDenyEvents.some(
        (n) =>
          n.method === 'item/delta' &&
          n.params.channel === 'text' &&
          n.params.delta.includes('permission denied'),
      ),
    );

    harness.child.stdin.end();
    const exitInfo = await harness.waitForExit();
    assert.equal(exitInfo.code, 0);
  });

  it('supports turn/interrupt, crash recovery with resume, and cascading child cleanup on SIGTERM without zombies', async () => {
    const harness = spawnDaemonWithFakes(tempDirs, spawnedChildren);

    await harness.request('initialize', {
      clientInfo: { name: 'interrupt-crash-test', version: '0.1.0' },
      protocolVersion: NUH_PROTOCOL_VERSION,
    });
    harness.sendNotification('initialized');

    const threadRes = ThreadStartResultSchema.parse(
      await harness.request('thread/start', {
        workdir: ROOT_DIR,
        defaultBackend: 'agy',
      }),
    );

    // 1) Interrupt active AGY turn
    const slowTurn = TurnStartResultSchema.parse(
      await harness.request('turn/start', {
        threadId: threadRes.threadId,
        input: 'SLOW_STREAM test',
      }),
    );
    await harness.waitForNotification(
      (n) => n.method === 'item/delta' && n.params.turnId === slowTurn.turnId,
    );
    const intRes = TurnInterruptResultSchema.parse(
      await harness.request('turn/interrupt', {
        threadId: threadRes.threadId,
        turnId: slowTurn.turnId,
      }),
    );
    assert.equal(intRes.interrupted, true);
    const intDone = await harness.waitForNotification(
      (n) => n.method === 'turn/completed' && n.params.turnId === slowTurn.turnId,
    );
    if (intDone.method === 'turn/completed') {
      assert.equal(intDone.params.status, 'interrupted');
    }

    // 2) Crash recovery: unexpected child exit yields BACKEND_PROCESS_ERROR, next turn respawns & resumes
    const crashTurn = TurnStartResultSchema.parse(
      await harness.request('turn/start', {
        threadId: threadRes.threadId,
        input: 'CRASH_NOW',
      }),
    );
    const crashDone = await harness.waitForNotification(
      (n) => n.method === 'turn/completed' && n.params.turnId === crashTurn.turnId,
    );
    assert.equal(crashDone.method, 'turn/completed');
    if (crashDone.method === 'turn/completed') {
      assert.equal(crashDone.params.status, 'failed');
      assert.equal(crashDone.params.error?.code, NUH_ERROR_CODES.BACKEND_PROCESS_ERROR);
    }

    // Next turn succeeds cleanly after crash
    const recoverTurn = TurnStartResultSchema.parse(
      await harness.request('turn/start', {
        threadId: threadRes.threadId,
        input: 'after crash recover',
      }),
    );
    const recoverDone = await harness.waitForNotification(
      (n) => n.method === 'turn/completed' && n.params.turnId === recoverTurn.turnId,
    );
    if (recoverDone.method === 'turn/completed') {
      assert.equal(recoverDone.params.status, 'completed');
    }

    // 3) Cascading cleanup on SIGTERM: start slow codex turn, SIGTERM daemon, verify zero zombie child PIDs
    await harness.request('thread/setBackend', {
      threadId: threadRes.threadId,
      backend: 'codex',
    });
    const slowCodexTurn = TurnStartResultSchema.parse(
      await harness.request('turn/start', {
        threadId: threadRes.threadId,
        input: 'SLOW_STREAM before sigterm',
      }),
    );
    await harness.waitForNotification(
      (n) => n.method === 'item/delta' && n.params.turnId === slowCodexTurn.turnId,
    );

    const codexPids = readLoggedPids(harness.codexPidLog);
    const agyPids = readLoggedPids(harness.agyPidLog);
    assert.ok(codexPids.length >= 1);
    assert.ok(agyPids.length >= 2);

    harness.child.kill('SIGTERM');
    const exitInfo = await harness.waitForExit();
    assert.equal(exitInfo.code, 0);

    for (const pid of [...codexPids, ...agyPids]) {
      assert.equal(isProcessAlive(pid), false, `Child process ${String(pid)} leaked as zombie`);
    }
  });

  it('drives @nuh/cli-repl interactively for /backend, allow/deny approval, and /interrupt', async () => {
    const baseDir = mkdtempSync(path.join(tmpdir(), 'nuh-repl-backends-'));
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
        NUH_CODEX_BIN: FAKE_CODEX_BIN,
        NUH_AGY_BIN: FAKE_AGY_BIN,
      },
    });
    spawnedChildren.push(child);

    let stdout = '';
    let stderr = '';
    const waiters: Array<{ match: string; fromIndex: number; resolve: () => void }> = [];

    const checkWaiters = (): void => {
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        const waiter = waiters[i];
        if (waiter && stdout.indexOf(waiter.match, waiter.fromIndex) !== -1) {
          waiters.splice(i, 1);
          waiter.resolve();
        }
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      checkWaiters();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    const waitForOutput = (match: string, fromIndex = 0): Promise<void> => {
      if (stdout.indexOf(match, fromIndex) !== -1) {
        return Promise.resolve();
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `Timed out waiting for REPL output "${match}". Current stdout:\n${stdout}\nStderr:\n${stderr}`,
            ),
          );
        }, 8000);
        waiters.push({
          match,
          fromIndex,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      });
    };

    await waitForOutput('[thread ');

    child.stdin.write('/backends\n');
    await waitForOutput('codex: available=true');

    child.stdin.write('/backend codex\n');
    await waitForOutput('[backend switched -> codex]');

    let mark = stdout.length;
    child.stdin.write('NEED_APPROVAL via repl codex\n');
    await waitForOutput('Approve? [y=allow_once / a=allow_for_session / n=deny]:', mark);
    child.stdin.write('y\n');
    await waitForOutput('codex-approved: FAKE_CODEX_CMD_OK', mark);
    await waitForOutput('completed]', mark);

    child.stdin.write('/backend agy gemini-3.8-flash low\n');
    await waitForOutput('[backend switched -> agy model=gemini-3.8-flash thought=low]');

    mark = stdout.length;
    child.stdin.write('NEED_APPROVAL via repl agy\n');
    await waitForOutput('Approve? [y=allow_once / a=allow_for_session / n=deny]:', mark);
    child.stdin.write('n\n');
    await waitForOutput('permission denied', mark);
    await waitForOutput('completed]', mark);

    mark = stdout.length;
    child.stdin.write('SLOW_STREAM interrupt me\n');
    await waitForOutput('agy-slow-1', mark);
    child.stdin.write('/interrupt\n');
    await waitForOutput('interrupted]', mark);

    child.stdin.write('/quit\n');
    child.stdin.end();

    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('cli-repl exit timed out')), 8000);
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });

    assert.equal(exitCode, 0, `stderr was: ${stderr}`);
  });
});
