import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

if (process.env.NUH_FAKE_AGY_PID_LOG) {
  appendFileSync(process.env.NUH_FAKE_AGY_PID_LOG, `${String(process.pid)}\n`, 'utf8');
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let sessionSeq = 1;
let callSeq = 1;
let serverReqSeq = 1;

const pendingApprovals = new Map();
const configState = {
  model: 'gemini-4-argon',
  thought_level: 'medium',
  mode: 'default',
};
let activePrompt = null;

function sendFrame(payload) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...payload })}\n`);
}

function sendSessionUpdate(sessionId, update) {
  sendFrame({
    method: 'session/update',
    params: { sessionId, update },
  });
}

function buildConfigOptions() {
  return [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: configState.model,
    },
    {
      id: 'thought_level',
      name: 'Thinking Level',
      category: 'thought_level',
      type: 'select',
      currentValue: configState.thought_level,
    },
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: configState.mode,
    },
  ];
}

function sendPermissionRequest(sessionId, toolCall) {
  // Spike 04 实测：AGY ACP 服务端主动审批请求 id 为字符串（如 "1"）
  const id = String(serverReqSeq++);
  return new Promise((resolve) => {
    pendingApprovals.set(id, resolve);
    sendFrame({
      id,
      method: 'session/request_permission',
      params: {
        sessionId,
        toolCall,
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
        ],
      },
    });
  });
}

function extractActivePrompt(promptText) {
  const marker = '[Current User Request]\n';
  const idx = promptText.lastIndexOf(marker);
  return idx === -1 ? promptText : promptText.slice(idx + marker.length);
}

async function handlePrompt(reqId, sessionId, promptText) {
  activePrompt = { reqId, sessionId, cancelled: false, timers: new Set(), resolveCancel: null };
  const promptRef = activePrompt;
  const activeDirective = extractActivePrompt(promptText);

  sendSessionUpdate(sessionId, {
    sessionUpdate: 'available_commands_update',
    availableCommands: [{ name: 'plan' }],
  });
  sendSessionUpdate(sessionId, {
    sessionUpdate: 'user_message_chunk',
    content: { type: 'text', text: promptText },
  });

  if (activeDirective.includes('CRASH_NOW')) {
    process.stderr.write('fake-agy diagnostic stderr before crash\n');
    process.exit(1);
  }

  if (activeDirective.includes('SLOW_STREAM')) {
    for (const piece of ['agy-slow-1 ', 'agy-slow-2 ', 'agy-slow-3 ']) {
      if (promptRef.cancelled) {
        return;
      }
      sendSessionUpdate(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: piece },
      });
      await new Promise((resolve) => {
        promptRef.resolveCancel = resolve;
        const timer = setTimeout(() => {
          promptRef.timers.delete(timer);
          promptRef.resolveCancel = null;
          resolve();
        }, 120);
        promptRef.timers.add(timer);
      });
    }
    if (!promptRef.cancelled) {
      sendFrame({
        id: reqId,
        result: {
          stopReason: 'end_turn',
          usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        },
      });
    }
    activePrompt = null;
    return;
  }

  if (activeDirective.includes('NEED_APPROVAL')) {
    const toolCallId = `call_${String(callSeq++)}`;
    const command = 'echo FAKE_AGY_CMD_OK';
    const baseTool = {
      sessionUpdate: 'tool_call',
      toolCallId,
      name: 'run_command',
      args: { CommandLine: command, WaitMsBeforeAsync: 5000 },
      status: 'in_progress',
      kind: 'execute',
      title: command,
      rawInput: { CommandLine: command },
    };
    sendSessionUpdate(sessionId, baseTool);
    sendSessionUpdate(sessionId, {
      ...baseTool,
      sessionUpdate: 'tool_call_update',
      status: 'pending',
    });

    const permRes = await sendPermissionRequest(sessionId, { ...baseTool, status: 'pending' });
    const optionId = permRes?.outcome?.optionId;

    sendSessionUpdate(sessionId, {
      ...baseTool,
      sessionUpdate: 'tool_call_update',
      status: 'in_progress',
    });

    if (optionId === 'allow') {
      sendSessionUpdate(sessionId, {
        ...baseTool,
        sessionUpdate: 'tool_call_update',
        status: 'completed',
        rawOutput: { output: 'FAKE_AGY_CMD_OK\n', exit_code: 0 },
      });
      sendSessionUpdate(sessionId, {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'agy-approved: FAKE_AGY_CMD_OK' },
      });
    } else {
      // Spike 04 实测约束：deny 后发送 status: "failed" 且不输出 agent_message_chunk
      sendSessionUpdate(sessionId, {
        ...baseTool,
        sessionUpdate: 'tool_call_update',
        status: 'failed',
        rawOutput: { output: '' },
      });
    }

    sendFrame({
      id: reqId,
      result: {
        stopReason: 'end_turn',
        usage: { inputTokens: 80, outputTokens: 18, totalTokens: 98 },
      },
    });
    activePrompt = null;
    return;
  }

  if (configState.thought_level === 'high') {
    sendSessionUpdate(sessionId, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'deep thinking...' },
    });
  }

  const reply = `agy-reply[model=${configState.model},thought=${configState.thought_level}]:${promptText}`;
  const mid = Math.max(1, Math.ceil(reply.length / 2));
  sendSessionUpdate(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: reply.slice(0, mid) },
  });
  sendSessionUpdate(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: reply.slice(mid) },
  });

  sendFrame({
    id: reqId,
    result: {
      stopReason: 'end_turn',
      usage: {
        inputTokens: 100,
        outputTokens: 25,
        cachedReadTokens: 5,
        thoughtTokens: configState.thought_level === 'high' ? 12 : 0,
        totalTokens: 125,
      },
    },
  });
  activePrompt = null;
}

rl.on('line', (line) => {
  if (!line.trim()) {
    return;
  }
  const msg = JSON.parse(line);

  if (msg.id !== undefined && msg.method === undefined) {
    const resolver = pendingApprovals.get(msg.id);
    if (resolver) {
      pendingApprovals.delete(msg.id);
      resolver(msg.result);
    }
    return;
  }

  if (msg.method === 'initialize') {
    sendFrame({
      id: msg.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          load_session: true,
          sessionCapabilities: { resume: {} },
          session_capabilities: { resume: {} },
          _meta: { antigravity: { tier: true } },
        },
        agentInfo: { name: 'Fake Antigravity ACP Server', version: '1.5.9' },
        authMethods: [],
      },
    });
    return;
  }

  if (msg.method === 'session/new') {
    const sessionId = `agy_sess_${String(sessionSeq++)}`;
    sendFrame({
      id: msg.id,
      result: {
        sessionId,
        configOptions: buildConfigOptions(),
      },
    });
    return;
  }

  if (msg.method === 'session/resume') {
    const sessionId = msg.params?.sessionId ?? `agy_sess_${String(sessionSeq++)}`;
    sendFrame({
      id: msg.id,
      result: {
        sessionId,
        configOptions: buildConfigOptions(),
      },
    });
    return;
  }

  if (msg.method === 'session/set_config_option') {
    const configId = msg.params?.configId;
    const value = msg.params?.value;
    if (configId === 'model' || configId === 'thought_level' || configId === 'mode') {
      configState[configId] = value;
    }
    const configOptions = buildConfigOptions();
    sendSessionUpdate(msg.params?.sessionId ?? 'agy_sess_1', {
      sessionUpdate: 'config_option_update',
      configOptions,
    });
    sendFrame({
      id: msg.id,
      result: { configOptions },
    });
    return;
  }

  if (msg.method === 'session/prompt') {
    const sessionId = msg.params?.sessionId ?? 'agy_sess_1';
    const promptText = msg.params?.prompt?.[0]?.text ?? '';
    void handlePrompt(msg.id, sessionId, promptText);
    return;
  }

  if (msg.method === 'session/cancel') {
    if (activePrompt) {
      activePrompt.cancelled = true;
      for (const timer of activePrompt.timers) {
        clearTimeout(timer);
      }
      activePrompt.timers.clear();
      const { reqId, resolveCancel } = activePrompt;
      activePrompt = null;
      resolveCancel?.();
      sendFrame({
        id: reqId,
        result: {
          stopReason: 'cancelled',
        },
      });
    }
  }
});

rl.on('close', () => {
  process.exit(0);
});
