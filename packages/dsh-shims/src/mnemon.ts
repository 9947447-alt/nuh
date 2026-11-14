import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { type AgentHandle, assembleContextFor } from '@deepseek-ai/dsh-agent';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import type { JsonSchemaNode } from '@deepseek-ai/dsh-tools';

/**
 * Only non-mutating, non-approval-blocking memory retrieval & inspection tools
 * may be surfaced across NUH MCP Bridge to external backends.
 */
export const MNEMON_READONLY_TOOL_NAMES = [
  'mnemon_recall',
  'mnemon_related',
  'mnemon_document_search',
  'mnemon_memory_bodies',
  'mnemon_status',
] as const;

export type MnemonReadOnlyToolName = (typeof MNEMON_READONLY_TOOL_NAMES)[number];

const MNEMON_READONLY_TOOL_SET: ReadonlySet<string> = new Set(MNEMON_READONLY_TOOL_NAMES);

export function isMnemonReadOnlyToolName(name: string): name is MnemonReadOnlyToolName {
  return MNEMON_READONLY_TOOL_SET.has(name);
}

export interface MnemonReadOnlyToolDefinition {
  readonly name: MnemonReadOnlyToolName;
  readonly description: string;
  readonly inputSchema: JsonSchemaNode;
}

export interface MnemonToolCallOptions {
  readonly cwd?: string;
  readonly signal?: AbortSignal;
}

export interface MnemonToolCallOutcome {
  readonly isError: boolean;
  readonly text: string;
  readonly structuredContent?: Record<string, unknown>;
  readonly errorMessage?: string;
}

interface WorkspaceRunner {
  tail: Promise<void>;
  handle: AgentHandle | undefined;
  nextTurn: number;
}

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Lists read-only `dsh-mnemon` tools registered in Cordis `ctx.tools`.
 */
export function listMnemonReadOnlyTools(ctx: Context): MnemonReadOnlyToolDefinition[] {
  const toolsService = typeof ctx.get === 'function' ? ctx.get('tools') : ctx.tools;
  if (!toolsService) {
    return [];
  }
  const result: MnemonReadOnlyToolDefinition[] = [];
  for (const definition of toolsService.definitions()) {
    if (!isMnemonReadOnlyToolName(definition.name)) {
      continue;
    }
    result.push({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.parameters,
    });
  }
  return result;
}

/**
 * Executes whitelisted read-only `dsh-mnemon` tools inside a headless DSH
 * runtime without an active LLM loop.
 *
 * `dsh-mnemon` requires a live `Agent` with an open session turn and
 * `systemPrompt.assemble` having pinned the Memory View for that turn. This
 * shim acquires/reuses a per-workspace `AgentHandle`, serializes calls per
 * workspace, brackets each invocation with `turn/start` .. `turn/end`, and
 * disposes every handle on shutdown.
 */
export class HeadlessMnemonExecutor {
  private readonly ctx: Context;
  private readonly defaultWorkspaceRoot: string;
  private readonly workspaces = new Map<string, WorkspaceRunner>();
  private sessionCounter = 0;
  private disposed = false;

  constructor(ctx: Context, defaultWorkspaceRoot: string) {
    this.ctx = ctx;
    this.defaultWorkspaceRoot = path.resolve(defaultWorkspaceRoot);
  }

  listTools(): MnemonReadOnlyToolDefinition[] {
    if (this.disposed) {
      return [];
    }
    return listMnemonReadOnlyTools(this.ctx);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: MnemonToolCallOptions = {},
  ): Promise<MnemonToolCallOutcome> {
    if (!isMnemonReadOnlyToolName(name)) {
      throw new Error(`Tool "${name}" is not allowed on the read-only mnemon bridge`);
    }
    if (this.disposed) {
      throw new Error('HeadlessMnemonExecutor has been disposed');
    }

    const resolvedCwd = path.resolve(options.cwd ?? this.defaultWorkspaceRoot);
    const runner = this.getOrCreateRunner(resolvedCwd);

    return this.enqueue(runner, () =>
      this.executeInsideTurn(runner, resolvedCwd, name, args, options.signal),
    );
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const runners = [...this.workspaces.values()];
    await Promise.allSettled(runners.map((runner) => runner.tail));
    await Promise.allSettled(
      runners.map(async (runner) => {
        const handle = runner.handle;
        runner.handle = undefined;
        if (handle) {
          await handle.dispose();
        }
      }),
    );
    this.workspaces.clear();
  }

  private getOrCreateRunner(resolvedCwd: string): WorkspaceRunner {
    let runner = this.workspaces.get(resolvedCwd);
    if (!runner) {
      runner = {
        tail: Promise.resolve(),
        handle: undefined,
        nextTurn: 0,
      };
      this.workspaces.set(resolvedCwd, runner);
    }
    return runner;
  }

  private enqueue<T>(runner: WorkspaceRunner, task: () => Promise<T>): Promise<T> {
    const run = runner.tail.then(task);
    runner.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async ensureHandle(runner: WorkspaceRunner, resolvedCwd: string): Promise<AgentHandle> {
    if (this.disposed) {
      throw new Error('HeadlessMnemonExecutor has been disposed');
    }
    if (runner.handle) {
      return runner.handle;
    }
    const sessionId = SessionId(
      `nuh-mnemon-ro-${process.pid}-${++this.sessionCounter}-${Date.now().toString(36)}`,
    );
    const handle = await this.ctx.agents.create({
      sessionId,
      meta: { cwd: resolvedCwd },
    });
    if (this.disposed) {
      await handle.dispose();
      throw new Error('HeadlessMnemonExecutor was disposed during agent initialization');
    }
    runner.handle = handle;
    return handle;
  }

  private async executeInsideTurn(
    runner: WorkspaceRunner,
    resolvedCwd: string,
    name: MnemonReadOnlyToolName,
    args: Record<string, unknown>,
    callerSignal?: AbortSignal,
  ): Promise<MnemonToolCallOutcome> {
    const handle = await this.ensureHandle(runner, resolvedCwd);
    const agent = handle.agent;
    const turn = ++runner.nextTurn;
    const timeoutSignal = AbortSignal.timeout(DEFAULT_TOOL_TIMEOUT_MS);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;

    agent.session.append('turn/start', { turn });
    try {
      await this.ctx.systemPrompt.assemble(assembleContextFor(agent, signal));
      const callId = ToolCallId(`mnemon_${turn}_${Date.now().toString(36)}`);
      const batch = await this.ctx.tools.execute({
        calls: [
          {
            type: 'tool-call',
            id: callId,
            name,
            arguments: JSON.stringify(args),
          },
        ],
        signal,
        agent,
      });

      const entry = batch.results[0];
      if (!entry) {
        throw new Error(`Tool "${name}" produced no execution result`);
      }

      const result = entry.result;
      const text = result.content
        .map((block) => (block.type === 'text' ? block.text : JSON.stringify(block)))
        .join('\n');

      if (result.isError) {
        return {
          isError: true,
          text: text || result.error.message,
          errorMessage: result.error.message,
        };
      }

      const structuredContent = isPlainRecord(result.value) ? result.value : undefined;
      return {
        isError: false,
        text,
        ...(structuredContent ? { structuredContent } : {}),
      };
    } finally {
      agent.session.append('turn/end', { turn, reason: { kind: 'completed' } });
    }
  }
}
