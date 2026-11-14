import { type BackendStatus, NUH_ERROR_CODES, NuhProtocolError } from '@nuh/protocol';
import type { AgentBackend, BackendSessionConfig, BackendTurnRequest } from './types.ts';

/**
 * Claude CLI 预留适配器（Phase 1 Step 1.3 仅预留接口，不强行实现）。
 * 待具备有效 `claude` 登录态与真实双向 `stream-json` Fixtures 后补齐。
 */
export class ClaudeBackendPlaceholder implements AgentBackend {
  readonly kind = 'claude' as const;

  async getStatus(): Promise<BackendStatus> {
    return {
      kind: 'claude',
      available: false,
      authenticated: false,
      reason: 'NOT_CONFIGURED',
    };
  }

  async runTurn(_request: BackendTurnRequest): Promise<void> {
    throw new NuhProtocolError(
      NUH_ERROR_CODES.BACKEND_UNAVAILABLE,
      'Claude backend is NOT_CONFIGURED: 仅预留类型接口，待有效登录态后实现',
      { code: 'NOT_CONFIGURED', backend: 'claude' },
    );
  }

  async configureSession(_threadId: string, _config: BackendSessionConfig): Promise<void> {
    throw new NuhProtocolError(
      NUH_ERROR_CODES.BACKEND_UNAVAILABLE,
      'Claude backend is NOT_CONFIGURED',
      { code: 'NOT_CONFIGURED', backend: 'claude' },
    );
  }

  async closeThread(_threadId: string): Promise<void> {
    // no-op for unconfigured placeholder
  }

  async dispose(): Promise<void> {
    // no-op for unconfigured placeholder
  }
}
