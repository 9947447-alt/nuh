# NUH（方案 C）总体工程规划书（Master Plan）

> **关联文档**：
> - 前置评估报告：[report.md](../report.md)
> - 系统架构设计：[ARCHITECTURE.md](./ARCHITECTURE.md)
> - 统一协议规范：[PROTOCOL-v0.1.md](./PROTOCOL-v0.1.md)
> - Phase 0 实操清单：[PHASE0-CHECKLIST.md](./PHASE0-CHECKLIST.md)

---

## 1. 规划原则与硬性约束

| 维度 | 约束 / 目标 | 架构响应 |
| :--- | :--- | :--- |
| **人力与时间** | 单人开发、时间有限 | **不造已有轮子**：直接复用 DSH/Cordis 运行时、Codex CLI 二进制能力、Claude/AGY CLI 接口 |
| **插件兼容性** | `dsh-plugin` 必须直接可用 | **不魔改 DSH 核心私有 API**：NUH 自身业务逻辑全部以标准 Cordis 插件或极薄 Patch 挂载在 `@deepseek-ai/dsh-base` 上 |
| **多通道接入** | 主流 API + OpenAI 订阅 + `claude`/`agy` CLI | 定义统一 **`AgentBackend` 插件契约**，通过 `codex app-server` 使用订阅额度，通过 `stream-json` / `acp` 桥接 `claude` 与 `agy` |
| **前端后置** | 前端设计放到后面 | **Protocol-First**：Phase 1 即锁定 `NUH JSON-RPC 2.0` 守护协议，前期仅交付极简无状态/REPL CLI 用于自测 |
| **长期演进** | 保留后续切入自研引擎（方案 B）的可能 | 通过协议边界实现 **Strangler Fig（绞杀者模式）**，未来可用 Rust 核心替换调度层并将 DSH 降级为 Plugin Host Sidecar |

---

## 2. 本机环境基线（实测与待补齐项）

以下为当前开发环境实测结果：

- **已就绪**：
  - `node`: `v26.4.0`（`/opt/homebrew/bin/node`，满足 `@deepseek-ai/dsh` 对现代 Node `^22.19` / `>=24` 的要求）
  - `pnpm`: `11.9.0`（`/opt/homebrew/bin/pnpm`）
  - `codex`: `codex-cli 0.167.0`（`/opt/homebrew/bin/codex`），已确认具备：
    - `codex app-server`（支持 `stdio://`、`unix://`、`ws://`，以及 `generate-ts` / `generate-json-schema`）
    - `codex sandbox`（支持 `--sandbox-state-json`、`--sandbox-state-disable-network`、`--log-denials`）
    - `codex exec`（支持 `--json`、`resume`、`--worktree`）、`codex exec-server`、`codex mcp`、`codex plugin`
- **待 Phase 0 首步核实/补齐**（当前默认 `PATH` 与 `~/.local/bin` 未检出）：
  - `@deepseek-ai/dsh`（通过 `pnpm dlx` / 全局安装或本地工作区依赖引入）
  - `claude` CLI（确认实际安装路径、登录态及 `--input-format stream-json` 可用性）
  - `agy` CLI（确认实际安装路径、登录态及 `agy acp` / `agy -p --output-format stream-json` 可用性）

---

## 3. 目标 Monorepo 仓库拓扑（Phase 1 启建）

```text
nuh/
├── package.json                 # pnpm workspace 根配置 (Node >= 22.19)
├── pnpm-workspace.yaml
├── profiles/
│   ├── default/
│   │   └── cordis.patch.yml     # NUH 默认 Cordis 装配清单（基于 dsh-base + NUH 插件）
│   └── headless/
│       └── cordis.patch.yml     # 无头/守护进程专用装配
├── packages/
│   ├── protocol/                # @nuh/protocol: JSON-RPC 2.0 Schema、事件类型、Codex TS 生成类型封装
│   ├── core-plugin/             # @nuh/core-plugin: 统一会话映射、Router、Approval Gate 的 Cordis 服务定义
│   ├── daemon/                  # @nuh/daemon: 宿主启动器，加载 Cordis + DSH 并暴露 stdio/ws JSON-RPC 网关
│   ├── backend-codex/           # @nuh/backend-codex: 封装 codex app-server（OpenAI 订阅额度 + 审批转发）
│   ├── backend-claude/          # @nuh/backend-claude: 封装 claude CLI 双向 stream-json / ACP
│   ├── backend-agy/             # @nuh/backend-agy: 封装 agy acp（主）+ agy -p stream-json（备）
│   ├── mcp-bridge/              # @nuh/mcp-bridge: 将 NUH/DSH 工具与记忆暴露为本地 MCP Server 注入 CLI 后端
│   ├── policy-sandbox/          # @nuh/policy-sandbox: execpolicy 规则判定 + codex sandbox / dsh-bash-sandbox 适配
│   ├── tool-apply-patch/        # @nuh/tool-apply-patch: Codex 风格精确多文件 Patch 工具（Cordis 工具插件）
│   └── cli-repl/                # @nuh/cli-repl: 极简终端入口（仅做输入、流式打印、y/n 审批，不做复杂 TUI）
└── docs/                        # 架构、协议与 ADR 演进记录
```

> **核心纪律**：`packages/` 下除 `@nuh/daemon` 与 `@nuh/protocol` 外，其余能力模块一律实现为**标准 Cordis 插件**（导出 `name`、`inject`、`apply(ctx)`），严禁以 Fork 修改 `node_modules/@deepseek-ai/dsh-*` 源码的方式堆砌业务逻辑。

---

## 4. 详细阶段工作分解（WBS）

### Phase 0：可行性验证与契约锁定（预计 1 周）
> **目标**：用 5 个独立 Spike 消除外部依赖不确定性，产出真实可用的接口基准。具体执行步骤见 [PHASE0-CHECKLIST.md](./PHASE0-CHECKLIST.md)。

| 任务 ID | 任务内容 | 产出物 | 验收标准（DoD） |
| :--- | :--- | :--- | :--- |
| **P0-1** | 补齐/定位 `dsh`、`claude`、`agy` 可执行路径与登录态 | 本机环境配置记录 | 4 个 CLI 均可无报错输出 `--version` 或 `--help` |
| **P0-2** | 验证 `@deepseek-ai/dsh` 无头加载真实 `dsh-plugin`（如记忆/MCP 插件） | Spike 0.1 脚本 | 不启动 Web UI，可通过 SDK/Cordis 触发插件注册的工具 |
| **P0-3** | 运行 `codex app-server generate-ts` 并跑通 `thread/start` + `turn/start` + 审批流 | Spike 0.2 脚本 + 生成类型 | 用 Node 脚本驱动 `codex app-server` 完成一轮带工具调用的对话 |
| **P0-4** | 验证 `codex sandbox` 断网与拒绝日志捕获能力 | Spike 0.3 脚本 | 验证禁止外网与越界写时返回预期退出码及 denial 信息 |
| **P0-5** | 验证 `claude` 双向 `stream-json`（含 `--mcp-config`）与 `agy acp` | Spike 0.4 / 0.5 脚本 | 分别用 Node 子进程完成多轮对话与流式事件解析 |
| **P0-6** | 根据实测结果冻结 `NUH Protocol v0.1` | 定稿 `PROTOCOL-v0.1.md` | 覆盖 Thread/Turn/Item/Approval/BackendSwitch 全生命周期 |

---

### Phase 1：Headless 内核成型与 API 主力可用（预计 2–3 周）
> **目标**：交付可作为基础日常编码助手的 **NUH v0.1**（API 直连模式 + 原生 `dsh-plugin` 100% 兼容）。

1. **P1-1 Monorepo 初始化与 DSH 底座挂载**
   - 建立 `pnpm` 工作区与 TypeScript 构建链（支持 ESM + Node 26 原生/tsx 开发运行）。
   - 在 `@nuh/daemon` 中通过程序化方式启动 Cordis 容器并加载 `@deepseek-ai/dsh-base` 与 `profiles/default/cordis.patch.yml`。
2. **P1-2 `@nuh/protocol` 与 `@nuh/daemon` 网关**
   - 实现 JSON-RPC 2.0 传输层（首期支持 `stdio://` 与本地 `ws://127.0.0.1:<port>`）。
   - 实现核心 RPC：`initialize`、`thread/create`、`thread/resume`、`turn/start`、`turn/interrupt`、`approval/respond`、`plugin/list`。
   - 将 DSH 的会话事件与工具审批流桥接为统一的 `item/started`、`item/delta`、`item/completed`、`approval/requested` 通知。
3. **P1-3 多模型 API 路由配置**
   - 接入 OpenAI API、Anthropic API、DeepSeek API、Gemini API 及自定义 OpenAI-Compatible 端点。
   - 支持在配置或 `turn/start` 级别指定 `provider/model` 别名（如 `fast`、`coding`、`reasoning`）。
4. **P1-4 极简 `cli-repl` 与 DSH 插件实测**
   - 实现极简命令行入口 `nuh`：连接 Daemon、流式打印文本与工具调用、遇到高危操作阻塞等待 `y/n/always` 审批。
   - 实测直接通过配置安装并启用至少 2 个上游社区 `dsh-plugin`（如 `dsh-mcp-hub`、`dsh-mnemon`）。

- **Phase 1 里程碑 DoD**：日常可在本地代码库通过 `nuh` + 主流 API 完成读写改查与命令执行，且第三方 `dsh-plugin` 无需修改源码即可在 NUH 中生效。
- **Scope Guard（明确不做）**：不做多端 UI、不做 CLI 后端（留给 Phase 2）、不自研沙箱。

---

### Phase 2：多 CLI 后端与 OpenAI 订阅额度打通（预计 3–4 周）
> **目标**：打通 OpenAI 订阅额度、Claude Code CLI、Antigravity CLI，实现统一入口多后端无缝调度。

1. **P2-1 统一 `AgentBackend` 服务契约与会话映射**
   - 在 `@nuh/core-plugin` 定义 Cordis 服务 `ctx.nuhBackends`，统一管理四类后端：`native-dsh`（API 直连）、`codex`、`claude`、`agy`。
   - 落地 `SessionMappingStore`（SQLite 或 JSONL 索引），维护 `nuh_thread_id ↔ { backendType, backendSessionId, workdir }` 映射与跨后端上下文摘要同步。
2. **P2-2 `@nuh/backend-codex`（OpenAI 订阅主通道）**
   - 托管 `codex app-server --listen stdio://` 生命周期（含健康检查、崩溃重启、超时终止）。
   - 对接 `initialize`、`thread/start`、`thread/resume`、`turn/start`、`turn/interrupt`。
   - 将 Codex 的 `commandExecution` / `fileChange` 服务端审批请求映射为 NUH 标准 `approval/requested` 事件。
   - 启动前检测 `codex` 登录状态，未登录时引导提示执行 `codex login`。
3. **P2-3 `@nuh/backend-claude`（Claude Code CLI 桥接）**
   - 封装 `claude --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio`（或备选 `claude-agent-acp`）。
   - 解析 NDJSON 流映射为统一 `item/*` 事件，支持 `--resume <session-id>` 恢复多轮会话。
4. **P2-4 `@nuh/backend-agy`（Antigravity CLI 桥接）**
   - 主路径封装 `agy acp`（JSON-RPC over stdin/stdout），维持长驻会话状态。
   - 兜底路径支持 `agy -p "<prompt>" --output-format stream-json`，当 ACP 模式异常或仅需一次性任务时无缝降级。
5. **P2-5 `@nuh/mcp-bridge`（消除记忆与工具割裂）**
   - 在 NUH Daemon 内起一个轻量本地 MCP Server（stdio 代理或本地 HTTP/SSE），将选定的 Cordis 工具（如项目记忆检索、规范检查、自定义工具）统一暴露。
   - 启动 `codex`（通过临时/动态 MCP 配置）与 `claude`（通过 `--mcp-config`）时自动注入该桥接端点，使外部 CLI 后端也能调用 NUH 插件能力。
6. **P2-6 跨后端委派（Subagent Delegation）**
   - 注册 Cordis 工具 `delegate_to_backend(backend, task, contextSummary)`，允许主控 Agent（例如使用 API 或 Codex）将特定子任务（如代码审查、多视角诊断）派发给 `claude` 或 `agy` 并回收结构化结果。

- **Phase 2 里程碑 DoD**：可在同一个 `nuh` 会话中自由切换或子任务委派 `API`、`Codex(订阅)`、`Claude CLI`、`agy CLI`，且 CLI 后端可通过 MCP 读取 NUH 挂载的记忆/工具插件。

---

### Phase 3：Codex 级“全面性”与生产可靠性加固（预计 3–4 周）
> **目标**：补齐工程护城河，在安全边界、代码编辑精度、长程上下文与多任务隔离上达到主流主力 Harness 水准。

1. **P3-1 `execpolicy` 命令策略引擎（`@nuh/policy-sandbox`）**
   - 引入结构化命令前缀/语法判定器（直接封装 Codex 开源 `execpolicy` 规则格式，支持项目级 `.nuh/execpolicy.rules`）。
   - 实现 `allow`（自动放行如 `git status`、`rg`、`pnpm test`）、`prompt`（弹审批）、`forbid`（硬拦截如 `rm -rf /`、破坏性推库）三态决策，并作用于 `native-dsh` 与所有需外部审批的 CLI 后端。
2. **P3-2 OS 沙箱对齐与 `apply_patch` 工具**
   - 对比 `@deepseek-ai/dsh-bash-sandbox` 与 `codex sandbox` 行为，在 macOS/Linux 上为 `dsh-shell` seam 提供可选的 `codex-sandbox` Provider（支持 `--sandbox-state-disable-network` 与 `--log-denials` 拒绝原因回传给模型，避免模型盲目重试）。
   - 实现 `@nuh/tool-apply-patch` Cordis 工具插件，提供 Codex 风格精确上下文 Patch 语法与工作区越界校验。
3. **P3-3 `SKILL.md` 通用技能加载与 Context Compaction**
   - 兼容读取 `.agents/skills/`、`.claude/skills/` 与全局技能目录中的 `SKILL.md`（按需注入摘要，调用时加载全文）。
   - 实现跨后端统一的会话自动压缩（Compaction）：当历史上下文接近阈值或切换后端时，生成结构化交接摘要并落盘归档。
4. **P3-4 Git Worktree 隔离与全链路审计**
   - 提供 `worktree` 执行模式开关（高风险/并行任务自动在临时 `git worktree` 中运行，验收后合并回主工作区）。
   - 落盘统一 JSONL 审计日志（含每次工具输入输出、沙箱模式、审批人决策、Token 费用或订阅调用计数）。

- **Phase 3 里程碑 DoD**：具备完善的防误操作策略、断网沙箱与 Worktree 隔离；长程重构任务不易因上下文溢出中断；全量操作可审计、可回放。

---

### Phase 4：前端接入与“方案 B 决策门”（长期演进）
1. **Part A：独立前端接入（零核心返工）**
   - 基于冻结演进的 `NUH JSON-RPC Protocol`，任意开发独立前端：
     - **终端派**：基于 Ink / OpenTUI / Rust Ratatui 的全功能 TUI；
     - **桌面/Web 派**：Web UI 或 Electron / Tauri 客户端，或直接作为 ACP Server 接入 Zed / JetBrains / VS Code。
2. **Part B：向独立引擎（方案 B）迁移的触发条件与方式**
   - **仅当同时满足以下至少 2 项时才启动重构**（否则留在方案 C 持续迭代）：
     1. 多子 Agent 并发时 Node.js 内存或冷启动耗时明显影响体验；
     2. 上游 DSH 长期停更或引入不可调和的破坏性变更；
     3. 强烈需要零运行时依赖的跨平台单文件分发。
   - **迁移方式（Strangler Fig）**：用 Rust（可参考/基于 Apache-2.0 的 `codex-rs` 核心模块）实现 `NUH Core Daemon`，保留一个仅加载 Cordis 的极简 Node.js **`dsh-plugin-host` Sidecar**，通过 JSON-RPC / MCP 向新内核暴露 `dsh-plugin` 能力。前端与上层工作流 **0 感知**。

---

## 5. 总体时间线估算（按单人业余/集中投入双口径）

| 阶段 | 核心产出 | 集中全职投入 | 业余碎片投入（每周 ~12h） |
| :--- | :--- | :--- | :--- |
| **Phase 0** | 5 个 Spike 验证 + 协议定稿 | 3–5 天 | 1–1.5 周 |
| **Phase 1** | 可用 Headless MVP（API + DSH 插件） | 1.5–2 周 | 3–4 周 |
| **Phase 2** | Codex 订阅 + Claude/AGY CLI + MCP 桥 | 2–3 周 | 4–6 周 |
| **Phase 3** | `execpolicy` + 沙箱强化 + Skills + Worktree | 2–3 周 | 4–6 周 |
| **合计（达日常主力完全体）** | **Phase 0 → Phase 3** | **约 6–9 周** | **约 3–4 个月** |
