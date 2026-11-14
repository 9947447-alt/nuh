# NUH（Next Universal Harness）Phase 0 完成事实与工程现状总报告

> **报告范围**：汇总自项目初始化（Commit [`36bb35f`](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/.git)）至当前工作区为止所有**已实际执行并落地**的文档、Spike 实测事实、Monorepo 骨架与待闭环缺口。  
> **记录原则**：本报告仅陈述在本地仓库文件、终端命令与抓包样本中直接观测到的事实，不作未验证的推断。

---

## 一、 总览：当前进度矩阵

| 工作模块 | 对应目录 / 文件 | 当前状态 | 关键结论摘要 |
| :--- | :--- | :--- | :--- |
| **前置评估与架构/协议规划** | [docs/](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/docs)（Commit `36bb35f`） | **已完成** | 确立“方案 C（协议隔离 + DSH/Cordis 底座 + 可演进至独立引擎）”及 `PROTOCOL-v0.1` 草案 |
| **Spike 01：`codex app-server`** | [spikes/01-codex-app-server/](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/spikes/01-codex-app-server/REPORT.md) | **已跑通** | 导出 TS 绑定；无 `OPENAI_API_KEY` 纯走 ChatGPT Plus 订阅态跑通工具执行与服务端审批回包 |
| **Spike 02：`dsh-base` 无头与插件** | [spikes/02-dsh-headless/](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/spikes/02-dsh-headless/REPORT.md) | **已跑通** | Node `v26.4.0` 下无头启动成功；明确 `dsh-mnemon` 与 `@opfield/dsh-mcp-hub` 的补齐/桩方案 |
| **Spike 03：`codex sandbox` / `claude` CLI** | `spikes/03-*`（未创建） | **未落地 / 受阻** | 仓库无 `spikes/03-*`；`codex sandbox` 尚未实测；本机无 Claude 账户（`loggedIn: false`） |
| **Spike 04：`agy` CLI（ACP vs stream-json）** | [spikes/04-agy-cli/](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/spikes/04-agy-cli/REPORT.md) | **已跑通** | 锁定 `agy acp --stdio` 为唯一主路径（支持审批拦截与跨进程恢复）；否定 `-p stream-json` 降级路径 |
| **Spike 05：MCP Bridge 动态注入** | [spikes/05-mcp-bridge/](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/spikes/05-mcp-bridge/REPORT.md) | **Codex 通过 / Claude 受限于未登录** | Codex `-c mcp_servers...` 实调工具成功；Claude `--mcp-config` 可拉起连接 MCP Server，但 API 侧报未登录 |
| **根目录 `pnpm` Monorepo 空壳** | [package.json](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/package.json)、[packages/](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/packages)、[apps/cli-repl/](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/apps/cli-repl) | **已完成** | 6 个工作区空壳包 + `tsconfig.base.json` + `AGENTS.md` 软链 + `pnpm typecheck` 零错误通过 |

---

## 二、 本机实测环境基线

| 组件 | 实测路径 / 版本 | 本机认证与可用状态 |
| :--- | :--- | :--- |
| **OS / Arch** | macOS (`darwin/arm64`) | 就绪 |
| **Node.js** | `v26.4.0` | 就绪（满足 `>=26.4.0` 基线） |
| **pnpm** | `11.25.0`（规划基线为 `>=11.9.0`） | 就绪 |
| **Codex CLI** | `/opt/homebrew/bin/codex`（`codex-cli 0.167.0`） | `codex login status`：`Logged in using ChatGPT`（`planType: "plus"`），可用 |
| **Antigravity CLI (`agy`)** | `/Users/a0000/.local/bin/agy`（`1.5.9`） | 复用本机 Antigravity OAuth（`Google AI Pro` / `g1-pro-tier`），可用 |
| **Claude Code CLI (`claude`)** | `/Users/a0000/.local/bin/claude`（`2.1.218`） | `claude auth status`：`loggedIn: false, authMethod: "none"`（本机无账户，无法发起模型回合） |
| **DSH 运行时包** | `@deepseek-ai/dsh-base@0.2.2-rc.1`、`@deepseek-ai/cordis@4.1.0` | 通过 `pnpm` 安装并在 Node `v26.4.0` 下无头验证通过 |

---

## 三、 前置架构与规划工作（Commit `36bb35f`）

项目首个阶段产出并提交了总体架构、协议草案、Phase 0 清单与工程红线约束（原始评估长文留存于 Git Commit `36bb35f` 版本的 `report.md`）：

1. **[ARCHITECTURE.md](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/docs/ARCHITECTURE.md)**：确立 **方案 C（协议隔离 + DSH/Cordis 微内核底座 + 绞杀者演进至独立引擎）** 架构，定义 `AgentBackend` 统一抽象（`native-dsh` / `codex` / `claude` / `agy`）、`SessionMappingStore` 主账本跨后端交接机制、`@nuh/mcp-bridge` 反向注入思路与双层安全防线（`execpolicy` + OS 沙箱）。
2. **[PLAN.md](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/docs/PLAN.md)**：制定 Phase 0–Phase 4 WBS 里程碑与 Scope Guard。
3. **[PHASE0-CHECKLIST.md](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/docs/PHASE0-CHECKLIST.md)**：定义 Phase 0 实操验证清单与准出条件。
4. **[PROTOCOL-v0.1.md](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/docs/PROTOCOL-v0.1.md)**：定义 `NUH JSON-RPC 2.0`（NDJSON over `stdio://` 与 `ws://127.0.0.1:<port>`）草案，覆盖 `initialize`、`thread/{start,resume,setBackend}`、`turn/{start,interrupt}`、`item/{started,delta,completed}` 与服务端主动审批 `approval/requested`。
5. **[AGENTS.md](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/AGENTS.md)**：锁定三条架构红线（禁止魔改 DSH 核心、Phase 3 验收前冻结前端开发、协议即边界）、运行基线与交付门禁（`pnpm typecheck`、`pnpm test:contract`、禁止静默降级）。

---

## 四、 Phase 0 各 Spike 实测事实汇总

### 4.1 Spike 01：`codex app-server` 协议导出与订阅额度实测

- **目录与脚本**：[spikes/01-codex-app-server/spike.mjs](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/spikes/01-codex-app-server/spike.mjs)、[REPORT.md](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/spikes/01-codex-app-server/REPORT.md)
- **协议生成物**：通过 `codex app-server generate-ts` 在 `spikes/01-codex-app-server/generated-ts/` 导出官方 TypeScript 类型（**97 个顶层文件 + `v2/` 下 665 个文件**）。
- **捕获样本**：[`fixtures/`](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/spikes/01-codex-app-server/fixtures) 下保存 `client-stdin.ndjson`（7 条）、`server-stdout.ndjson`（105 条）、`roundtrip.jsonl`（112 条）。
- **核心验证结果**：
  - 显式删除 `OPENAI_API_KEY` 后，通过 `initialize` → `initialized` → `account/read` / `getAuthStatus`（确认 `chatgpt` / `plus`）→ `thread/start`（`sandbox: "read-only"`, `approvalPolicy: "untrusted"`, `ephemeral: true`）→ `turn/start` 跑通完整回合。
  - 模型触发 `/bin/zsh -lc 'ls -la'` 时收到服务端主动请求 `item/commandExecution/requestApproval`（`id: 0`），回复 `{ "decision": "accept" }` 后收到 `serverRequest/resolved` 并完成执行；退出时通过 `SIGINT`/`SIGTERM`/`exit` 钩子干净回收子进程（`code=0`）。
- **关键协议坑点（契约层必须处理）**：
  1. `codex app-server` 下行报文**省略 `"jsonrpc": "2.0"`**，Zod/TypeBox 校验不得强制要求该字段。
  2. 服务端主动请求 `id` 从 `0` 递增，与客户端 `id` 命名空间独立，分派层必须同时检测 `id !== undefined && method !== undefined`。
  3. 线上实测报文包含非 `--experimental` 导出定义之外的字段（如顶层 `emittedAtMs`、`availableDecisions`、`workspaceRouting`、`runtimeWorkspaceRoots` 等），运行时解析必须允许未知字段透传。
  4. `turn/completed` 的 `turn.items` 仅含摘要视图（`itemsView: "summary"`），必须订阅流式 `item/started` / `item/*/delta` / `item/completed` 归档完整日志。
  5. 传入非 `null` 的 `capabilities` 时，`experimentalApi` 与 `requestAttestation` 为必填布尔值。

### 4.2 Spike 02：`@deepseek-ai/dsh-base` 无头兼容与社区插件缺口实测

- **目录与脚本**：[spikes/02-dsh-headless/spike.mjs](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/spikes/02-dsh-headless/spike.mjs)、[package.json](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/spikes/02-dsh-headless/package.json)、[REPORT.md](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/spikes/02-dsh-headless/REPORT.md)
- **版本陷阱与安装发现**：
  - `@deepseek-ai/dsh-base` npm `latest` 标签仍停留在 `0.0.1-rc.1`，实际与 `@deepseek-ai/dsh@0.2.2-rc.1` 对齐的版本须精确锁定 `0.2.2-rc.1`。
  - `pnpm install` 会因 5 个构建脚本（`@deepseek-ai/dsh-subprocess-local`、`node-pty`、`koffi`、`@google/genai`、`protobufjs`）触发 `ERR_PNPM_IGNORED_BUILDS`；实测在 `darwin/arm64` + Node `v26.4.0` 下 `node-pty@1.2.0-beta.15`（`spawn-helper` 权限已为 `100755`）与 `koffi@3.1.1` 无需本机编译即可加载，但正式 Monorepo 需在 `pnpm-workspace.yaml` 的 `allowBuilds` 显式声明。
- **核心验证结果**：
  - **基座启动**：通过 `@deepseek-ai/dsh-app-boot` 的 `initProfile` + `loadProfileDirectory` + `createRuntimeResolution` + `PluginPackages` 挂载 `@deepseek-ai/dsh-base@0.2.2-rc.1`（`cordis.yml` 须位于 `$DSH_HOME/profiles/<name>/` 下），启动耗时 **~581–626 ms**，98 个 Loader 条目中 **89 `ACTIVE` / 9 `DISABLED` / 0 `FAILED`**，提供 **55 个 Cordis 服务**、默认注册 **25 个工具**。
  - **独立无头包评估**：`dsh-headless` / `dsh-sdk-minimal` / `dsh-acp-app` 脱离 CLI 启动器时均强依赖 `cmdlineArgs` 服务而抛出 `StartupError`，因此 NUH Daemon 应直接基于 **`dsh-base` + `dsh-app-boot`** 自组装 Profile。
  - **自定义插件生命周期**：挂载 `nuh-probe-plugin` 后 `ctx.tools` 注册 `nuh_probe_ping`（返回 `{ reply: 'pong' }`）且 `ctx.systemPrompt.assemble()` 生效；`fiber.dispose()` 后工具、Prompt 片段与 `ctx.effect()` 清理钩子全部完整释放。
  - **`dsh-mnemon@0.5.45`**：裸跑 `dsh-base` 时因缺少 `settings` 停留在 `PENDING`；由宿主提供最小 `profileContext` 并启用 `settings`（同时保持 `hmr` 禁用，避免 `Profile HMR requires application readiness` 报错）后，无需 `webServer`/`connection` 即可全量激活并向 `ctx.tools` 注册 **17 个记忆工具**（另发现需等待 `loader?.await?.()` 异步迁移完成后再 `dispose` 以防竞态警告）。
  - **`@opfield/dsh-mcp-hub@0.4.2`**（注意无 scope 的 `dsh-mcp-hub@0.0.1` 为空占坑包）：存在双重缺口——(1) 硬依赖 `ctx.webServer.register` 与 `ctx.connection.requestRejection`；(2) `install.js` 通过 `process.argv` / `DSH_NODE_MODULES` 向宿主借用 `@deepseek-ai/dsh-mcp-client`、`@modelcontextprotocol/client`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-subprocess` 5 个包（`dsh-base` 默认不携带 `dsh-mcp-client`）。需在 `@nuh/dsh-shims` 与 Daemon 依赖树中补齐。

### 4.3 Spike 04：`agy` CLI（`agy acp` vs `-p stream-json`）对比实测

- **目录与脚本**：[spikes/04-agy-cli/](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/spikes/04-agy-cli/REPORT.md) 下的 5 个脚本（`spike-acp.mjs`、`spike-acp-extra.mjs`、`spike-stream-json.mjs`、`spike-perm-and-bidir.mjs`、`spike-stream-json-bidir.mjs`）及 16 份原始样本（[`fixtures/`](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/spikes/04-agy-cli/fixtures)）。
- **核心结论**：**Phase 1 及 `@nuh/backends` 单轨主攻 `agy acp --stdio`，砍掉 `-p --output-format stream-json` 作为异常自动降级路径**。
  - **`agy acp --stdio` 实测表现**：`initialize` 耗时 `52.06–70.73ms`、`session/new` 耗时 `2.17–2.56s`、跨进程 `session/resume` 耗时 `3.00s`；支持 `session/set_config_option` 毫秒级热切换模型（`1.07ms`）与思考强度（`0.79ms`）；支持 `session/request_permission` 双向审批（`allow` 立即放行，`deny` 精确阻断且磁盘未建测试文件）；`acp-stderr.log` 全程 `0` 字节。另需注意服务端主动请求 `id` 为字符串 `"1"`，且 `agentCapabilities` 混用驼峰与下划线键名。
  - **`agy -p --output-format stream-json` 否决原因**：每轮冷启至 `init` 需 `4.60–7.47s`；协议私有且 `--input-format stream-json` 不兼容 Claude 格式；最关键的是**安全契约失效**——即使未传 `--dangerously-skip-permissions`（且 `init` 声明 `"permission_mode":"request-review"`），仍直接无审批执行 `touch /tmp/nuh_agy_perm_probe && rm ...`（`exit_code: 0`）。崩溃恢复应采用 `agy acp` 重启 + `session/resume`，而非降级到 `-p`。

### 4.4 Spike 05：`@modelcontextprotocol/sdk` 最小 `stdio` MCP Server 动态注入实测

- **目录与文件**：[spikes/05-mcp-bridge/server.mjs](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/spikes/05-mcp-bridge/server.mjs)、[spike-codex.mjs](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/spikes/05-mcp-bridge/spike-codex.mjs)、[spike-claude.mjs](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/spikes/05-mcp-bridge/spike-claude.mjs)、[REPORT.md](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/spikes/05-mcp-bridge/REPORT.md)、[`fixtures/`](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/spikes/05-mcp-bridge/fixtures)
- **Server 实现**：基于 `@modelcontextprotocol/sdk@1.32.2`（`McpServer` + `StdioServerTransport`）与 `zod@4.3.6`，仅暴露 1 个只读测试记忆查询工具 `nuh_test_memory_query`（带 `readOnlyHint: true`），已通过官方 `Client` + `StdioClientTransport` 冒烟验证。
- **Codex 动态注入（已跑通）**：
  - 启动 `codex app-server --stdio -c mcp_servers.nuh_test_memory={...}`（不修改 `~/.codex/config.toml`）。
  - `mcpServerStatus/list` 成功发现 `nuh_test_memory` 与 `nuh_test_memory_query`；`turn/start` 自动发起 `mcpToolCall`（因 `readOnlyHint: true` 未再弹额外审批），返回校验令牌 `NUH_MEMORY_BRIDGE_TOKEN_9481` 并以 `code=0` 退出。
  - **关键架构发现**：[`codex-mcp-server-calls.jsonl`](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/spikes/05-mcp-bridge/fixtures/codex-mcp-server-calls.jsonl) 显示 Codex 在 `mcpServerStatus/list` 探测与 `thread/start` 会话阶段先后拉起了 **2 个** `server.mjs` 子进程（pid `93222` 与 `93245`）。因此 Phase 2 的 `@nuh/mcp-bridge` 状态必须驻留在 Daemon 进程内，stdio 入口仅作无状态转发代理。
- **Claude 动态注入（配置注入已验证，调用受限于未登录）**：
  - 使用 `--mcp-config <tmp.json> --strict-mcp-config` 启动 `claude`（`2.1.218`）双向 `stream-json`。
  - [`claude-stdout.ndjson`](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/spikes/05-mcp-bridge/fixtures/claude-stdout.ndjson) 的 `system:init` 已识别 `mcp_servers: [{"name":"nuh_test_memory","status":"pending"}]`，且 [`claude-mcp-server-calls.jsonl`](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/spikes/05-mcp-bridge/fixtures/claude-mcp-server-calls.jsonl) 记录 `server.mjs`（pid `93448`）已完成 `server_starting` → `server_connected`。
  - 随后因本机无 Claude 登录态，回合返回 `error: "authentication_failed"`（`Not logged in · Please run /login`），脚本以退出码 `2` 结束，未到达模型侧 `tools/call`。

---

## 五、 Monorepo 骨架与工程约束现状

已在根目录搭建最小 `pnpm` Monorepo 空壳（无 Phase 1 业务逻辑或 UI）：

- **根配置**：
  - [pnpm-workspace.yaml](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/pnpm-workspace.yaml)：包含 `packages/*` 与 `apps/*`（`spikes/*` 各自保持独立工作区）。
  - [package.json](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/package.json)：声明 `engines`（`node >=26.4.0`、`pnpm >=11.9.0`），配置 `"typecheck": "pnpm -r typecheck"`，锁定 `devDependencies.typescript` 为 `7.0.2`。
  - [tsconfig.base.json](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/tsconfig.base.json)：配置 `ES2024`、`NodeNext`、`strict: true`、`noImplicitAny: true`、`noUncheckedIndexedAccess: true`、`verbatimModuleSyntax: true`、`isolatedModules: true` 等严格选项。
  - [.gitignore](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/.gitignore)：已追加 `dist/` 与 `*.tsbuildinfo`。
- **Workspace 空壳包**（各自包含 `package.json`、`tsconfig.json` 与仅导出 `PACKAGE_NAME` 的 `src/index.ts`）：
  - `@nuh/protocol`：[packages/protocol/src/index.ts](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/packages/protocol/src/index.ts)
  - `@nuh/core`：[packages/core/src/index.ts](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/packages/core/src/index.ts)
  - `@nuh/dsh-shims`：[packages/dsh-shims/src/index.ts](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/packages/dsh-shims/src/index.ts)
  - `@nuh/mcp-bridge`：[packages/mcp-bridge/src/index.ts](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/packages/mcp-bridge/src/index.ts)
  - `@nuh/backends`：[packages/backends/src/index.ts](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/packages/backends/src/index.ts)
  - `@nuh/cli-repl`：[apps/cli-repl/src/index.ts](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/apps/cli-repl/src/index.ts)
  - *(注：当前包目录结构已按本轮确认从 `PLAN.md` 早期草案的 `core-plugin`/`daemon`/`backend-*` 收敛为上述 5 个 `packages/*` + `apps/cli-repl`。)*
- **Agent 规范软链**：[CLAUDE.md](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/CLAUDE.md) → `AGENTS.md`、[GEMINI.md](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/GEMINI.md) → `AGENTS.md`。
- **基线验证**：已执行 `pnpm install && pnpm typecheck`，全部 6 个工作区包（`apps/cli-repl`、`packages/core`、`packages/backends`、`packages/dsh-shims`、`packages/mcp-bridge`、`packages/protocol`）均通过 `tsc --noEmit`，零报错。

---

## 六、 已知缺口与进入 Phase 1 前待办清单

1. **协议规范文档待回填字段细节**：[PROTOCOL-v0.1.md](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/docs/PROTOCOL-v0.1.md) 仍为规划初版草案，需结合 Spike 01（`codex app-server`）、Spike 04（`agy acp`）与 Spike 05（`mcpToolCall`）抓包样本更新映射字段，并在 Phase 1 开始时在 `packages/protocol` 落地 Zod 契约与 `pnpm test:contract` 回归测试。
2. **Claude CLI 通道暂标为“已留接口、本机未实测通”**：因本机无 Claude 账户，双向 `stream-json`、`--resume` 与 `--mcp-config` 端到端模型调用尚未在本机闭环（仅验证了配置识别与 MCP Server 进程拉起连接）。若后续补充账户/API Key，可直接复跑 `spikes/05-mcp-bridge/spike-claude.mjs` 补齐样本。
3. **`codex sandbox` 尚未单独实测**：[PHASE0-CHECKLIST.md](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/docs/PHASE0-CHECKLIST.md#L49-L63) 中的 `--sandbox-state-disable-network` 与 `--log-denials` 拒绝日志提取尚未建立 Spike 脚本与样本，可在 Phase 3（`@nuh/policy-sandbox`）启动前补跑确认。
4. **Root `pnpm-workspace.yaml` 尚未写入 DSH `allowBuilds` 白名单**：待 Phase 1 正式引入 `@deepseek-ai/dsh-base@0.2.2-rc.1` 时，需按 Spike 02 实测结果将 5 个构建脚本包加入根 `pnpm-workspace.yaml`。
5. **规划文档路径同步（可选整理）**：[PLAN.md](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/docs/PLAN.md) 与 [ARCHITECTURE.md](file:///Users/a0000/Developer/NUH-Phase0-Check&Plan/docs/ARCHITECTURE.md) 中仍沿用早期包命名（如 `@nuh/daemon`、`@nuh/backend-*`），后续进入 Phase 1 编码前建议同步对齐到已落地的 `packages/{protocol,core,dsh-shims,mcp-bridge,backends}` 与 `apps/cli-repl`。
