import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import {
  classifyJsonRpcMessage,
  NUH_ERROR_CODES,
  NuhNormalizedEventSchema,
  NuhProtocolError,
  parseNdjsonJson,
  parseNuhClientRequest,
  parseNuhNotification,
  parseNuhServerRequest,
  serializeNdjsonLine,
  toNuhNotification,
} from '@nuh/protocol';

describe('Fake Integration: built @nuh/protocol NDJSON stream roundtrip (no external LLM)', () => {
  it('streams requests, normalized notifications, server approval requests, and explicit error frames over PassThrough', async () => {
    const clientToServer = new PassThrough();
    const serverToClient = new PassThrough();

    const serverLines = createInterface({ input: clientToServer });
    const clientLines = createInterface({ input: serverToClient });

    const serverTask = (async () => {
      for await (const line of serverLines) {
        try {
          const raw = parseNdjsonJson(line);
          const frame = classifyJsonRpcMessage(raw, { requireJsonRpcVersion: true });
          if (frame.kind === 'request') {
            const req = parseNuhClientRequest(raw);
            if (req.method === 'turn/start') {
              serverToClient.write(
                serializeNdjsonLine({
                  jsonrpc: '2.0',
                  id: req.id,
                  result: { turnId: 'turn_fake_1', resolvedBackend: 'codex' },
                }),
              );

              const events = [
                {
                  type: 'turn/started',
                  payload: {
                    threadId: req.params.threadId,
                    turnId: 'turn_fake_1',
                    backend: 'codex',
                  },
                },
                {
                  type: 'item/started',
                  payload: {
                    threadId: req.params.threadId,
                    turnId: 'turn_fake_1',
                    itemId: 'itm_fake_1',
                    kind: 'agent_message',
                  },
                },
                {
                  type: 'item/delta',
                  payload: {
                    threadId: req.params.threadId,
                    turnId: 'turn_fake_1',
                    itemId: 'itm_fake_1',
                    channel: 'text',
                    delta: 'fake-ok',
                  },
                },
                {
                  type: 'item/completed',
                  payload: {
                    threadId: req.params.threadId,
                    turnId: 'turn_fake_1',
                    itemId: 'itm_fake_1',
                    status: 'ok',
                  },
                },
                {
                  type: 'turn/completed',
                  payload: {
                    threadId: req.params.threadId,
                    turnId: 'turn_fake_1',
                    status: 'completed',
                  },
                },
              ];

              serverToClient.write(
                serializeNdjsonLine({
                  jsonrpc: '2.0',
                  id: 'srv_approval_1',
                  method: 'approval/requested',
                  params: {
                    threadId: req.params.threadId,
                    turnId: 'turn_fake_1',
                    backend: 'codex',
                    category: 'command_exec',
                    title: 'Fake command approval',
                    command: 'echo ok',
                  },
                }),
              );

              for (const ev of events) {
                const normalized = NuhNormalizedEventSchema.parse(ev);
                serverToClient.write(serializeNdjsonLine(toNuhNotification(normalized)));
              }
            }
          } else if (frame.kind === 'response_success') {
            serverToClient.end();
          }
        } catch (err) {
          if (err instanceof NuhProtocolError) {
            serverToClient.write(serializeNdjsonLine(err.toJsonRpcErrorResponse(null)));
            continue;
          }
          throw err;
        }
      }
    })();

    const observedNotifications: string[] = [];
    let observedApprovalId: number | string | null = null;
    let observedParseErrorCode: number | null = null;

    clientToServer.write('{broken-ndjson\n');
    clientToServer.write(
      serializeNdjsonLine({
        jsonrpc: '2.0',
        id: 1,
        method: 'turn/start',
        params: { threadId: 'thr_fake_1', input: 'ping' },
      }),
    );

    for await (const line of clientLines) {
      const raw = parseNdjsonJson(line);
      const frame = classifyJsonRpcMessage(raw, { requireJsonRpcVersion: true });
      if (frame.kind === 'response_error') {
        observedParseErrorCode = frame.message.error.code;
      } else if (frame.kind === 'request') {
        const srvReq = parseNuhServerRequest(raw);
        observedApprovalId = srvReq.id;
        clientToServer.write(
          serializeNdjsonLine({
            jsonrpc: '2.0',
            id: srvReq.id,
            result: { decision: 'allow_once', note: null },
          }),
        );
      } else if (frame.kind === 'notification') {
        const notif = parseNuhNotification(raw);
        observedNotifications.push(notif.method);
      }
    }

    clientToServer.end();
    await serverTask;

    assert.equal(observedParseErrorCode, NUH_ERROR_CODES.PARSE_ERROR);
    assert.equal(observedApprovalId, 'srv_approval_1');
    assert.deepEqual(observedNotifications, [
      'turn/started',
      'item/started',
      'item/delta',
      'item/completed',
      'turn/completed',
    ]);
  });
});
