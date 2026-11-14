# NUH（方案 C）总体工程规划书（Master Plan）

> **关联文档**：
> - 前置评估报告：[report.md](../report.md)
> - 系统架构设计：[ARCHITECTURE.md](./ARCHITECTURE.md)
> - 统一协议规范：[PROTOCOL-v0.1.md](./PROTOCOL-v0.1.md)
> - 架构决策记录：[adr/README.md](./adr/README.md)
> - Phase 0 实操清单：[PHASE0-CHECKLIST.md](./PHASE0-CHECKLIST.md)

---

## 1. 规划原则与硬性约束

| 维度 | 约束 / 目标 | 架构响应 |
| :--- | :--- | :--- |
| **人力与时间** | 单人开发、时间有限 | **不造已有轮子**：直接复用 DSH/Cordis 运行时、Codex CLI 二进制能力、Claude/AGY CLI 接口 |
| **插件兼容性** | `dsh-plugin` 必须直接可用 | **不魔改 DSH 核心私有 API**：NUH 自身业务逻辑全部以标准 Cordis 插件挂载在 `@deepseek-ai/dsh-base` 上，无头兼容补丁沉淀在 `@nuh/dsh-shims` |
| **多通道接入** | 主流 API + OpenAI 订阅 + `claude`/`agy` CLI | 定义统一 **`AgentBackend` 契约**（`@nuh/backends`），通过 `codex app-server --stdio` 使用订阅额度，通过双向 `stream-json` 桥接 `claude`，通过单轨 `agy acp --stdio` 桥接 `agy`（**已否决 `agy -p stream-json` 降级路径**） |
| **前端后置** | 前端设计放到后面 | **Protocol-First**：Phase 1 即在 `@nuh/protocol` 锁定 `NUH JSON-RPC 2.0` 守护协议，Phase 3 验收前冻结一切 TUI/Web/Desktop 框架引入，仅保留极简 `apps/cli-repl` 用于纯 stdio 自测 |
| **长期演进** | 保留后续切入自研引擎（方案 B）的可能 | 通过 `@nuh/protocol` 边界实现 **Strangler Fig（绞杀者模式）**，未来可用独立引擎替换调度层并将 DSH 降级为 Plugin Host Sidecar |

---

## 2. 本机环境基线（Phase 0 实测对齐）

| 组件 | 实测基线 / 路径 | 状态与备注 |
| :--- | :--- | :--- |
| **Node.js** | `v26.4.0`（引擎基线 `>=26.4.0`） | 就绪；支持 ESM 与原生 TypeScript 类型剥离 |
| **pnpm** | `11.25.0`（引擎基线 `>=11.9.0`） | 就绪；根目录 `pnpm-workspace.yaml` 已显式声明 5 个 DSH `allowBuilds` 白名单 |
| **TypeScript** | `7.0.2`（`strict: true`） | 就绪；禁用 `any` 与隐式类型断言 |
| **DSH 基座** | `@deepseek-ai/dsh-base@0.2.2-rc.1` + `@deepseek-ai/dsh-app-boot@0.2.2-rc.1` + `@deepseek-ai/cordis@4.1.0` | 必须锁定精确版本号，禁止 `^` / `~`；通过自组装 Profile 无头启动 |
| **Codex CLI** | `codex-cli 0.167.0`（`/opt/homebrew/bin/codex`） | 已走通 ChatGPT Plus 订阅态 `codex app-server --stdio` 与审批回调；`codex sandbox` 留待 Phase 3 前补测 |
| **AGY CLI** | `agy 1.5.9`（`/Users/a0000/.local/bin/agy`） | 已走通 `agy acp --stdio`（双向审批 + `session/resume` + 热切换配置）；`-p stream-json` 已确认权限旁路并否决 |
| **Claude CLI** | `claude 2.1.218`（`/Users/a0000/.local/bin/claude`） | 本机 `loggedIn: false`，已验证 `--mcp-config` 进程拉起，模型端到端留接口待登录态补测 |

---

## 3. 实际 Monorepo 仓库拓扑（Phase 1 落地结构）

```text
nuh/
├── package.json                 # pnpm workspace 根配置 (Node >= 26.4.0, pnpm >= 11.9.0)
├── pnpm-workspace.yaml          # 工作区范围 + Spike 02 实测的 5 个 DSH allowBuilds 白名单
├── tsconfig.base.json           # strict TypeScript 7 基线配置
├── biome.json                   # 统一格式化、严格 Lint 与跨层导入限制
├── .github/workflows/ci.yml     # Lint -> Typecheck -> Unit & Contract -> Build -> Fake Integration
├── docs/
│   ├── PLAN.md
│   ├── ARCHITECTURE.md
│   ├── PROTOCOL-v0.1.md
│   ├── PHASE0-CHECKLIST.md
│   └── adr/                     # Phase 0 关键架构决策留档（0001~0004）
├── packages/
│   ├── protocol/                # @nuh/protocol: 唯一协议事实来源（Canonical Zod Schema、TS 类型、外部 CLI 报文解析、归一化内部事件）
│   ├── core/                    # @nuh/core: Daemon 宿主持久化装配（dsh-base + dsh-app-boot）、Router、SessionMappingStore、execpolicy/sandbox 与 apply_patch
│   ├── dsh-shims/               # @nuh/dsh-shims: 无头运行时桩（webServer/connection）与第三方 dsh-plugin 宿主借用依赖补齐
│   ├── mcp-bridge/              # @nuh/mcp-bridge: Daemon 常驻状态 MCP Server + 无状态 stdio 转发代理
│   └── backends/                # @nuh/backends: 统一 AgentBackend 适配器（native-dsh / codex / claude / agy acp）
├── apps/
│   └── cli-repl/                # @nuh/cli-repl: 极简纯标准输入输出 REPL（仅依赖 @nuh/protocol，禁止直连底层包）
└── tests/
    ├── contract/                # 确定性契约测试（基于 tests/fixtures/ 真实抓包样本）
    ├── integration/             # 伪造传输/子进程集成测试（禁止调用真实外部 LLM）
    ├── e2e/                     # 预留本地端到端验收测试
    ├── evals/                   # 预留 Agent 行为评测集
    └── fixtures/                # Spike 01 / Spike 04 等真实抓包样本归档
```

> **核心纪律**：
> 1. **禁止魔改 DSH 核心**：严禁复制或修改 `@deepseek-ai/dsh-base` 源码；扩展通过标准 Cordis 插件实现，兼容桩沉淀在 `@nuh/dsh-shims` 并附回归测试。
> 2. **协议即边界**：`apps/*` 仅允许依赖 `@nuh/protocol`，禁止越界直连 `@nuh/core` / `@nuh/backends` / `@deepseek-ai/*`；后端适配器必须完成事件归一化再上送。

---

## 4. 详细阶段工作分解（WBS）

### Phase 0：可行性验证与契约锁定（已完成主体 Spike 并归档）
> 具体实测事实与留档缺口见 [report.md](../report.md) 与 [docs/adr/](./adr/README.md)。

| Spike / 任务 | 实际结论 |
| :--- | :--- |
| **Spike 01：`codex app-server`** | 导出 TS 绑定，无 `OPENAI_API_KEY` 跑通 ChatGPT Plus 订阅态工具调用与审批；发现下行省略 `"jsonrpc"`、服务端 `id` 从 `0` 递增、`turn/completed` 仅返回 `itemsView: "summary"`、线上响应含额外字段需 `.passthrough()` |
| **Spike 02：`dsh-base` 无头** | 锁定 `@deepseek-ai/dsh-base@0.2.2-rc.1` 与 `dsh-app-boot` 自组装 Profile；明确 `dsh-mnemon`（`profileContext` + `settings` + 禁用 `hmr`）与 `@opfield/dsh-mcp-hub`（`webServer`/`connection` 桩 + 5 个宿主借用包）缺口 |
| **Spike 03：`codex sandbox`** | 尚未建立脚本，留待 Phase 3 沙箱增强前补测 |
| **Spike 04：`agy` CLI** | 锁定单轨 `agy acp --stdio`（支持字符串服务端 `id: "1"` 与双向 `allow`/`deny` 审批、跨进程 `session/resume`）；否决 `-p stream-json` 降级路径（无审批拦截且冷启慢） |
| **Spike 05：MCP Bridge** | Codex `-c mcp_servers...` 动态注入实调成功；发现 Codex 会拉起多个 stdio 子进程，确立“状态常驻 Daemon、stdio 入口仅作无状态转发代理”架构 |

---

### Phase 1：治理基建、协议事实来源与 Headless 内核 MVP
> **目标**：先立起质量门禁与 `@nuh/protocol` 唯一契约，再构建基于 `dsh-base + dsh-app-boot` 的无头 Daemon 与纯 stdio REPL。

1. **P1-0 治理基建与 `@nuh/protocol`（本阶段首要落地）**
   - 补齐 `pnpm-workspace.yaml` 5 个 DSH `allowBuilds` 白名单。
   - 建立 `tests/{contract,integration,e2e,evals,fixtures}` 分层、Biome + 模块边界检查、`.github/workflows/ci.yml`（`Lint -> Typecheck -> Unit & Contract -> Build -> Fake Integration`）。
   - 在 `@nuh/protocol` 落地 Canonical Zod Schema、TypeScript 类型、归一化内部事件与 Spike 01/04 确定性契约测试。
2. **P1-1 DSH 无头基座自组装与 `@nuh/dsh-shims`**
   - 在 `@nuh/core` 通过 `dsh-app-boot`（`initProfile` + `loadProfileDirectory` + `createRuntimeResolution`）程序化拉起 `@deepseek-ai/dsh-base@0.2.2-rc.1`（不采用依赖 `cmdlineArgs` 的 `dsh-headless` / `dsh-sdk-minimal`）。
   - 在 `@nuh/dsh-shims` 实现最小 `webServer` / `connection` 无头桩、`profileContext`（禁用 `hmr`）以及 `@opfield/dsh-mcp-hub` 的宿主借用包提供逻辑。
3. **P1-2 JSON-RPC 2.0 守护网关与核心调度**
   - 在 `@nuh/core` 实现 `stdio://` 与本地 `ws://127.0.0.1:<port>`（带 capability token）网关，消费 `@nuh/protocol` 契约。
   - 实现 `initialize`、`thread/start`、`thread/resume`、`thread/list`、`thread/setBackend`、`turn/start`、`turn/interrupt`、`approval/requested`。
4. **P1-3 极简 `@nuh/cli-repl` 与 DSH 插件实测**
   - 在 `apps/cli-repl` 实现纯标准输入输出客户端（仅依赖 `@nuh/protocol`），支持流式打印与 `y/n/always` 审批响应。
   - 实测无头启用 `dsh-mnemon` 与 `@opfield/dsh-mcp-hub`。

- **Scope Guard（Phase 1 明确不做）**：不做任何 TUI/Web/Desktop UI 框架、不实现自研沙箱。

---

### Phase 2：多 CLI 后端与 `@nuh/mcp-bridge`
> **目标**：在 `@nuh/backends` 与 `@nuh/mcp-bridge` 打通 OpenAI 订阅、`agy acp`、`claude` 接口与跨后端记忆工具注入。

1. **P2-1 统一 `AgentBackend` 契约与 `SessionMappingStore`**
   - 在 `@nuh/core` 维护 `nuh_thread_id <-> { backendType, backendSessionId, workdir }` 与统一主账本 `ledger.jsonl`。
2. **P2-2 `codex` 后端适配器（`@nuh/backends`）**
   - 托管 `codex app-server --stdio`，显式绑定 `SIGINT`/`SIGTERM`/`exit` 清理钩子。
   - 使用 `@nuh/protocol` 宽容解析（允许省略 `jsonrpc`、`.passthrough()` 扩展字段、`id !== undefined && method !== undefined` 区分服务端审批请求），订阅流式 `item/*` 归档完整日志（不依赖 `turn/completed` 的 `summary` 视图）。
3. **P2-3 `claude` 后端适配器（`@nuh/backends`）**
   - 预留双向 `stream-json` + `--permission-prompt-tool stdio` + `--resume` 适配器，待有效登录态后补齐实测 Fixtures 与契约测试。
4. **P2-4 `agy` 后端适配器（`@nuh/backends`，单轨锁定 `agy acp --stdio`）**
   - 仅实现 `agy acp --stdio` 常驻模式：支持 `initialize`、`session/new`、`session/resume`、`session/set_config_option`、`session/prompt` 与字符串 `id` 的 `session/request_permission`。
   - **已删除 `-p --output-format stream-json` 降级路径**：子进程崩溃后由 `ProcessSupervisor` 重启 `agy acp --stdio` 并调用 `session/resume` 恢复。
5. **P2-5 `@nuh/mcp-bridge`（Daemon 常驻状态 + 无状态 stdio 转发代理）**
   - MCP 工具注册与状态常驻 `@nuh/core` Daemon 进程内（本地回环 HTTP/IPC）；CLI 拉起的 stdio 入口仅作无状态转发代理，避免 Codex 多进程拉起导致状态分叉。
6. **P2-6 跨后端委派**
   - 注册标准 Cordis 工具支持主控 Agent 跨后端派发只读或受控子任务。

---

### Phase 3：安全策略、沙箱强化与生产可靠性
1. **P3-1 `execpolicy` 命令策略引擎（`@nuh/core`）**：三级规则覆盖 + `allow`/`prompt`/`forbid` 判定。
2. **P3-2 OS 沙箱对齐与 `apply_patch`**：补跑 Spike 03 验证 `codex sandbox --sandbox-state-disable-network --log-denials` 拒绝日志回传。
3. **P3-3 `SKILL.md` 通用加载与 Context Compaction**。
4. **P3-4 Git Worktree 隔离与 JSONL 全链路审计**。

---

### Phase 4：独立前端接入与“方案 B 决策门”
- **Part A**：Phase 3 验收完成后，基于冻结演进的 `@nuh/protocol` 接入独立 TUI / Web / Desktop / IDE 客户端。
- **Part B**：仅当满足至少 2 项触发条件时（多子 Agent 内存/冷启瓶颈、DSH 上游停更或破坏性变更、强制单文件零运行时分发），通过 Strangler Fig 迁移至独立引擎 + `dsh-plugin-host` Sidecar。
