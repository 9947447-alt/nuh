import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { HeadlessMnemonExecutor, MNEMON_READONLY_TOOL_NAMES } from '@nuh/dsh-shims';
import { bootDshHeadlessRuntime } from './dsh-runtime.ts';
import { AuditLedger } from './ledger.ts';

const FIBER_STATE_DISPOSED = 4;

describe('@nuh/core headless DSH runtime and audit ledger', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('boots dsh-base headless with settings enabled and hmr disabled, then disposes Cordis fiber cleanly', async () => {
    const tempHome = mkdtempSync(path.join(tmpdir(), 'nuh-core-unit-'));
    tempDirs.push(tempHome);

    const prevDshHome = process.env.DSH_HOME;
    const prevTelemetry = process.env.DSH_TELEMETRY_DISABLED;
    try {
      const runtime = await bootDshHeadlessRuntime({
        dshHome: tempHome,
        profileName: 'unit-test-profile',
        disableTelemetry: true,
      });

      let probeCleaned = false;
      const probeFiber = runtime.ctx.plugin({
        name: 'nuh-dispose-probe',
        apply(ctx) {
          ctx.effect(() => () => {
            probeCleaned = true;
          });
        },
      });
      await probeFiber.inertia;
      assert.equal(probeFiber.state, 2);

      assert.equal(runtime.settingsActive, true);
      assert.equal(runtime.hmrDisabled, true);
      assert.ok(runtime.loadedPluginIds.includes('settings'));
      assert.ok(runtime.loadedPluginIds.includes('tools'));
      assert.equal(runtime.loadedPluginIds.includes('hmr'), false);
      assert.equal(runtime.isDisposed(), false);

      await runtime.dispose();
      assert.equal(runtime.isDisposed(), true);
      assert.equal(probeCleaned, true);
      assert.equal(probeFiber.state, FIBER_STATE_DISPOSED);
      assert.equal(runtime.ctx.get('loader'), undefined);
      assert.equal(runtime.ctx.get('settings'), undefined);
      assert.equal(runtime.ctx.get('tools'), undefined);

      // 二次调用 dispose 应幂等
      await runtime.dispose();
    } finally {
      if (prevDshHome === undefined) {
        delete process.env.DSH_HOME;
      } else {
        process.env.DSH_HOME = prevDshHome;
      }
      if (prevTelemetry === undefined) {
        delete process.env.DSH_TELEMETRY_DISABLED;
      } else {
        process.env.DSH_TELEMETRY_DISABLED = prevTelemetry;
      }
    }
  });

  it('appends thread/turn/item events sequentially to ledger.jsonl and summarizes them', async () => {
    const tempNuhHome = mkdtempSync(path.join(tmpdir(), 'nuh-ledger-unit-'));
    tempDirs.push(tempNuhHome);

    const ledger = new AuditLedger(tempNuhHome);
    const threadId = 'nuh_thr_unit_1';
    const turnId = 'nuh_turn_unit_1';
    const itemId = 'itm_unit_1';

    await ledger.appendThreadStarted(threadId, {
      workdir: '/tmp/work',
      defaultBackend: 'native-dsh',
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
    });
    await ledger.appendTurnInput(threadId, {
      turnId,
      backend: 'native-dsh',
      input: 'hello ledger',
    });
    await ledger.appendNormalizedEvent({
      type: 'turn/started',
      payload: { threadId, turnId, backend: 'native-dsh' },
    });
    await ledger.appendNormalizedEvent({
      type: 'item/started',
      payload: { threadId, turnId, itemId, kind: 'agent_message' },
    });
    await ledger.appendNormalizedEvent({
      type: 'item/delta',
      payload: { threadId, turnId, itemId, channel: 'text', delta: '[nuh-echo] ' },
    });
    await ledger.appendNormalizedEvent({
      type: 'item/delta',
      payload: { threadId, turnId, itemId, channel: 'text', delta: 'hello ledger' },
    });
    await ledger.appendNormalizedEvent({
      type: 'item/completed',
      payload: { threadId, turnId, itemId, status: 'ok' },
    });
    await ledger.appendNormalizedEvent({
      type: 'turn/completed',
      payload: { threadId, turnId, status: 'completed' },
    });

    const entries = await ledger.readThreadEntries(threadId);
    assert.equal(entries.length, 8);
    assert.deepEqual(
      entries.map((entry) => entry.seq),
      [1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.equal(entries[0]?.kind, 'thread/started');
    assert.equal(entries[7]?.kind, 'turn/completed');

    const summary = await ledger.summarizeThread(threadId);
    assert.equal(summary.length, 2);
    assert.equal(summary[0]?.role, 'user');
    assert.equal(summary[0]?.summary, 'hello ledger');
    assert.equal(summary[1]?.role, 'assistant');
    assert.equal(summary[1]?.summary, '[nuh-echo] hello ledger');
  });

  it('activates dsh-mnemon headless memory tools and executes read-only queries safely', async () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'nuh-core-mnemon-'));
    let runtime: Awaited<ReturnType<typeof bootDshHeadlessRuntime>> | undefined;
    let executor: HeadlessMnemonExecutor | undefined;
    try {
      runtime = await bootDshHeadlessRuntime({
        dshHome: tempDir,
        cwd: tempDir,
      });

      for (const toolName of MNEMON_READONLY_TOOL_NAMES) {
        assert.ok(
          runtime.ctx.tools.get(toolName),
          `expected dsh-mnemon tool ${toolName} to be registered in ctx.tools`,
        );
      }

      executor = new HeadlessMnemonExecutor(runtime.ctx, tempDir);
      const listed = executor.listTools().map((item) => item.name);
      assert.deepEqual(new Set(listed), new Set(MNEMON_READONLY_TOOL_NAMES));

      const bodies = await executor.callTool('mnemon_memory_bodies', {});
      assert.equal(bodies.isError, false);
      assert.equal(typeof bodies.structuredContent?.total, 'number');

      const status = await executor.callTool('mnemon_status', {});
      assert.equal(status.isError, false);
      assert.equal(status.structuredContent?.healthy, true);

      const docs = await executor.callTool('mnemon_document_search', { query: 'test' });
      assert.equal(docs.isError, false);
      assert.equal(docs.structuredContent?.query, 'test');

      await assert.rejects(
        () => executor?.callTool('mnemon_remember', { content: 'blocked' }) ?? Promise.resolve(),
        /not allowed/,
      );
    } finally {
      await executor?.dispose();
      await runtime?.dispose();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
