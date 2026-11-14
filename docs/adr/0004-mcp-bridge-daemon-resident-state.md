# ADR-0004：`@nuh/mcp-bridge` 状态常驻 Daemon，stdio 入口作为无状态转发代理

- **状态**：Accepted
- **日期**：2026-11-14
- **依据**：Phase 0 Spike 05（`codex app-server` 与 `claude` CLI 动态 MCP 注入实测）

## 背景
为了消除“DSH 插件生态”与“外部 CLI 后端（`codex` / `claude`）”之间的记忆和工具割裂，NUH 需要通过 `@nuh/mcp-bridge` 将 Cordis `ctx.tools` 反向暴露为本地 MCP Server。

## 实测事实
在 Spike 05 中通过 `-c mcp_servers.nuh_test_memory={...}` 注入 `codex app-server --stdio` 时，`codex-mcp-server-calls.jsonl` 记录显示 Codex 先后拉起了 **2 个**独立的 `stdio` MCP 子进程：
1. 第 1 个进程用于 `mcpServerStatus/list` 工具探测；
2. 第 2 个进程用于 `thread/start` 会话连接并执行实际的 `tools/call`。

如果把记忆状态、连接上下文或 Cordis 容器直接放进 CLI 拉起的 `stdio` 子进程内部，会导致多进程间状态分叉，甚至无法共享宿主 Daemon 的 `ctx.tools` 生命周期。

## 决策
- **`@nuh/mcp-bridge` 采用“状态常驻 Daemon + 无状态 stdio 代理”两段式架构**：
  1. 真正的工具路由、Cordis `ctx.tools` 订阅与会话状态常驻 NUH Daemon 进程内（仅监听 `127.0.0.1` 并附带随机 Bearer Token）；
  2. 提供给 `codex` / `claude` CLI 配置的 `stdio` 可执行入口仅作为无状态瘦转发代理，将 JSON-RPC/MCP 请求转发至 Daemon 内核端点。

## 后果
- 无论外部 CLI 探测或并发子 Agent 拉起多少个 `stdio` MCP 进程，工具清单、记忆读写与权限状态始终保持单一真实来源。
