export const PACKAGE_NAME = '@nuh/dsh-shims' as const;

export {
  HeadlessMnemonExecutor,
  isMnemonReadOnlyToolName,
  listMnemonReadOnlyTools,
  MNEMON_READONLY_TOOL_NAMES,
  type MnemonReadOnlyToolDefinition,
  type MnemonReadOnlyToolName,
  type MnemonToolCallOptions,
  type MnemonToolCallOutcome,
} from './mnemon.ts';
