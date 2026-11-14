import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AgyAcpInitializeResultSchema,
  AgyAcpPermissionRequestSchema,
  AgyAcpPromptResultSchema,
  AgyAcpSessionUpdateNotificationSchema,
  buildAgyAcpPermissionResponse,
  NUH_ERROR_CODES,
  NuhProtocolError,
  parseAgyAcpWireMessage,
  parseNdjsonJson,
  serializeNdjsonLine,
} from '@nuh/protocol';

const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/agy');

function readNdjsonLines(filename: string): string[] {
  return readFileSync(path.join(FIXTURES_DIR, filename), 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
}

function isServerToClientEntry(val: unknown): val is { dir: string; payload: unknown } {
  return (
    typeof val === 'object' &&
    val !== null &&
    'dir' in val &&
    'payload' in val &&
    val.dir === 'server->client'
  );
}

describe('AGY ACP Contract (Spike 04 real fixtures, single-track acp --stdio)', () => {
  it('parses all 25 real acp-server-stdout.ndjson frames including string server request ID', () => {
    const lines = readNdjsonLines('acp-server-stdout.ndjson');
    assert.equal(lines.length, 25);

    let permissionReqCount = 0;
    let initVerified = false;
    let promptResultCount = 0;

    for (const line of lines) {
      const raw = parseNdjsonJson(line);
      const parsed = parseAgyAcpWireMessage(raw);

      if (parsed.kind === 'server_request') {
        const permReq = AgyAcpPermissionRequestSchema.parse(parsed.message);
        permissionReqCount += 1;
        assert.equal(permReq.method, 'session/request_permission');
        // Spike 04 实测：ACP 服务端主动请求 ID 为字符串 "1"
        assert.equal(typeof permReq.id, 'string');
        assert.equal(permReq.id, '1');

        const allowReply = buildAgyAcpPermissionResponse(permReq.id, 'allow');
        assert.equal(allowReply.id, '1');
        assert.equal(allowReply.result.outcome.optionId, 'allow');
      } else if (parsed.kind === 'response_success') {
        if (parsed.message.id === 1) {
          const init = AgyAcpInitializeResultSchema.parse(parsed.message.result);
          // 验证驼峰与下划线混用字段通过 .passthrough() 保留
          assert.equal(init.agentCapabilities.loadSession, true);
          assert.equal(init.agentCapabilities.load_session, true);
          assert.ok('_meta' in init.agentCapabilities);
          initVerified = true;
        } else if (parsed.message.id === 3 || parsed.message.id === 4) {
          const promptRes = AgyAcpPromptResultSchema.parse(parsed.message.result);
          assert.equal(promptRes.stopReason, 'end_turn');
          promptResultCount += 1;
        }
      }

      // 序列化往返一致性检查
      const roundtripped = parseAgyAcpWireMessage(
        parseNdjsonJson(serializeNdjsonLine(parsed.message)),
      );
      assert.equal(roundtripped.kind, parsed.kind);
    }

    assert.equal(permissionReqCount, 1);
    assert.equal(initVerified, true);
    assert.equal(promptResultCount, 2);
  });

  it('parses acp-roundtrip.jsonl, acp-deny-roundtrip.jsonl, and acp-resume-roundtrip.jsonl', () => {
    const denyLines = readNdjsonLines('acp-deny-roundtrip.jsonl');
    let sawFailedAfterDeny = false;
    for (const line of denyLines) {
      const entry = parseNdjsonJson(line);
      if (!isServerToClientEntry(entry)) {
        continue;
      }
      const parsed = parseAgyAcpWireMessage(entry.payload);
      if (parsed.kind === 'notification' && parsed.message.method === 'session/update') {
        const sessionUpdate = AgyAcpSessionUpdateNotificationSchema.parse(parsed.message);
        const update = sessionUpdate.params.update;
        if (
          update.sessionUpdate === 'tool_call_update' &&
          'status' in update &&
          update.status === 'failed'
        ) {
          sawFailedAfterDeny = true;
        }
      }
    }
    assert.equal(sawFailedAfterDeny, true);

    for (const filename of ['acp-roundtrip.jsonl', 'acp-resume-roundtrip.jsonl']) {
      const lines = readNdjsonLines(filename);
      assert.ok(lines.length > 0);
      for (const line of lines) {
        const entry = parseNdjsonJson(line);
        if (isServerToClientEntry(entry)) {
          const parsed = parseAgyAcpWireMessage(entry.payload);
          assert.ok(parsed.kind.length > 0);
        }
      }
    }
  });

  it('rejects ACP frames missing jsonrpc: "2.0" or invalid session/request_permission payload', () => {
    assert.throws(
      () =>
        parseAgyAcpWireMessage({
          method: 'session/update',
          params: { sessionId: 's1', update: { sessionUpdate: 'session_info_update' } },
        }),
      (err: unknown) =>
        err instanceof NuhProtocolError && err.code === NUH_ERROR_CODES.INVALID_REQUEST,
    );

    assert.throws(
      () =>
        parseAgyAcpWireMessage({
          jsonrpc: '2.0',
          id: '1',
          method: 'session/request_permission',
          params: { sessionId: 's1', options: [] },
        }),
      (err: unknown) =>
        err instanceof NuhProtocolError && err.code === NUH_ERROR_CODES.PROTOCOL_VALIDATION_ERROR,
    );
  });
});
