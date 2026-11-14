# Phase 0 立即执行验证清单（Spike & Verification Runbook）

> **目的**：在创建正式 Monorepo 之前，用最低成本（5 个独立小实验）把所有外部不确定性在本地终端实测落地。**只有 Spike 全部通过或明确兜底方案后，才进入 Phase 1 编码。**

---

## Spike 0.1：本机环境补齐与 DSH 无头插件兼容性验证

### 1. 检查与安装缺失 CLI
- **当前已确认**：`node v26.4.0`、`pnpm 11.9.0`、`codex-cli 0.167.0`。
- **待确认**：
  - 安装或检出 `@deepseek-ai/dsh`（验证在 Node `v26.4.0` 下是否直接兼容，有无原生依赖编译问题）。
  - 定位或安装 `claude` CLI 与 `agy` CLI，记录绝对路径与认证状态：
    - `codex login status`（或验证 `~/.codex/auth.json` 订阅登录态）
    - `claude --version` 及非交互登录态检查
    - `agy --version` 及 `~/.gemini/antigravity-cli/settings.json` 检查

### 2. 验证 DSH 无头插件加载（核心假设验证）
- **验证目标**：不启动 `dsh web`（无前端），仅通过 `@deepseek-ai/dsh-sdk-client` 或 `@deepseek-ai/dsh-acp` / Cordis 直接启动 `@deepseek-ai/dsh-base`。
- **检查点**：
  1. 导出/检查 `@deepseek-ai/dsh-base` 实际提供的 Cordis `ctx.*` 服务名列表；
  2. 尝试挂载至少 1 个真实社区 `dsh-plugin`（例如 `dsh-mcp-hub` 或 `dsh-mnemon`）；
  3. 确认插件在无 Web UI 环境下**不抛未定义 UI 服务异常**，且成功向 `ctx.tools` 注册工具。
- **失败兜底**：若某插件强依赖 Web UI 服务，则记录缺失的服务接口清单，用于 Phase 1 编写 `@nuh/ui-stub` 轻量桩插件。

---

## Spike 0.2：`codex app-server` 协议导出与订阅额度实测

### 1. 导出精确 TypeScript 协议绑定
本机 `codex-cli 0.167.0` 已自带协议生成命令，直接运行以获取 100% 匹配本机版本的类型定义：
```sh
codex app-server generate-ts --out ./scratch/codex-ts
codex app-server generate-json-schema --out ./scratch/codex-schema
```
*(提示：若需查看实验性字段，可追加 `--experimental`)*

### 2. 跑通最小 Node.js 驱动脚本
- 用 Node `child_process.spawn('codex', ['app-server', '--stdio'])` 启动子进程；
- 按导出 TS 类型依次发送：`initialize` → `thread/start` → `turn/start`（使用只读提示词，如“列出当前目录文件并总结”）；
- 捕获并保存完整 `stdout` NDJSON 样本（作为日后 `PROTOCOL-v0.1` 的契约 Fixture）；
- 再发一轮触发命令执行的 Turn（带 `-a on-request`），验证客户端是否收到服务端主动发出的审批 Request 并成功回复放行。

### 3. 通过标准
- 在不填写 `OPENAI_API_KEY`（纯走 `codex login` ChatGPT 订阅登录态）的情况下完成完整多轮问答与工具审批。

---

## Spike 0.3：`codex sandbox` 隔离与拒绝反馈验证

### 1. 验证命令
测试本机 `codex sandbox`（macOS Seatbelt）对工作区外写入、断网及 denial 日志的捕获效果：
```sh
# 测试 1：禁止网络访问
codex sandbox --sandbox-state-disable-network --log-denials -C . -- curl -I https://example.com

# 测试 2：测试工作区写入边界（写入 /tmp 或项目外路径的拒绝日志）
codex sandbox --log-denials -C . -- sh -c "touch /tmp/nuh_sandbox_probe && rm /tmp/nuh_sandbox_probe"
```
### 2. 通过标准
- 确认 `--sandbox-state-disable-network` 能有效阻断外联；
- 确认 `--log-denials` 能在命令退出后提取 macOS sandbox denial 信息，作为 Phase 3 向模型反馈“为什么被拦截”的依据。

---

## Spike 0.4：`claude` CLI 双向 `stream-json` 与 `--mcp-config` 注入

### 1. 验证点
1. 测试启动长驻双向流：
   ```sh
   claude --input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio
   ```
2. 向 `stdin` 写入一条 NDJSON 用户消息，抓取完整 `stdout` 事件流（记录 `system` / `assistant` / `tool_use` / `result` 结构及 `session_id`）。
3. 使用上一步获取的 `session_id`，追加 `--resume <session_id>` 验证二轮上下文记忆是否连续。
4. 构造一个极简本地测试 MCP Server（提供一个 `nuh_ping` 工具），通过 `--mcp-config <tmp.json>` 传给 `claude`，验证 Claude 能否成功发现并调用 `nuh_ping`。

---

## Spike 0.5：`agy` CLI（ACP 模式与 Stream-JSON 兜底）

### 1. 验证点
1. **ACP 主路径**：用 Node 子进程拉起 `agy acp`，发送 ACP 初始化握手与一轮只读对话请求，验证流式输出与 Session 复用能力。
2. **Headless 降级路径**：测试 `agy -p "Reply with PONG" --output-format stream-json`，保存 NDJSON 样本，确认其与 ACP 路径在登录态复用上的差异。

---

## Phase 0 准出检查表（Exit Criteria）

- [ ] `dsh` / `claude` / `agy` / `codex` 四者本机路径与认证方式全部记录在案
- [ ] DSH 无头加载第三方 `dsh-plugin` 实测成功（或已明确所需 UI Stub 接口）
- [ ] `codex app-server generate-ts` 已导出且订阅 OAuth 实测跑通
- [ ] `claude` `--mcp-config` 工具注入与 `--resume` 实测跑通
- [ ] `agy acp` 与 `stream-json` 实测样本已保存
- [ ] 根据实测样本修订完 `docs/PROTOCOL-v0.1.md` 中的精确字段名
