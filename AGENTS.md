# NUH (Next Universal Harness) Workspace Rules

## 1. 架构红线（不可逾越）
- **禁止魔改 DSH 核心**：严禁复制、Fork 或修改 `@deepseek-ai/dsh-base` 及 DSH 上游源码。所有扩展能力必须以标准 Cordis 插件形式编写在 `packages/plugins/*` 下；若确需兼容补丁，必须沉淀在 `packages/dsh-shims/` 并附带明确的回归测试。
- **前端开发冻结**：在 Phase 3 验收完成前，严禁引入任何 TUI 框架（ink/blessed）、Web 前端（React/Vite）或 Desktop 壳（Electron/Tauri）。除 `apps/cli-repl`（仅限纯标准输入输出调试）外，一切交互必须通过 JSON-RPC 2.0 守护协议暴露。
- **协议即边界**：`packages/protocol` 是全仓库唯一的通信契约层。任何后端适配器（`codex` / `claude` / `agy` / `native-dsh`）不得向核心调度层泄漏各自私有的 CLI 输出格式，必须先完成事件归一化再上送。

## 2. 技术栈与工程纪律
- **运行环境基线**：Node.js `>=26.4.0`、pnpm `>=11.9.0`、TypeScript `strict: true`（禁用 `any` 与隐式类型断言，外部 CLI 输出必须经过 Zod/TypeBox 运行时校验）。
- **子进程安全**：所有托管 CLI 子进程（`codex`、`claude`、`agy`）必须显式绑定父进程退出清理钩子（SIGINT/SIGTERM/exit 时级联清理），`stderr` 仅用于结构化日志记录，严禁将其混入 JSON-RPC 解析流。
- **依赖锁定**：`@deepseek-ai/*` 相关包必须锁定精确版本号，禁止使用 `^` 或 `~`。

## 3. 编码 Agent 交付门禁（Definition of Done）
每次任务提交前必须通过以下全部检查，否则视为未完成：
1. `pnpm typecheck`：全量 TypeScript 类型检查零错误。
2. `pnpm test:contract`：针对 `packages/protocol` 与后端适配器的契约测试（基于真实 CLI 抓包 Fixtures）全部通过。
3. **无静默降级**：禁止用 `try { ... } catch { return null }` 吞掉协议解析错误或子进程异常，所有失败必须转换为明确的 JSON-RPC Error Code。
