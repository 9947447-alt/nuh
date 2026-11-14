import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Context } from '@deepseek-ai/cordis';
import {
  HeadlessMnemonExecutor,
  isMnemonReadOnlyToolName,
  listMnemonReadOnlyTools,
  MNEMON_READONLY_TOOL_NAMES,
} from './index.ts';

describe('@nuh/dsh-shims mnemon read-only guardrails', () => {
  it('permits only read/inspect mnemon tools and excludes mutating or command tools', () => {
    for (const allowed of MNEMON_READONLY_TOOL_NAMES) {
      assert.equal(isMnemonReadOnlyToolName(allowed), true);
    }

    const forbidden = [
      'mnemon_remember',
      'mnemon_forget',
      'mnemon_link',
      'mnemon_document_create',
      'mnemon_document_manage',
      'mnemon_runtime_memory',
      'mnemon_memory_body_create',
      'mnemon_memory_body_update',
      'mnemon_memory_body_merge',
      'mnemon_view_route',
      'mnemon_view_action',
      'mnemon_subagent_result',
      'bash',
      'exec_command',
    ];
    for (const toolName of forbidden) {
      assert.equal(isMnemonReadOnlyToolName(toolName), false);
    }
  });

  it('filters ctx.tools.definitions() down to read-only mnemon tools', () => {
    const fakeDefinitions = [
      {
        name: 'mnemon_recall',
        description: 'recall',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      },
      {
        name: 'mnemon_remember',
        description: 'write should not be exposed',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'mnemon_status',
        description: 'status',
        parameters: { type: 'object', properties: {} },
      },
      {
        name: 'shell_exec',
        description: 'exec should not be exposed',
        parameters: { type: 'object', properties: {} },
      },
    ];

    const fakeCtx = {
      tools: {
        definitions: () => fakeDefinitions,
      },
    } as unknown as Context;

    const listed = listMnemonReadOnlyTools(fakeCtx);
    assert.deepEqual(
      listed.map((t) => t.name),
      ['mnemon_recall', 'mnemon_status'],
    );
  });

  it('rejects non-whitelisted tools in HeadlessMnemonExecutor.callTool before touching runtime', async () => {
    const fakeCtx = {
      tools: {
        definitions: () => [],
      },
    } as unknown as Context;

    const executor = new HeadlessMnemonExecutor(fakeCtx, process.cwd());
    await assert.rejects(
      () => executor.callTool('mnemon_remember', { content: 'secret' }),
      /not allowed on the read-only mnemon bridge/,
    );
    await executor.dispose();
  });
});
