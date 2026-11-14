# NUH 架构决策记录（ADR）

本目录沉淀 Phase 0 调研与 5 个技术 Spike 实测后最终拍板的核心架构决策，作为 Phase 1+ 开发的不可回退约束依据。

| 编号 | 决策标题 | 状态 |
| :--- | :--- | :--- |
| [0001](./0001-option-c-protocol-first-no-dsh-fork.md) | 采用方案 C：协议边界隔离 + 不魔改 DSH 核心 | Accepted |
| [0002](./0002-agy-single-track-acp-stdio.md) | AGY 后端单轨锁定 `agy acp --stdio`（否决 `-p stream-json` 降级） | Accepted |
| [0003](./0003-dsh-base-app-boot-self-assembly.md) | 基于 `dsh-base + dsh-app-boot` 自组装无头 Profile | Accepted |
| [0004](./0004-mcp-bridge-daemon-resident-state.md) | `@nuh/mcp-bridge` 状态常驻 Daemon，stdio 入口作无状态转发代理 | Accepted |
