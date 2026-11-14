#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

function queryAgyMcpServer(serverSpec) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env };
    for (const pair of serverSpec.env ?? []) {
      childEnv[pair.name] = pair.value;
    }

    const child = spawn(serverSpec.command, serverSpec.args ?? [], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const rl = createInterface({ input: child.stdout });
    const pending = new Map();

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      const msg = JSON.parse(trimmed);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) {
          entry.reject(new Error(`${msg.error.message} (code=${msg.error.code})`));
        } else {
          entry.resolve(msg.result);
        }
      }
    });

    child.once('error', (err) => {
      rl.close();
      reject(err);
    });

    let seq = 0;
    const sendReq = (method, params) => {
      const id = ++seq;
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    };

    const sendNote = (method, params) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    };

    (async () => {
      try {
        await sendReq('initialize', {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'fake-agy', version: '0.1.0' },
        });
        sendNote('notifications/initialized', {});

        const listed = await sendReq('tools/list', {});
        const statusCall = await sendReq('tools/call', {
          name: 'mnemon_status',
          arguments: {},
        });
        const docsCall = await sendReq('tools/call', {
          name: 'mnemon_document_search',
          arguments: { query: 'agy-check' },
        });

        child.stdin.end();
        await new Promise((exitResolve) => {
          child.once('exit', () => exitResolve());
        });
        rl.close();

        resolve({
          tools: listed.tools,
          statusCall,
          docsCall,
        });
      } catch (err) {
        child.kill('SIGKILL');
        rl.close();
        reject(err);
      }
    })();
  });
}

const rl = createInterface({ input: process.stdin });

function writeJson(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

let lastSessionMethod = null;
let lastMcpServers = [];
const activeSessionId = 'fake_agy_acp_sess_1';

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  const msg = JSON.parse(trimmed);
  if (msg.id === undefined) {
    return;
  }

  const method = msg.method;
  const params = msg.params ?? {};

  if (method === 'initialize') {
    writeJson({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          load_session: true,
          sessionCapabilities: { resume: {} },
          session_capabilities: { resume: {} },
        },
        agentInfo: { name: 'fake-agy-mcp', version: '1.5.9' },
        authMethods: [],
      },
    });
    return;
  }

  if (method === 'session/new' || method === 'session/resume') {
    lastSessionMethod = method;
    lastMcpServers = Array.isArray(params.mcpServers) ? params.mcpServers : [];
    writeJson({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        sessionId: typeof params.sessionId === 'string' ? params.sessionId : activeSessionId,
        configOptions: [],
      },
    });
    return;
  }

  if (method === 'session/prompt') {
    const sessionId = typeof params.sessionId === 'string' ? params.sessionId : activeSessionId;
    (async () => {
      try {
        const bridge = lastMcpServers[0];
        if (!bridge) {
          throw new Error(`No mcpServers provided to ${String(lastSessionMethod)}`);
        }
        const probe = await queryAgyMcpServer(bridge);
        const summary = {
          backend: 'agy',
          sessionMethod: lastSessionMethod,
          sessionId,
          mcpServerCount: lastMcpServers.length,
          mcpServerName: bridge.name,
          envNames: (bridge.env ?? []).map((e) => e.name),
          toolNames: probe.tools.map((t) => t.name),
          allReadOnlyHints: probe.tools.every((t) => t.annotations?.readOnlyHint === true),
          statusHealthy: probe.statusCall?.structuredContent?.healthy ?? null,
          docsQuery: probe.docsCall?.structuredContent?.query ?? null,
        };

        writeJson({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: JSON.stringify(summary),
              },
            },
          },
        });
        writeJson({
          jsonrpc: '2.0',
          id: msg.id,
          result: { stopReason: 'end_turn' },
        });
      } catch (err) {
        writeJson({
          jsonrpc: '2.0',
          id: msg.id,
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }
    })();
    return;
  }

  writeJson({
    jsonrpc: '2.0',
    id: msg.id,
    result: {},
  });
});

rl.on('close', () => {
  process.exit(0);
});
