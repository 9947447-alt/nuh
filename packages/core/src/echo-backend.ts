import { randomUUID } from 'node:crypto';
import type { AgentBackend, BackendTurnRequest } from '@nuh/backends';
import {
  type BackendKind,
  type BackendStatus,
  type NuhNormalizedEvent,
  NuhNormalizedEventSchema,
} from '@nuh/protocol';

export interface EchoTurnParams {
  readonly threadId: string;
  readonly turnId: string;
  readonly backend: BackendKind;
  readonly input: string;
  readonly signal: AbortSignal;
  readonly stepDelayMs?: number;
  readonly emit: (event: NuhNormalizedEvent) => Promise<void> | void;
}

export function resolveEchoStepDelayMs(explicitMs?: number): number {
  if (explicitMs !== undefined && Number.isFinite(explicitMs) && explicitMs >= 0) {
    return explicitMs;
  }
  const raw = process.env.NUH_ECHO_STEP_MS;
  if (raw !== undefined && raw.trim().length > 0) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return 10;
}

function splitEchoChunks(fullText: string): string[] {
  if (fullText.length <= 12) {
    return [fullText];
  }
  const third = Math.max(1, Math.ceil(fullText.length / 3));
  const chunks: string[] = [];
  for (let i = 0; i < fullText.length; i += third) {
    chunks.push(fullText.slice(i, i + third));
  }
  return chunks;
}

function waitAbortable(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) {
    return Promise.resolve(false);
  }
  if (ms <= 0) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 确定性 Echo/Fake 回合执行器：用于 Phase 1 Step 1.2 验证无头 Daemon 协议闭环与中断语义，
 * 不发起任何真实外部 LLM 网络请求。
 */
export async function runEchoTurn(params: EchoTurnParams): Promise<void> {
  const { threadId, turnId, backend, input, signal } = params;
  const itemId = `itm_${randomUUID().slice(0, 12)}`;
  const stepDelayMs = resolveEchoStepDelayMs(params.stepDelayMs);

  const emitValidated = async (rawEvent: NuhNormalizedEvent): Promise<void> => {
    const validated = NuhNormalizedEventSchema.parse(rawEvent);
    await params.emit(validated);
  };

  await emitValidated({
    type: 'turn/started',
    payload: {
      threadId,
      turnId,
      backend,
    },
  });

  if (signal.aborted) {
    await emitValidated({
      type: 'turn/completed',
      payload: {
        threadId,
        turnId,
        status: 'interrupted',
      },
    });
    return;
  }

  await emitValidated({
    type: 'item/started',
    payload: {
      threadId,
      turnId,
      itemId,
      kind: 'agent_message',
    },
  });

  const fullText = `[nuh-echo] ${input}`;
  const chunks = splitEchoChunks(fullText);

  for (const chunk of chunks) {
    if (signal.aborted) {
      await emitValidated({
        type: 'item/completed',
        payload: {
          threadId,
          turnId,
          itemId,
          status: 'cancelled',
        },
      });
      await emitValidated({
        type: 'turn/completed',
        payload: {
          threadId,
          turnId,
          status: 'interrupted',
        },
      });
      return;
    }

    await emitValidated({
      type: 'item/delta',
      payload: {
        threadId,
        turnId,
        itemId,
        channel: 'text',
        delta: chunk,
      },
    });

    const continued = await waitAbortable(stepDelayMs, signal);
    if (!continued) {
      await emitValidated({
        type: 'item/completed',
        payload: {
          threadId,
          turnId,
          itemId,
          status: 'cancelled',
        },
      });
      await emitValidated({
        type: 'turn/completed',
        payload: {
          threadId,
          turnId,
          status: 'interrupted',
        },
      });
      return;
    }
  }

  await emitValidated({
    type: 'item/completed',
    payload: {
      threadId,
      turnId,
      itemId,
      status: 'ok',
      summary: { text: fullText },
    },
  });

  const inputTokens = Math.max(1, input.length);
  const outputTokens = Math.max(1, fullText.length);
  await emitValidated({
    type: 'turn/completed',
    payload: {
      threadId,
      turnId,
      status: 'completed',
      usage: {
        billingType: 'api',
        backend,
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
    },
  });
}

/**
 * `native-dsh` 默认 Echo 适配器（Phase 1 无头基座确定性闭环实现）。
 */
export class NativeDshEchoBackend implements AgentBackend {
  readonly kind = 'native-dsh' as const;
  private readonly stepDelayMs: number | undefined;

  constructor(stepDelayMs?: number) {
    this.stepDelayMs = stepDelayMs;
  }

  async getStatus(): Promise<BackendStatus> {
    return {
      kind: 'native-dsh',
      available: true,
      authenticated: true,
      version: '0.2.2-rc.1',
      reason: 'headless deterministic echo loop active',
    };
  }

  async runTurn(request: BackendTurnRequest): Promise<void> {
    await runEchoTurn({
      threadId: request.threadId,
      turnId: request.turnId,
      backend: 'native-dsh',
      input: request.prompt,
      signal: request.signal,
      ...(this.stepDelayMs !== undefined ? { stepDelayMs: this.stepDelayMs } : {}),
      emit: request.emit,
    });
  }

  async dispose(): Promise<void> {
    // no external subprocess owned
  }
}
