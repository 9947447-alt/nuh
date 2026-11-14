# ADR-0001：采用方案 C（协议边界隔离 + 不魔改 DSH 核心）

- **状态**：Accepted
- **日期**：2026-11-14
- **依据**：Phase 0 架构评估与 `AGENTS.md` 工程红线

## 背景
NUH 需要同时复用 `@deepseek-ai/dsh-base` 的 Cordis 插件生态（如 `dsh-mnemon`、`@opfield/dsh-mcp-hub`），并接入外部订阅/CLI 后端（`codex` / `claude` / `agy`），同时避免过早绑定特定前端框架。

## 决策
1. **选择方案 C（混合演进架构）**：以 `packages/protocol`（`@nuh/protocol`）作为唯一通信契约边界，底层以 Node.js + Cordis + `@deepseek-ai/dsh-base` 作为核心容器，前端（Phase 3 验收前仅限 `apps/cli-repl`）只能通过 JSON-RPC 2.0 协议与 Daemon 交互。
2. **禁止魔改 DSH 核心**：严禁复制、Fork 或直接修改 `@deepseek-ai/dsh-base` 上游源码。所有业务扩展以标准 Cordis 插件实现；无头兼容补丁沉淀在 `packages/dsh-shims` 并附带回归测试；`@deepseek-ai/*` 依赖锁定精确版本号。
3. **跨层边界硬约束**：`apps/*` 禁止导入 `@nuh/core` / `@nuh/backends` / `@deepseek-ai/*`，由 `pnpm lint` 中的 Biome + `scripts/check-boundaries.ts` 强制拦截。

## 后果
- **正面**：100% 保留上游 `dsh-plugin` 兼容性，前端演进与未来 Strangler Fig 迁移（方案 B）均无需推翻协议边界。
- **约束**：必须严格维护 `@nuh/protocol` 的唯一事实来源地位，任何后端私有事件禁止泄漏至调度层或前端。
