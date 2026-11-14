import {
  type BackendKind,
  type BackendStatus,
  NUH_ERROR_CODES,
  NuhProtocolError,
} from '@nuh/protocol';
import { AgyAcpBackend, type AgyBackendOptions } from './agy-acp.ts';
import { ClaudeBackendPlaceholder } from './claude.ts';
import { CodexBackend, type CodexBackendOptions } from './codex.ts';
import type { AgentBackend, BackendDiagnosticLogger, BackendMcpServerConfig } from './types.ts';

const BACKEND_ORDER: readonly BackendKind[] = ['native-dsh', 'codex', 'claude', 'agy'];

/**
 * 统一后端注册表：集中管理 `native-dsh` / `codex` / `claude` / `agy` 适配器生命周期与状态查询。
 */
export class BackendRegistry {
  private readonly backends = new Map<BackendKind, AgentBackend>();

  register(backend: AgentBackend): this {
    this.backends.set(backend.kind, backend);
    return this;
  }

  get(kind: BackendKind): AgentBackend | undefined {
    return this.backends.get(kind);
  }

  require(kind: BackendKind): AgentBackend {
    const backend = this.backends.get(kind);
    if (!backend) {
      throw new NuhProtocolError(NUH_ERROR_CODES.BACKEND_UNAVAILABLE, `后端 "${kind}" 未注册`, {
        backend: kind,
      });
    }
    return backend;
  }

  async listStatuses(): Promise<BackendStatus[]> {
    const statuses: BackendStatus[] = [];
    for (const kind of BACKEND_ORDER) {
      const backend = this.backends.get(kind);
      if (backend) {
        statuses.push(await backend.getStatus());
      } else {
        statuses.push({
          kind,
          available: false,
          authenticated: false,
          reason: 'backend not registered',
        });
      }
    }
    return statuses;
  }

  async closeThreadOnAll(threadId: string, exceptKind?: BackendKind): Promise<void> {
    const tasks: Promise<void>[] = [];
    for (const [kind, backend] of this.backends.entries()) {
      if (exceptKind && kind === exceptKind) {
        continue;
      }
      if (backend.closeThread) {
        tasks.push(backend.closeThread(threadId));
      }
    }
    await Promise.all(tasks);
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.backends.values()].map((backend) => backend.dispose()));
  }
}

export interface DefaultBackendRegistryOptions {
  readonly logger?: BackendDiagnosticLogger;
  readonly codex?: CodexBackendOptions;
  readonly agy?: AgyBackendOptions;
  readonly nativeBackend?: AgentBackend;
  readonly mcpServers?: readonly BackendMcpServerConfig[];
}

export function createDefaultBackendRegistry(
  options: DefaultBackendRegistryOptions = {},
): BackendRegistry {
  const registry = new BackendRegistry();
  if (options.nativeBackend) {
    registry.register(options.nativeBackend);
  }
  registry.register(
    new CodexBackend({
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
      ...options.codex,
    }),
  );
  registry.register(new ClaudeBackendPlaceholder());
  registry.register(
    new AgyAcpBackend({
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
      ...options.agy,
    }),
  );
  return registry;
}
