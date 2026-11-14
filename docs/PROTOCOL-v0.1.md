# NUH 统一守护进程协议规范草案（`PROTOCOL-v0.1`）

> **定位**：隔离“前端表现层”与“底层 Harness 引擎”的核心边界契约。  
> **设计参考**：参考 `openai/codex` 的 `app-server`（JSON-RPC 2.0 双向线程/轮次/条目模型）与 ACP（Agent Client Protocol）通用思想，保持最小够用（KISS），避免过度设计。

---

## 1. 传输层约定

- **编码格式**：UTF-8 **NDJSON**（每行一个 JSON-RPC 2.0 对象，以 `\n` 分隔）。
- **传输通道**：
  - `stdio://`：本地 CLI REPL、IDE 扩展或测试驱动直接拉起 `nuh daemon --stdio`（日志严格走 `stderr`，`stdout` 仅输出 JSON-RPC 帧）。
  - `ws://127.0.0.1:<port>`：供后续 Web UI / Desktop / 多客户端同时挂载同一个后台 Daemon（需附带启动时生成的本地 capability token，禁止无鉴权绑定 `0.0.0.0`）。

---

## 2. 核心原语（Primitives）

1. **Thread（会话线程）**：对应一个长期工作区上下文，跨后端（`native-dsh` / `codex` / `claude` / `agy`）持久化。
2. **Turn（执行轮次）**：一次用户输入触发的完整 Agent 闭环（从 `turn/start` 到 `turn/completed` 或 `turn/failed` / `turn/interrupted`）。
3. **Item（流式事件条目）**：Turn 内部产出的原子单元，包括：`agent_message`（文本回复）、`reasoning`（思考过程）、`tool_call`（工具调用）、`command_exec`（命令执行）、`file_change`（文件变更）、`delegation`（跨后端子任务委派）。
4. **Server-Initiated Request（服务端主动请求）**：双向 RPC 的关键——当引擎遇到高危命令、越界写入或需要用户输入时，Daemon **主动向 Client 发起 Request** 并挂起当前 Tool 执行，直到 Client 返回 `Response`。

---

## 3. Client → Daemon 请求接口（Requests）

### 3.1 握手与能力发现：`initialize`
```json
// Request
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "clientInfo": { "name": "nuh-cli-repl", "version": "0.1.0" },
    "protocolVersion": "0.1"
  }
}

// Response
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "serverInfo": { "name": "nuh-daemon", "version": "0.1.0" },
    "protocolVersion": "0.1",
    "backends": [
      { "kind": "native-dsh", "available": true, "authenticated": true },
      { "kind": "codex", "available": true, "authenticated": true, "version": "0.167.0" },
      { "kind": "claude", "available": false, "authenticated": false },
      { "kind": "agy", "available": false, "authenticated": false }
    ],
    "loadedDshPlugins": ["dsh-tool-bash", "dsh-mnemon"]
  }
}
```

### 3.2 会话管理：`thread/start`、`thread/resume`、`thread/list`
```json
// thread/start Request
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "thread/start",
  "params": {
    "workdir": "/Users/a0000/Developer/my-project",
    "defaultBackend": "native-dsh",
    "model": "deepseek-v4-pro",
    "sandboxMode": "workspace-write",
    "approvalPolicy": "on-request"
  }
}

// Response
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "threadId": "nuh_thr_01J...",
    "createdAt": "2026-11-14T13:50:00Z"
  }
}
```
- `thread/resume`：`params: { threadId, workdir? }` → 恢复历史状态并返回最近若干条 `ledger` 摘要供客户端回显。
- `thread/setBackend`：`params: { threadId, backend, model? }` → 在同一会话内显式切换后续 Turn 的默认后端（如从 `native-dsh` 切到 `codex` 消耗订阅额度）。

### 3.3 轮次执行与中断：`turn/start`、`turn/interrupt`
```json
// turn/start Request
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "turn/start",
  "params": {
    "threadId": "nuh_thr_01J...",
    "input": "请检查 src/auth.ts 的竞态问题并修复，最后跑一次单测。",
    "backendOverride": null,
    "modelOverride": null,
    "worktree": false
  }
}

// Response（立即返回 turnId，后续通过 Notification 流式推送）
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "turnId": "nuh_turn_01J...",
    "resolvedBackend": "native-dsh"
  }
}
```
- `turn/interrupt`：`params: { threadId, turnId }` → 触发 `AbortSignal` / 子进程中断控制帧，立即终止当前 Turn 并产生 `turn/completed (status: "interrupted")`。

---

## 4. Daemon → Client 流式通知（Notifications）

```json
// 1. 轮次开始
{ "jsonrpc": "2.0", "method": "turn/started", "params": { "threadId": "...", "turnId": "...", "backend": "codex" } }

// 2. 条目开始
{ "jsonrpc": "2.0", "method": "item/started", "params": { "threadId": "...", "turnId": "...", "itemId": "itm_1", "kind": "command_exec", "meta": { "command": "pnpm test" } } }

// 3. 增量内容（文本 / 思考 / 工具输出）
{ "jsonrpc": "2.0", "method": "item/delta", "params": { "threadId": "...", "turnId": "...", "itemId": "itm_1", "channel": "stdout", "delta": "PASS src/auth.test.ts\n" } }

// 4. 条目完成
{ "jsonrpc": "2.0", "method": "item/completed", "params": { "threadId": "...", "turnId": "...", "itemId": "itm_1", "status": "ok", "summary": { "exitCode": 0 } } }

// 5. 轮次结束（含用量/额度审计）
{ "jsonrpc": "2.0", "method": "turn/completed", "params": { "threadId": "...", "turnId": "...", "status": "completed", "usage": { "billingType": "subscription", "backend": "codex", "inputTokens": 4200, "outputTokens": 850 } } }
```

---

## 5. 双向审批协议（Daemon → Client Request）

当 `execpolicy` 判定为 `prompt`，或后端（如 `codex app-server` / `claude`）请求提权执行时，Daemon 发出带 `id` 的请求并阻塞等待：

```json
// Daemon -> Client (Request)
{
  "jsonrpc": "2.0",
  "id": "srv_req_99",
  "method": "approval/requested",
  "params": {
    "threadId": "nuh_thr_01J...",
    "turnId": "nuh_turn_01J...",
    "backend": "codex",
    "category": "command_exec",
    "title": "请求在沙箱外执行网络命令",
    "command": "curl -s https://api.example.com/health",
    "workdir": "/Users/a0000/Developer/my-project",
    "reason": "sandbox_network_disabled"
  }
}

// Client -> Daemon (Response)
{
  "jsonrpc": "2.0",
  "id": "srv_req_99",
  "result": {
    "decision": "allow_once",   // "allow_once" | "allow_for_session" | "deny"
    "note": null
  }
}
```

---

## 6. 各后端事件到 NUH 标准事件的映射表

| NUH 标准事件 | `native-dsh` (Cordis/DSH) | `codex` (`codex app-server`) | `claude` (`stream-json`) | `agy` (`agy acp` / `stream-json`) |
| :--- | :--- | :--- | :--- | :--- |
| `item/started` (`agent_message`) | LLM 首字响应开始 | `item/started` (`agentMessage`) | `assistant` message start | ACP message chunk start / NDJSON start |
| `item/delta` (`text`) | LLM token stream chunk | `item/agentMessage/delta` | `content_block_delta` (`text_delta`) | ACP text delta / stream-json delta |
| `item/started` (`tool_call` / `command_exec`) | `ctx.tools` 执行前钩子 | `item/started` (`commandExecution` / `fileChange`) | `tool_use` block | ACP tool call update (`in_progress`) |
| `item/completed` | Tool 返回结果 / 异常 | `item/completed` | `tool_result` event | ACP tool call update (`completed` / `failed`) |
| `approval/requested` | DSH 审批拦截 / `execpolicy` `prompt` | `app-server` 服务端 approval request | `--permission-prompt-tool stdio` 控制请求 | ACP permission request（降级模式下由策略预先限制） |

> **注**：Phase 0 Spike 0.2 / 0.4 / 0.5 完成后，须用实测抓取到的真实 JSON 样本替换上表中的细节字段名，作为契约测试（Contract Fixture Tests）长期固化在 `packages/protocol/fixtures/` 中。
