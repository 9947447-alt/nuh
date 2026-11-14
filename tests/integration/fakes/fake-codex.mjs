import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

if (process.env.NUH_FAKE_CODEX_PID_LOG) {
  appendFileSync(process.env.NUH_FAKE_CODEX_PID_LOG, `${String(process.pid)}\n`, 'utf8');
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let threadSeq = 1;
let turnSeq = 1;
let itemSeq = 1;
let serverReqId = 0;

let activeThreadId = null;
let activeTurn = null;
const pendingApprovals = new Map();

function sendFrame(payload) {
  // Spike 01 实测约束：codex app-server 下行报文省略 "jsonrpc": "2.0"
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function sendNotification(method, params) {
  sendFrame({
    method,
    params,
    emittedAtMs: Date.now(),
  });
}

function sendServerRequest(method, params) {
  const id = serverReqId;
  serverReqId += 1;
  return new Promise((resolve) => {
    pendingApprovals.set(id, resolve);
    sendFrame({
      method,
      id,
      params,
    });
  });
}

function extractActivePrompt(promptText) {
  const marker = '[Current User Request]\n';
  const idx = promptText.lastIndexOf(marker);
  return idx === -1 ? promptText : promptText.slice(idx + marker.length);
}

async function runTurn(turnId, threadId, promptText) {
  activeTurn = { turnId, threadId, interrupted: false, timers: new Set() };
  const turnRef = activeTurn;
  const activeDirective = extractActivePrompt(promptText);

  sendNotification('turn/started', {
    threadId,
    turn: {
      id: turnId,
      rootTurnId: turnId,
      items: [],
      itemsView: 'notLoaded',
      status: 'inProgress',
      error: null,
    },
  });

  const userItemId = `user_${String(itemSeq++)}`;
  sendNotification('item/started', {
    threadId,
    turnId,
    item: {
      type: 'userMessage',
      id: userItemId,
      content: [{ type: 'text', text: promptText }],
    },
  });
  sendNotification('item/completed', {
    threadId,
    turnId,
    item: {
      type: 'userMessage',
      id: userItemId,
      content: [{ type: 'text', text: promptText }],
    },
  });

  if (activeDirective.includes('CRASH_NOW')) {
    process.stderr.write('fake-codex diagnostic stderr before crash\n');
    process.exit(1);
  }

  if (activeDirective.includes('SLOW_STREAM')) {
    const msgId = `msg_${String(itemSeq++)}`;
    sendNotification('item/started', {
      threadId,
      turnId,
      item: {
        type: 'agentMessage',
        id: msgId,
        text: '',
        phase: 'final_answer',
      },
    });
    for (const chunk of ['slow-1 ', 'slow-2 ', 'slow-3 ', 'slow-4 ', 'slow-5 ']) {
      if (turnRef.interrupted) {
        return;
      }
      sendNotification('item/agentMessage/delta', {
        threadId,
        turnId,
        itemId: msgId,
        delta: chunk,
      });
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          turnRef.timers.delete(timer);
          resolve();
        }, 60);
        turnRef.timers.add(timer);
      });
    }
    if (turnRef.interrupted) {
      return;
    }
    sendNotification('item/completed', {
      threadId,
      turnId,
      item: {
        type: 'agentMessage',
        id: msgId,
        text: 'slow-1 slow-2 slow-3 slow-4 slow-5 ',
        phase: 'final_answer',
      },
    });
    sendNotification('turn/completed', {
      threadId,
      turn: {
        id: turnId,
        rootTurnId: turnId,
        items: [],
        itemsView: 'summary',
        status: 'completed',
        error: null,
      },
    });
    activeTurn = null;
    return;
  }

  let finalText = `codex-reply:${promptText}`;
  if (activeDirective.includes('NEED_APPROVAL')) {
    const cmdItemId = `exec_${String(itemSeq++)}`;
    const command = "/bin/zsh -lc 'echo FAKE_CODEX_CMD_OK'";
    sendNotification('item/started', {
      threadId,
      turnId,
      item: {
        type: 'commandExecution',
        id: cmdItemId,
        command,
        cwd: process.cwd(),
        status: 'inProgress',
      },
    });

    const approvalRes = await sendServerRequest('item/commandExecution/requestApproval', {
      kind: 'command',
      threadId,
      turnId,
      itemId: cmdItemId,
      command,
      cwd: process.cwd(),
      availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'],
    });
    sendNotification('serverRequest/resolved', {
      threadId,
      requestId: serverReqId - 1,
    });

    const decision = approvalRes?.decision;
    if (decision === 'accept' || decision === 'acceptForSession') {
      sendNotification('item/completed', {
        threadId,
        turnId,
        item: {
          type: 'commandExecution',
          id: cmdItemId,
          command,
          cwd: process.cwd(),
          status: 'completed',
          aggregatedOutput: 'FAKE_CODEX_CMD_OK\n',
          exitCode: 0,
        },
      });
      finalText = 'codex-approved: FAKE_CODEX_CMD_OK';
    } else {
      sendNotification('item/completed', {
        threadId,
        turnId,
        item: {
          type: 'commandExecution',
          id: cmdItemId,
          command,
          cwd: process.cwd(),
          status: 'declined',
          aggregatedOutput: null,
          exitCode: null,
        },
      });
      finalText = 'codex-declined: command was rejected';
    }
  }

  const msgId = `msg_${String(itemSeq++)}`;
  sendNotification('item/started', {
    threadId,
    turnId,
    item: {
      type: 'agentMessage',
      id: msgId,
      text: '',
      phase: 'final_answer',
    },
  });

  const half = Math.max(1, Math.ceil(finalText.length / 2));
  for (const part of [finalText.slice(0, half), finalText.slice(half)]) {
    if (part.length > 0) {
      sendNotification('item/agentMessage/delta', {
        threadId,
        turnId,
        itemId: msgId,
        delta: part,
      });
    }
  }

  const finalAgentItem = {
    type: 'agentMessage',
    id: msgId,
    text: finalText,
    phase: 'final_answer',
  };
  sendNotification('item/completed', {
    threadId,
    turnId,
    item: finalAgentItem,
  });
  sendNotification('thread/tokenUsage/updated', {
    threadId,
    turnId,
    tokenUsage: {
      total: {
        totalTokens: 120,
        inputTokens: 90,
        outputTokens: 30,
        cachedInputTokens: 10,
        reasoningOutputTokens: 0,
      },
    },
  });
  // Spike 01 实测：turn/completed 仅返回 itemsView: "summary"，不含中间工具调用
  sendNotification('turn/completed', {
    threadId,
    turn: {
      id: turnId,
      rootTurnId: turnId,
      items: [finalAgentItem],
      itemsView: 'summary',
      status: 'completed',
      error: null,
    },
  });
  activeTurn = null;
}

rl.on('line', (line) => {
  if (!line.trim()) {
    return;
  }
  const msg = JSON.parse(line);

  // Client response to server-initiated approval request
  if (msg.id !== undefined && msg.method === undefined) {
    const resolver = pendingApprovals.get(msg.id);
    if (resolver) {
      pendingApprovals.delete(msg.id);
      resolver(msg.result);
    }
    return;
  }

  if (msg.method === 'initialize') {
    const caps = msg.params?.capabilities;
    if (
      caps !== null &&
      caps !== undefined &&
      (typeof caps.experimentalApi !== 'boolean' || typeof caps.requestAttestation !== 'boolean')
    ) {
      sendFrame({
        id: msg.id,
        error: { code: -32602, message: 'capabilities booleans required' },
      });
      return;
    }
    sendFrame({
      id: msg.id,
      result: {
        userAgent: 'fake-codex/0.167.0',
        codexHome: '/tmp/fake-codex',
        platformFamily: 'unix',
        platformOs: 'macos',
      },
    });
    return;
  }

  if (msg.method === 'initialized') {
    return;
  }

  if (msg.method === 'thread/start') {
    activeThreadId = `codex_thr_${String(threadSeq++)}`;
    sendFrame({
      id: msg.id,
      result: {
        thread: { id: activeThreadId, cwd: msg.params?.cwd ?? process.cwd() },
        runtimeWorkspaceRoots: [msg.params?.cwd ?? process.cwd()],
        activePermissionProfile: null,
        multiAgentMode: 'explicitRequestOnly',
      },
    });
    return;
  }

  if (msg.method === 'thread/resume') {
    activeThreadId = msg.params?.threadId ?? `codex_thr_${String(threadSeq++)}`;
    sendFrame({
      id: msg.id,
      result: {
        thread: { id: activeThreadId, cwd: msg.params?.cwd ?? process.cwd(), resumed: true },
      },
    });
    return;
  }

  if (msg.method === 'turn/start') {
    const turnId = `codex_turn_${String(turnSeq++)}`;
    const threadId = msg.params?.threadId ?? activeThreadId ?? 'codex_thr_1';
    const promptText = msg.params?.input?.[0]?.text ?? '';
    sendFrame({
      id: msg.id,
      result: {
        turn: {
          id: turnId,
          rootTurnId: turnId,
          items: [],
          itemsView: 'notLoaded',
          status: 'inProgress',
          error: null,
        },
      },
    });
    void runTurn(turnId, threadId, promptText);
    return;
  }

  if (msg.method === 'turn/interrupt') {
    sendFrame({ id: msg.id, result: {} });
    if (activeTurn) {
      activeTurn.interrupted = true;
      for (const timer of activeTurn.timers) {
        clearTimeout(timer);
      }
      activeTurn.timers.clear();
      sendNotification('turn/completed', {
        threadId: activeTurn.threadId,
        turn: {
          id: activeTurn.turnId,
          rootTurnId: activeTurn.turnId,
          items: [],
          itemsView: 'summary',
          status: 'interrupted',
          error: null,
        },
      });
      activeTurn = null;
    }
  }
});

rl.on('close', () => {
  process.exit(0);
});
