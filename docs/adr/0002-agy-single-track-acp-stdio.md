# ADR-0002：AGY 后端单轨锁定 `agy acp --stdio`（否决 `-p stream-json` 降级路径）

- **状态**：Accepted
- **日期**：2026-11-14
- **依据**：Phase 0 Spike 04（`agy` CLI `1.5.9` 对比实测）

## 背景
原规划草案曾考虑以 `agy acp --stdio` 为主路径、以 `agy -p --output-format stream-json` 作为异常自动降级路径。

## 实测事实与决策原因
1. **`agy -p --output-format stream-json` 安全契约失效（一票否决）**：无 `--permission-prompt-tool stdio`，且即使未传 `--dangerously-skip-permissions`（且 `init` 声明 `"permission_mode":"request-review"`），跨工作区命令 `touch /tmp/nuh_agy_perm_probe && rm ...` 仍未触发审批直接执行完毕（`exit_code: 0`）。
2. **冷启动与协议代价高**：`-p` 模式每轮冷启至 `init` 需 `4.60–7.47s`，使用私有 NDJSON 格式且 `--input-format stream-json` 不兼容 Claude 格式。
3. **`agy acp --stdio` 满足全链路需求**：`initialize` 约 `52–71ms`、常驻会话复用、支持 `session/set_config_option` 毫秒级热切换模型/思考强度、支持字符串 `id` 的 `session/request_permission` 双向审批（`allow` 放行、`deny` 精确阻断未写磁盘），且支持跨进程 `session/resume`。

## 决策
- `@nuh/backends` 中 `agy` 适配器**单轨锁定 `agy acp --stdio`**，彻底删除 `-p stream-json` 降级路径。
- 子进程崩溃恢复策略为：**进程重启 + `session/resume`**，绝不向无审批防线的 `-p` 模式降级。
- 协议层显式支持服务端请求 `id: number | string`（兼容 ACP 字符串 `"1"`）及 `.passthrough()` 透传 `agentCapabilities` 驼峰/下划线混用字段。
