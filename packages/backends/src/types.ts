import type {
  ApprovalPolicy,
  ApprovalRequestedParams,
  ApprovalRequestedResult,
  BackendKind,
  BackendStatus,
  NuhNormalizedEvent,
  SandboxMode,
  ThoughtLevel,
} from '@nuh/protocol';

export type DiagnosticLogLevel = 'debug' | 'info' | 'warn' | 'error';

export type BackendDiagnosticLogger = (
  level: DiagnosticLogLevel,
  message: string,
  meta?: unknown,
) => void;

export type BackendEventEmitter = (event: NuhNormalizedEvent) => Promise<void> | void;

export type BackendApprovalRequester = (
  params: ApprovalRequestedParams,
) => Promise<ApprovalRequestedResult>;

export interface BackendMcpServerConfig {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface BackendTurnRequest {
  readonly threadId: string;
  readonly turnId: string;
  readonly workdir: string;
  readonly prompt: string;
  readonly model?: string;
  readonly thoughtLevel?: ThoughtLevel;
  readonly sandboxMode: SandboxMode;
  readonly approvalPolicy: ApprovalPolicy;
  readonly backendSessionId?: string;
  readonly mcpServers?: readonly BackendMcpServerConfig[];
  readonly onBackendSessionId?: (backendSessionId: string) => void;
  readonly signal: AbortSignal;
  readonly emit: BackendEventEmitter;
  readonly requestApproval: BackendApprovalRequester;
}

export interface BackendSessionConfig {
  readonly model?: string;
  readonly thoughtLevel?: ThoughtLevel;
}

/**
 * 统一后端适配器契约（`@nuh/backends`）。
 * 所有实现必须通过 `@nuh/protocol` 完成报文校验与事件归一化，严禁向核心调度层泄漏底层 CLI 私有格式。
 */
export interface AgentBackend {
  readonly kind: BackendKind;
  getStatus(): Promise<BackendStatus>;
  runTurn(request: BackendTurnRequest): Promise<void>;
  configureSession?(threadId: string, config: BackendSessionConfig): Promise<void>;
  closeThread?(threadId: string): Promise<void>;
  dispose(): Promise<void>;
}
