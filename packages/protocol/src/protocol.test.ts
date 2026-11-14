import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyJsonRpcMessage,
  NUH_ERROR_CODES,
  NuhNormalizedEventSchema,
  NuhProtocolError,
  parseNdjsonJson,
  parseNuhClientNotification,
  parseNuhClientRequest,
  parseNuhNotification,
  parseNuhServerRequest,
  serializeNdjsonLine,
  toNuhNotification,
} from './index.ts';

describe('@nuh/protocol canonical schemas and error handling', () => {
  it('validates canonical NUH client requests and supports heterogeneous IDs', () => {
    const reqNum = parseNuhClientRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: { name: 'nuh-cli-repl', version: '0.1.0' },
        protocolVersion: '0.1',
      },
    });
    assert.equal(reqNum.id, 1);
    assert.equal(reqNum.method, 'initialize');

    const reqStr = parseNuhClientRequest({
      jsonrpc: '2.0',
      id: 'req-abc-42',
      method: 'thread/start',
      params: {
        workdir: '/tmp/project',
      },
    });
    assert.equal(reqStr.id, 'req-abc-42');
    assert.equal(reqStr.method, 'thread/start');
    if (reqStr.method === 'thread/start') {
      assert.equal(reqStr.params.defaultBackend, 'native-dsh');
      assert.equal(reqStr.params.sandboxMode, 'workspace-write');
      assert.equal(reqStr.params.approvalPolicy, 'on-request');
    }

    const notif = parseNuhClientNotification({
      jsonrpc: '2.0',
      method: 'initialized',
    });
    assert.equal(notif.method, 'initialized');
  });

  it('prioritizes id && method as request to avoid server/client ID collisions', () => {
    const serverReq = classifyJsonRpcMessage(
      {
        id: 0,
        method: 'item/commandExecution/requestApproval',
        params: { command: 'ls' },
      },
      { requireJsonRpcVersion: false },
    );
    assert.equal(serverReq.kind, 'request');

    const stringServerReq = classifyJsonRpcMessage(
      {
        jsonrpc: '2.0',
        id: '1',
        method: 'approval/requested',
        params: {},
      },
      { requireJsonRpcVersion: true },
    );
    assert.equal(stringServerReq.kind, 'request');
  });

  it('validates server approval requests and normalized events roundtrip', () => {
    const srvReq = parseNuhServerRequest({
      jsonrpc: '2.0',
      id: 'srv_req_99',
      method: 'approval/requested',
      params: {
        threadId: 'nuh_thr_1',
        turnId: 'nuh_turn_1',
        backend: 'codex',
        category: 'command_exec',
        title: 'Run shell command',
        command: 'ls -la',
      },
    });
    assert.equal(srvReq.id, 'srv_req_99');

    const normalized = NuhNormalizedEventSchema.parse({
      type: 'item/delta',
      payload: {
        threadId: 'nuh_thr_1',
        turnId: 'nuh_turn_1',
        itemId: 'itm_1',
        channel: 'text',
        delta: 'hello',
      },
    });
    const notification = toNuhNotification(normalized);
    const wireLine = serializeNdjsonLine(notification);
    const parsedWire = parseNuhNotification(parseNdjsonJson(wireLine));
    assert.deepEqual(parsedWire, notification);
  });

  it('rejects malformed frames with explicit NuhProtocolError codes instead of returning null', () => {
    assert.throws(
      () => parseNdjsonJson('{bad json'),
      (err: unknown) => err instanceof NuhProtocolError && err.code === NUH_ERROR_CODES.PARSE_ERROR,
    );

    assert.throws(
      () => parseNdjsonJson('   '),
      (err: unknown) => err instanceof NuhProtocolError && err.code === NUH_ERROR_CODES.PARSE_ERROR,
    );

    assert.throws(
      () =>
        parseNuhClientRequest({
          id: 1,
          method: 'initialize',
          params: {},
        }),
      (err: unknown) =>
        err instanceof NuhProtocolError && err.code === NUH_ERROR_CODES.INVALID_REQUEST,
    );

    assert.throws(
      () =>
        parseNuhClientRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'unknown/method',
          params: {},
        }),
      (err: unknown) =>
        err instanceof NuhProtocolError && err.code === NUH_ERROR_CODES.METHOD_NOT_FOUND,
    );

    assert.throws(
      () =>
        parseNuhClientRequest({
          jsonrpc: '2.0',
          id: 1,
          method: 'turn/start',
          params: { threadId: '', input: '' },
        }),
      (err: unknown) =>
        err instanceof NuhProtocolError && err.code === NUH_ERROR_CODES.INVALID_PARAMS,
    );

    const errObj = new NuhProtocolError(
      NUH_ERROR_CODES.PROTOCOL_VALIDATION_ERROR,
      'invalid payload',
      { field: 'x' },
    ).toJsonRpcErrorResponse(12);
    assert.equal(errObj.jsonrpc, '2.0');
    assert.equal(errObj.id, 12);
    assert.equal(errObj.error.code, NUH_ERROR_CODES.PROTOCOL_VALIDATION_ERROR);
  });
});
