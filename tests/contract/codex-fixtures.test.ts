import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CodexCommandApprovalRequestSchema,
  CodexTurnCompletedNotificationSchema,
  NUH_ERROR_CODES,
  NuhProtocolError,
  parseCodexClientRequest,
  parseCodexWireMessage,
  parseNdjsonJson,
  serializeNdjsonLine,
} from '@nuh/protocol';

const FIXTURES_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/codex',
);

function readNdjsonLines(filename: string): string[] {
  return readFileSync(path.join(FIXTURES_DIR, filename), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

describe('Codex App-Server Contract (Spike 01 real fixtures)', () => {
  it('parses all real client-stdin.ndjson frames', () => {
    const lines = readNdjsonLines('client-stdin.ndjson');
    assert.equal(lines.length, 7);

    for (const [index, line] of lines.entries()) {
      const raw = parseNdjsonJson(line);
      if (index === 6) {
        // 第 7 条为客户端回复服务端审批请求的 Response（id: 0）
        assert.ok(isRecord(raw));
        assert.equal(raw.id, 0);
        assert.ok(raw.result !== undefined);
        continue;
      }
      const parsed = parseCodexClientRequest(raw);
      assert.ok(parsed.method.length > 0);
    }
  });

  it('parses all 105 real server-stdout.ndjson frames without jsonrpc field and preserves passthrough fields', () => {
    const lines = readNdjsonLines('server-stdout.ndjson');
    assert.equal(lines.length, 105);

    let serverRequestCount = 0;
    let deltaCount = 0;
    let itemStartedCount = 0;
    let itemCompletedCount = 0;
    let turnCompletedSummaryOnly = false;

    for (const line of lines) {
      const raw = parseNdjsonJson(line);
      const parsed = parseCodexWireMessage(raw);

      if (parsed.kind === 'server_request') {
        const approvalReq = CodexCommandApprovalRequestSchema.parse(parsed.message);
        serverRequestCount += 1;
        assert.equal(approvalReq.method, 'item/commandExecution/requestApproval');
        assert.equal(approvalReq.id, 0);
        // 验证未知扩展字段透传（Spike 01: availableDecisions）
        assert.ok('availableDecisions' in approvalReq.params);
      } else if (parsed.kind === 'notification') {
        // 验证顶层扩展字段 emittedAtMs 通过 .passthrough() 保留
        assert.ok('emittedAtMs' in parsed.message);

        if (parsed.message.method === 'item/agentMessage/delta') {
          deltaCount += 1;
        } else if (parsed.message.method === 'item/started') {
          itemStartedCount += 1;
        } else if (parsed.message.method === 'item/completed') {
          itemCompletedCount += 1;
        } else if (parsed.message.method === 'turn/completed') {
          const turnCompleted = CodexTurnCompletedNotificationSchema.parse(parsed.message);
          assert.equal(turnCompleted.params.turn.itemsView, 'summary');
          assert.equal(turnCompleted.params.turn.items.length, 1);
          assert.equal(turnCompleted.params.turn.items[0]?.type, 'agentMessage');
          turnCompletedSummaryOnly = true;
        }
      } else if (parsed.kind === 'response_success' && parsed.message.id === 4) {
        // thread/start 响应含 Spike 01 记录的额外字段
        assert.ok(isRecord(parsed.message.result));
        assert.ok('runtimeWorkspaceRoots' in parsed.message.result);
        assert.ok('activePermissionProfile' in parsed.message.result);
        assert.ok('multiAgentMode' in parsed.message.result);
      }

      // 验证序列化往返保持一致
      const roundtripped = parseCodexWireMessage(
        parseNdjsonJson(serializeNdjsonLine(parsed.message)),
      );
      assert.equal(roundtripped.kind, parsed.kind);
    }

    assert.equal(serverRequestCount, 1);
    assert.ok(deltaCount > 0);
    assert.equal(itemStartedCount, 4);
    assert.equal(itemCompletedCount, 4);
    assert.equal(turnCompletedSummaryOnly, true);
  });

  it('parses all server->client payloads in roundtrip.jsonl', () => {
    const lines = readNdjsonLines('roundtrip.jsonl');
    assert.equal(lines.length, 112);

    let serverFrames = 0;
    for (const line of lines) {
      const entry = parseNdjsonJson(line);
      if (isRecord(entry) && entry.dir === 'server->client') {
        serverFrames += 1;
        const parsed = parseCodexWireMessage(entry.payload);
        assert.ok(parsed.kind.length > 0);
      }
    }
    assert.equal(serverFrames, 105);
  });

  it('rejects missing mandatory capabilities booleans and malformed Codex frames without swallowing errors', () => {
    assert.throws(
      () =>
        parseCodexClientRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            clientInfo: { name: 'test', version: '0.1.0' },
            capabilities: { experimentalApi: false },
          },
        }),
      (err: unknown) =>
        err instanceof NuhProtocolError && err.code === NUH_ERROR_CODES.INVALID_PARAMS,
    );

    assert.throws(
      () =>
        parseCodexWireMessage({
          method: 'item/agentMessage/delta',
          params: { threadId: 't1', turnId: 'u1', itemId: 'i1' },
        }),
      (err: unknown) =>
        err instanceof NuhProtocolError && err.code === NUH_ERROR_CODES.PROTOCOL_VALIDATION_ERROR,
    );

    assert.throws(
      () => parseCodexWireMessage({ id: 99 }),
      (err: unknown) =>
        err instanceof NuhProtocolError && err.code === NUH_ERROR_CODES.INVALID_REQUEST,
    );
  });
});
