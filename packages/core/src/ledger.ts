import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  ApprovalPolicySchema,
  type BackendKind,
  BackendKindSchema,
  ItemCompletedParamsSchema,
  ItemDeltaParamsSchema,
  ItemStartedParamsSchema,
  type LedgerSummaryEntry,
  NUH_ERROR_CODES,
  type NuhNormalizedEvent,
  NuhProtocolError,
  SandboxModeSchema,
  TurnCompletedParamsSchema,
  TurnStartedParamsSchema,
} from '@nuh/protocol';
import { z } from 'zod';

export const LedgerThreadStartedPayloadSchema = z.object({
  workdir: z.string().min(1),
  defaultBackend: BackendKindSchema,
  model: z.string().min(1).optional(),
  sandboxMode: SandboxModeSchema,
  approvalPolicy: ApprovalPolicySchema,
});

export const LedgerThreadBackendChangedPayloadSchema = z.object({
  backend: BackendKindSchema,
  model: z.string().min(1).optional(),
});

export const LedgerTurnInputPayloadSchema = z.object({
  turnId: z.string().min(1),
  backend: BackendKindSchema,
  input: z.string(),
});

const LedgerRecordBaseSchema = z.object({
  seq: z.number().int().positive(),
  ts: z.string().min(1),
  threadId: z.string().min(1),
});

export const LedgerRecordSchema = z.discriminatedUnion('kind', [
  LedgerRecordBaseSchema.extend({
    kind: z.literal('thread/started'),
    payload: LedgerThreadStartedPayloadSchema,
  }),
  LedgerRecordBaseSchema.extend({
    kind: z.literal('thread/backend_changed'),
    payload: LedgerThreadBackendChangedPayloadSchema,
  }),
  LedgerRecordBaseSchema.extend({
    kind: z.literal('turn/input'),
    payload: LedgerTurnInputPayloadSchema,
  }),
  LedgerRecordBaseSchema.extend({
    kind: z.literal('turn/started'),
    payload: TurnStartedParamsSchema,
  }),
  LedgerRecordBaseSchema.extend({
    kind: z.literal('item/started'),
    payload: ItemStartedParamsSchema,
  }),
  LedgerRecordBaseSchema.extend({
    kind: z.literal('item/delta'),
    payload: ItemDeltaParamsSchema,
  }),
  LedgerRecordBaseSchema.extend({
    kind: z.literal('item/completed'),
    payload: ItemCompletedParamsSchema,
  }),
  LedgerRecordBaseSchema.extend({
    kind: z.literal('turn/completed'),
    payload: TurnCompletedParamsSchema,
  }),
]);

export type LedgerRecord = z.infer<typeof LedgerRecordSchema>;

export function resolveDefaultNuhHome(): string {
  const fromEnv = process.env.NUH_HOME?.trim();
  if (fromEnv && fromEnv.length > 0) {
    return path.resolve(fromEnv);
  }
  return path.join(homedir(), '.nuh');
}

/**
 * 线程级只读审计账本（append-only `ledger.jsonl`）。
 * 按 `threadId` 串行化异步追加写入，确保 NDJSON 行原子落盘与严格时序。
 */
export class AuditLedger {
  readonly nuhHome: string;
  private readonly seqByThread = new Map<string, number>();
  private readonly writeChainByThread = new Map<string, Promise<void>>();
  private readonly ensuredDirs = new Set<string>();

  constructor(nuhHome: string = resolveDefaultNuhHome()) {
    this.nuhHome = path.resolve(nuhHome);
  }

  getThreadDir(threadId: string): string {
    return path.join(this.nuhHome, 'threads', threadId);
  }

  getLedgerPath(threadId: string): string {
    return path.join(this.getThreadDir(threadId), 'ledger.jsonl');
  }

  private nextSeq(threadId: string): number {
    const next = (this.seqByThread.get(threadId) ?? 0) + 1;
    this.seqByThread.set(threadId, next);
    return next;
  }

  private enqueueWrite(threadId: string, record: LedgerRecord): Promise<void> {
    const validated = LedgerRecordSchema.parse(record);
    const line = `${JSON.stringify(validated)}\n`;
    const ledgerPath = this.getLedgerPath(threadId);
    const threadDir = path.dirname(ledgerPath);
    const prev = this.writeChainByThread.get(threadId) ?? Promise.resolve();

    const next = prev.then(async () => {
      if (!this.ensuredDirs.has(threadDir)) {
        await mkdir(threadDir, { recursive: true });
        this.ensuredDirs.add(threadDir);
      }
      await appendFile(ledgerPath, line, { encoding: 'utf8', flag: 'a' });
    });

    this.writeChainByThread.set(
      threadId,
      next.catch(() => undefined),
    );
    return next;
  }

  appendThreadStarted(
    threadId: string,
    payload: z.infer<typeof LedgerThreadStartedPayloadSchema>,
  ): Promise<void> {
    return this.enqueueWrite(threadId, {
      seq: this.nextSeq(threadId),
      ts: new Date().toISOString(),
      threadId,
      kind: 'thread/started',
      payload,
    });
  }

  appendThreadBackendChanged(
    threadId: string,
    payload: z.infer<typeof LedgerThreadBackendChangedPayloadSchema>,
  ): Promise<void> {
    return this.enqueueWrite(threadId, {
      seq: this.nextSeq(threadId),
      ts: new Date().toISOString(),
      threadId,
      kind: 'thread/backend_changed',
      payload,
    });
  }

  appendTurnInput(
    threadId: string,
    payload: {
      readonly turnId: string;
      readonly backend: BackendKind;
      readonly input: string;
    },
  ): Promise<void> {
    return this.enqueueWrite(threadId, {
      seq: this.nextSeq(threadId),
      ts: new Date().toISOString(),
      threadId,
      kind: 'turn/input',
      payload,
    });
  }

  appendNormalizedEvent(event: NuhNormalizedEvent): Promise<void> {
    const threadId = event.payload.threadId;
    const seq = this.nextSeq(threadId);
    const ts = new Date().toISOString();
    switch (event.type) {
      case 'turn/started':
        return this.enqueueWrite(threadId, {
          seq,
          ts,
          threadId,
          kind: 'turn/started',
          payload: event.payload,
        });
      case 'item/started':
        return this.enqueueWrite(threadId, {
          seq,
          ts,
          threadId,
          kind: 'item/started',
          payload: event.payload,
        });
      case 'item/delta':
        return this.enqueueWrite(threadId, {
          seq,
          ts,
          threadId,
          kind: 'item/delta',
          payload: event.payload,
        });
      case 'item/completed':
        return this.enqueueWrite(threadId, {
          seq,
          ts,
          threadId,
          kind: 'item/completed',
          payload: event.payload,
        });
      case 'turn/completed':
        return this.enqueueWrite(threadId, {
          seq,
          ts,
          threadId,
          kind: 'turn/completed',
          payload: event.payload,
        });
    }
  }

  async flush(): Promise<void> {
    await Promise.all(this.writeChainByThread.values());
  }

  async readThreadEntries(threadId: string): Promise<LedgerRecord[]> {
    await (this.writeChainByThread.get(threadId) ?? Promise.resolve());
    const ledgerPath = this.getLedgerPath(threadId);
    if (!existsSync(ledgerPath)) {
      return [];
    }
    const content = await readFile(ledgerPath, 'utf8');
    const lines = content.split('\n').filter((line) => line.trim().length > 0);
    const records: LedgerRecord[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line === undefined) {
        continue;
      }
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(line) as unknown;
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new NuhProtocolError(
          NUH_ERROR_CODES.INTERNAL_ERROR,
          `ledger.jsonl 第 ${index + 1} 行 JSON 解析失败: ${detail}`,
          { ledgerPath, lineNumber: index + 1 },
        );
      }
      const validated = LedgerRecordSchema.safeParse(parsedJson);
      if (!validated.success) {
        throw new NuhProtocolError(
          NUH_ERROR_CODES.PROTOCOL_VALIDATION_ERROR,
          `ledger.jsonl 第 ${index + 1} 行结构校验失败`,
          { ledgerPath, lineNumber: index + 1, issues: validated.error.issues },
        );
      }
      records.push(validated.data);
    }
    return records;
  }

  async summarizeThread(threadId: string): Promise<LedgerSummaryEntry[]> {
    const records = await this.readThreadEntries(threadId);
    const turnBackends = new Map<string, BackendKind>();
    const assistantBuffers = new Map<string, string>();
    const summary: LedgerSummaryEntry[] = [];

    for (const record of records) {
      if (record.kind === 'turn/input') {
        turnBackends.set(record.payload.turnId, record.payload.backend);
        summary.push({
          role: 'user',
          backend: record.payload.backend,
          summary: record.payload.input,
          timestamp: record.ts,
        });
      } else if (record.kind === 'item/delta' && record.payload.channel === 'text') {
        const prev = assistantBuffers.get(record.payload.itemId) ?? '';
        assistantBuffers.set(record.payload.itemId, `${prev}${record.payload.delta}`);
      } else if (record.kind === 'item/completed') {
        const buffered = assistantBuffers.get(record.payload.itemId);
        if (buffered !== undefined) {
          summary.push({
            role: 'assistant',
            backend: turnBackends.get(record.payload.turnId) ?? 'native-dsh',
            summary: buffered,
            timestamp: record.ts,
          });
          assistantBuffers.delete(record.payload.itemId);
        }
      }
    }

    return summary;
  }
}
