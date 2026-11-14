# NUH 统一守护进程协议规范（`PROTOCOL-v0.1`）

> **定位**：全仓库唯一通信契约层（落地于 `packages/protocol` / `@nuh/protocol`），隔离“客户端表现层（`apps/*`）”与“底层 Harness 引擎（`packages/core` + `packages/backends`）”。  
> **状态**：Phase 1 协议冻结基线（已结合 Spike 01 `codex app-server` 与 Spike 04 `agy acp --stdio` 真实抓包样本修订，并移除 `agy -p stream-json` 降级路径）。

---

## 1. 传输层与帧格式约定

- **编码格式**：UTF-8 **NDJSON**（每行一个 JSON-RPC 对象，以 `\n` 分隔）。`stdout` 仅输出 JSON-RPC 帧，`stderr` 仅允许结构化诊断日志。
- **传输通道**：
  - `stdio://`：本地 `apps/cli-repl` 或测试驱动直接拉起 Daemon。
  - `ws://127.0.0.1:<port>`：后续本地多客户端挂载通道（须携带启动时生成的 capability token，禁止无鉴权绑定 `0.0.0.0`）。
- **JSON-RPC 2.0 严格层 vs 外部 CLI 宽容层**：
  - **NUH Daemon <-> Client 规范协议**：所有请求、响应与通知**强制要求** `"jsonrpc": "2.0"`，请求 `id` 兼容 `number | string`（非空）。
  - **外部 CLI 下行适配校验**（`packages/protocol/src/external/`）：
    - `codex app-server --stdio` 下行报文**省略 `"jsonrpc": "2.0"`**，校验器不得强制要求该字段；
    - 外部 CLI 报文均包含未文档化扩展字段（如 Codex 的 `emittedAtMs`、`availableDecisions`、`workspaceRouting`、`runtimeWorkspaceRoots`；AGY ACP 的驼峰/下划线混用 `loadSession`/`load_session` 等），所有外部对象 Schema 必须使用 Zod `.passthrough()` 保留未知字段，不得误报协议失败。

---

## 2. 双向帧分派规则与错误码契约

### 2.1 双向独立 Request ID 分派规则（Spike 01 / Spike 04 实测锁定）
由于后端或 Daemon 发出的**服务端主动请求（Server-Initiated Request）**拥有独立 ID 命名空间（Codex 为从 `0` 递增的整数，AGY ACP 为字符串 `"1"`），极易与客户端请求 ID（`1, 2, ...`）发生数值碰撞。

**分派层判定优先级（不可颠倒）**：
1. 若 `id !== undefined && method !== undefined` → 判定为 **`Request`**（即 Client->Daemon Request 或 Server-Initiated Request）；
2. 否则若 `method !== undefined` → 判定为 **`Notification`**；
3. 否则若 `id !== undefined && ('error' in frame || 'result' in frame)` → 判定为 **`Response`**；
4. 其他情况 → 立即抛出 `NuhProtocolError(INVALID_REQUEST)`，**严禁静默返回 `null`**。

### 2.2 错误码契约（无静默降级）

| 错误码 | 常量名 | 触发场景 |
| :--- | :--- | :--- |
| `-32700` | `PARSE_ERROR` | 空行或非法 JSON 文本 |
| `-32600` | `INVALID_REQUEST` | 缺失 `jsonrpc: "2.0"`（规范信道）或帧结构无法分类 |
| `-32601` | `METHOD_NOT_FOUND` | 未知的 NUH RPC 方法名 |
| `-32602` | `INVALID_PARAMS` | 请求参数未通过 Zod Schema 校验 |
| `-32603` | `INTERNAL_ERROR` | 未归类的内部异常 |
| `-32001` | `PROTOCOL_VALIDATION_ERROR` | 通知或外部 CLI 报文未通过契约校验 |
| `-32002` | `BACKEND_PROCESS_ERROR` | 托管子进程异常崩溃或非预期退出 |
| `-32003` | `BACKEND_UNAVAILABLE` | 后端未安装或未登录认证 |
| `-32004` | `APPROVAL_REJECTED` | 审批请求被拒绝或超时 |
| `-32005` | `THREAD_NOT_FOUND` | 指定 `threadId` 不存在 |
| `-32006` | `TURN_NOT_FOUND` | 指定 `turnId` 不存在 |

---

## 3. Client → Daemon 请求接口（Requests）

### 3.1 握手与能力发现：`initialize`
- Request: `{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { "clientInfo": { "name": "nuh-cli-repl", "version": "0.1.0" }, "protocolVersion": "0.1" } }`
- Response: `{ "jsonrpc": "2.0", "id": 1, "result": { "serverInfo": { "name": "nuh-daemon", "version": "0.1.0" }, "protocolVersion": "0.1", "backends": [...], "loadedDshPlugins": [...] } }`

### 3.2 会话管理：`thread/start`、`thread/resume`、`thread/list`、`thread/setBackend`
- `thread/start`：`params: { workdir, defaultBackend?, model?, sandboxMode?, approvalPolicy? }` → `result: { threadId, createdAt }`
- `thread/resume`：`params: { threadId, workdir? }` → `result: { threadId, activeBackend, ledgerSummary }`
- `thread/list`：`params: { workdir? }` → `result: { threads }`
- `thread/setBackend`：`params: { threadId, backend, model? }` → `result: { threadId, backend, model? }`

### 3.3 轮次执行与中断：`turn/start`、`turn/interrupt`
- `turn/start`：`params: { threadId, input, backendOverride?, modelOverride?, worktree? }` → `result: { turnId, resolvedBackend }`
- `turn/interrupt`：`params: { threadId, turnId }` → `result: { interrupted }`

---

## 4. Daemon → Client 流式通知与内部归一化事件

> **Spike 01 关键约束**：`codex app-server` 的 `turn/completed` 中 `turn.items` 仅包含摘要视图（`itemsView: "summary"`，通常仅有最终 `agentMessage`），不包含中间推理、评论与命令输出。因此后端适配器**必须订阅并归一化流式 `item/*` 通知**，不得依赖 `turn/completed` 反推完整工具历史。

标准通知序列（对应 `@nuh/protocol` 中的 `NuhNormalizedEvent` 与 `NuhNotification`）：
1. `turn/started`: `{ threadId, turnId, backend }`
2. `item/started`: `{ threadId, turnId, itemId, kind, meta? }`（`kind`: `agent_message` | `reasoning` | `tool_call` | `command_exec` | `file_change` | `delegation`）
3. `item/delta`: `{ threadId, turnId, itemId, channel, delta }`（`channel`: `text` | `thinking` | `stdout` | `stderr` | `diff`）
4. `item/completed`: `{ threadId, turnId, itemId, status, summary? }`（`status`: `ok` | `failed` | `denied` | `cancelled`）
5. `turn/completed`: `{ threadId, turnId, status, usage?, error? }`（`status`: `completed` | `failed` | `interrupted`）

---

## 5. 双向审批协议（Daemon → Client Request）

- Request（支持 `id: number | string`）：
```json
{
  "jsonrpc": "2.0",
  "id": "srv_req_99",
  "method": "approval/requested",
  "params": {
    "threadId": "nuh_thr_01J...",
    "turnId": "nuh_turn_01J...",
    "itemId": "itm_1",
    "backend": "codex",
    "category": "command_exec",
    "title": "请求在沙箱外执行网络命令",
    "command": "curl -s https://api.example.com/health",
    "workdir": "/Users/a0000/Developer/my-project",
    "reason": "sandbox_network_disabled"
  }
}
```
- Response：`{ "jsonrpc": "2.0", "id": "srv_req_99", "result": { "decision": "allow_once" | "allow_for_session" | "deny", "note": null } }`

---

## 6. 各后端事件到 NUH 标准事件的实测映射表

| NUH 标准事件 | `native-dsh` (Cordis/DSH) | `codex` (`codex app-server --stdio`) | `agy` (`agy acp --stdio`，唯一单轨) | `claude` (`stream-json`，留接口待登录态补测) |
| :--- | :--- | :--- | :--- | :--- |
| `item/started` (`agent_message`) | LLM 首字响应开始 | `item/started`（`item.type: "agentMessage"`, `phase` 可为 `"commentary"` / `"final_answer"`） | `session/update`（首个 `agent_message_chunk`） | `assistant` message start |
| `item/delta` (`text`) | LLM token stream chunk | `item/agentMessage/delta`（`params.delta`） | `session/update`（`agent_message_chunk`, `content.text`） | `content_block_delta` (`text_delta`) |
| `item/started` (`tool_call` / `command_exec`) | `ctx.tools` 执行前钩子 | `item/started`（`item.type: "commandExecution"` / `"fileChange"` / `"mcpToolCall"`） | `session/update`（`tool_call` / `tool_call_update` `status: "pending" \| "in_progress"`） | `tool_use` block |
| `item/completed` | Tool 返回结果 / 异常 | `item/completed`（含 `status`, `exitCode`, `aggregatedOutput`） | `session/update`（`tool_call_update` `status: "completed" \| "failed"`） | `tool_result` event |
| `approval/requested` | DSH 审批拦截 / `execpolicy` | `item/commandExecution/requestApproval` / `item/fileChange/requestApproval`（`id` 为整数，回包后下发 `serverRequest/resolved`） | `session/request_permission`（`id` 为字符串如 `"1"`；回包 `{ outcome: { outcome: "selected", optionId: "allow" \| "deny" } }`） | `--permission-prompt-tool stdio` |
| `turn/completed` | Agent Loop 结束 | `turn/completed`（`itemsView: "summary"`，用量取自 `thread/tokenUsage/updated`） | `session/prompt` Response（`stopReason` + `usage`） | `result` event |

> **注**：上述 `codex` 与 `agy acp` 真实抓包样本均已归档在根目录 [`tests/fixtures/`](../tests/fixtures/)（`codex/` 与 `agy/`），并由 [`tests/contract/`](../tests/contract/) 的确定性契约测试持续校验。
