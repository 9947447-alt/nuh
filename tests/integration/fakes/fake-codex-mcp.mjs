#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

function extractMcpServerOverride(argv) {
  const idx = argv.indexOf('-c');
  if (idx < 0 || idx + 1 >= argv.length) {
    throw new Error(`Missing -c mcp_servers override in argv: ${JSON.stringify(argv)}`);
  }
  const value = argv[idx + 1];
  const prefix = 'mcp_servers.nuh_memory={';
  if (!value.startsWith(prefix) || !value.endsWith('}')) {
    throw new Error(`Unexpected mcp_servers override format: ${value}`);
  }

  const commandMatch = value.match(/command=("(?:[^"\\]|\\.)*")/);
  const argsMatch = value.match(/args=(\[(?:[^\]\\]|\\.|"(?:[^"\\]|\\.)*")*\])/);
  const envSocketMatch = value.match(/NUH_MCP_SOCKET=("(?:[^"\\]|\\.)*")/);
  const envCwdMatch = value.match(/NUH_MCP_CWD=("(?:[^"\\]|\\.)*")/);

  if (!commandMatch || !argsMatch || !envSocketMatch) {
    throw new Error(`Could not parse command/args/NUH_MCP_SOCKET from: ${value}`);
  }

  return {
    rawOverride: value,
    command: JSON.parse(commandMatch[1]),
    args: JSON.parse(argsMatch[1]),
    env: {
      NUH_MCP_SOCKET: JSON.parse(envSocketMatch[1]),
      ...(envCwdMatch ? { NUH_MCP_CWD: JSON.parse(envCwdMatch[1]) } : {}),
    },
  };
}

function queryMcpStdioServer(serverSpec, calls) {
  return new Promise((resolve, reject) => {
    const child = spawn(serverSpec.command, serverSpec.args, {
      env: { ...process.env, ...serverSpec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stderrChunks = [];
    child.stderr.on('data', (chunk) => {
      stderrChunks.push(String(chunk));
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
          clientInfo: { name: 'fake-codex', version: '0.1.0' },
        });
        sendNote('notifications/initialized', {});

        const listed = await sendReq('tools/list', {});
        const callResults = [];
        for (const call of calls) {
          const outcome = await sendReq('tools/call', {
            name: call.name,
            arguments: call.arguments,
          });
          callResults.push({ name: call.name, outcome });
        }

        let blockedWriteError = null;
        try {
          await sendReq('tools/call', {
            name: 'mnemon_remember',
            arguments: { content: 'should fail' },
          });
        } catch (err) {
          blockedWriteError = err instanceof Error ? err.message : String(err);
        }

        child.stdin.end();
        await new Promise((exitResolve) => {
          child.once('exit', () => exitResolve());
        });
        rl.close();

        resolve({
          tools: listed.tools,
          callResults,
          blockedWriteError,
          stderr: stderrChunks.join(''),
        });
      } catch (err) {
        child.kill('SIGKILL');
        rl.close();
        reject(err);
      }
    })();
  });
}

const serverSpec = extractMcpServerOverride(process.argv.slice(2));
const rl = createInterface({ input: process.stdin });

function writeJson(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

let turnCounter = 0;
const currentThreadId = 'codex_mcp_thread_1';

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

  if (method === 'initialize') {
    writeJson({
      id: msg.id,
      result: { userAgent: 'fake-codex-mcp/1.0' },
    });
    return;
  }

  if (method === 'thread/start') {
    writeJson({
      id: msg.id,
      result: { thread: { id: currentThreadId } },
    });
    return;
  }

  if (method === 'turn/start') {
    const turnId = `codex_turn_${++turnCounter}`;
    const startTurnObj = {
      id: turnId,
      rootTurnId: turnId,
      items: [],
      itemsView: 'notLoaded',
      status: 'inProgress',
      error: null,
    };
    writeJson({
      id: msg.id,
      result: { turn: startTurnObj },
    });

    writeJson({
      method: 'turn/started',
      params: { threadId: currentThreadId, turn: startTurnObj },
    });

    (async () => {
      try {
        // Simulate Codex's dual MCP subprocess behavior concurrently
        const [probeA, probeB] = await Promise.all([
          queryMcpStdioServer(serverSpec, [{ name: 'mnemon_memory_bodies', arguments: {} }]),
          queryMcpStdioServer(serverSpec, [
            { name: 'mnemon_status', arguments: {} },
            { name: 'mnemon_document_search', arguments: { query: 'test' } },
          ]),
        ]);

        const summary = {
          backend: 'codex',
          rawOverridePresent: serverSpec.rawOverride.includes('mcp_servers.nuh_memory='),
          toolNamesA: probeA.tools.map((t) => t.name),
          toolNamesB: probeB.tools.map((t) => t.name),
          allReadOnlyHints: probeA.tools.every((t) => t.annotations?.readOnlyHint === true),
          memoryBodiesTotal: probeA.callResults[0]?.outcome?.structuredContent?.total ?? null,
          statusHealthy: probeB.callResults[0]?.outcome?.structuredContent?.healthy ?? null,
          docsQuery: probeB.callResults[1]?.outcome?.structuredContent?.query ?? null,
          blockedWriteError: probeA.blockedWriteError,
        };

        const itemId = `item_${turnId}`;
        const summaryText = JSON.stringify(summary);
        writeJson({
          method: 'item/started',
          params: {
            threadId: currentThreadId,
            turnId,
            item: {
              id: itemId,
              type: 'agentMessage',
              text: '',
              phase: 'final_answer',
            },
          },
        });
        writeJson({
          method: 'item/agentMessage/delta',
          params: {
            threadId: currentThreadId,
            turnId,
            itemId,
            delta: summaryText,
          },
        });
        writeJson({
          method: 'item/completed',
          params: {
            threadId: currentThreadId,
            turnId,
            item: {
              id: itemId,
              type: 'agentMessage',
              text: summaryText,
              phase: 'final_answer',
            },
          },
        });
        writeJson({
          method: 'turn/completed',
          params: {
            threadId: currentThreadId,
            turn: {
              id: turnId,
              rootTurnId: turnId,
              items: [],
              itemsView: 'summary',
              status: 'completed',
              error: null,
            },
          },
        });
      } catch (err) {
        writeJson({
          method: 'turn/completed',
          params: {
            threadId: currentThreadId,
            turn: {
              id: turnId,
              rootTurnId: turnId,
              items: [],
              itemsView: 'summary',
              status: 'failed',
              error: { message: err instanceof Error ? err.message : String(err) },
            },
          },
        });
      }
    })();
    return;
  }

  writeJson({
    id: msg.id,
    result: {},
  });
});

rl.on('close', () => {
  process.exit(0);
});
