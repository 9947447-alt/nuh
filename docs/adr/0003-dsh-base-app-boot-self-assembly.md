# ADR-0003：基于 `dsh-base + dsh-app-boot` 自组装无头 Profile

- **状态**：Accepted
- **日期**：2026-11-14
- **依据**：Phase 0 Spike 02（Node `v26.4.0` + `@deepseek-ai/dsh-base@0.2.2-rc.1` 无头兼容实测）

## 背景
需要确定 NUH Daemon 在不启动 `dsh web` 前端的条件下，应以何种方式装配并启动 DSH/Cordis 运行时，同时兼容 `dsh-mnemon` 与 `@opfield/dsh-mcp-hub` 等真实插件。

## 实测事实
1. `@deepseek-ai/dsh-headless`、`@deepseek-ai/dsh-sdk-minimal` 与 `@deepseek-ai/dsh-acp-app` 脱离 `dsh` CLI 启动器时均因缺少 `cmdlineArgs` 抛出 `StartupError`，且 `dsh-headless` 会级联阻塞 `fs`、`shell`、`bash-sandbox` 等 22 个核心条目。
2. 通过 `@deepseek-ai/dsh-app-boot`（`initProfile` + `loadProfileDirectory` + `createRuntimeResolution` + `PluginPackages`）直接加载 `@deepseek-ai/dsh-base@0.2.2-rc.1`（`cordis.yml` 置于 `$DSH_HOME/profiles/<name>/`），在 Node `v26.4.0` 下可零异常激活 89 个条目、55 个 Cordis 服务与 25 个默认工具。
3. 社区插件存在两类无头缺口：
   - `dsh-mnemon@0.5.45` 需要最小 `profileContext` 与 `settings`（同时保持 `hmr` 禁用，避免 `Profile HMR requires application readiness` 报错）；
   - `@opfield/dsh-mcp-hub@0.4.2` 需要 `ctx.webServer.register` / `ctx.connection.requestRejection` 桩，且其 `install.js` 向宿主借用 5 个 `@deepseek-ai/*` / `@modelcontextprotocol/client` 包。

## 决策
- NUH Daemon（`@nuh/core`）**直接基于 `dsh-base + dsh-app-boot` 自组装 Profile**，不复用强依赖 `cmdlineArgs` 的官方独立无头包。
- `@deepseek-ai/*` 精确锁定 `0.2.2-rc.1`（避免 npm `latest` 标签停留于 `0.0.1-rc.1` 陷阱）。
- 根目录 `pnpm-workspace.yaml` 显式声明 Spike 02 实测的 5 个 `allowBuilds` 包（`@deepseek-ai/dsh-subprocess-local: true`，其余 `false`）。
- 社区插件的无头缺口统一收口在 `@nuh/dsh-shims`。
