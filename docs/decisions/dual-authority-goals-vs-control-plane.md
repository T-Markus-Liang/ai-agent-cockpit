# 设计说明：Goals 链与 :4324 tasks/executions 双链路（待裁决）

日期：2026-10-10。状态：**设计事实陈述 + 选项分析，裁决权在 owner/审计**。

## 事实

系统里存在两条任务/执行权威链，当前**不共享记录**：

1. **Goals 链**（`gateway/goals.mjs` + `control-plane/goal-runtime.mjs`）：goal 生命周期（draft→grant→iterations→complete），证据写在 goals 自有 stateDir 的 `task-proof/`（ControlPlaneStore 实例，文件 `control-plane.json`）。D89 已实测：五段全通，证据落盘。
2. **:4324 control-plane 链**（`gateway/control-plane.mjs` + S03b execution-grant）：Task/Execution/Approval/Evidence 的 HTTP 面（:4324/api/control-plane/…），浏览器 approvals/tasks/executions 卡经 ui-proxy 读的就是这条链的投影。

两者关系：goal-runtime 的 `this.tasks`（ControlPlaneStore）是**与 :4324 同构的 store 库、不同实例、不同目录**（goals 用 `~/.local/state/personal-ai-os/goals/task-proof/`，:4324 用自己的 stateDir）。即"同一份合同、两个独立账本"。

## 已验证的交界

- goal-runtime 内部为 worker/reviewer 创建 admitted executions、decideApproval、completeTask——这些是 **task-proof 本地账本**内的记录，不进 :4324。
- :4324 的 tasks/executions/approvals API 读不到 goal 的运行记录（实测：goals 跑 complete 期间 :4324 无对应 execution）。浏览器 goals 卡读 goals 代理、executions 卡读 :4324——** cockpit 用户视角已是两栏**。

## 选项

| 选项 | 做法 | 代价 | 收益 |
| --- | --- | --- | --- |
| A. 接受双权威（显式文档化） | 认可 goals=执行账本、:4324=调度/准入账本；文档写明各自边界与查询入口 | 低（就是现在+文档） | 无跨写耦合；符合"单 writer"裁剪原则（C14 精神） |
| B. goals 账本投影进 :4324 | goal settle 时向 :4324 写只读镜像记录 | 中：需要新写面+幂等+权限 | cockpit 单一查询面；审计单点 |
| C. 合并账本 | goals 直接用 :4324 的 Task/Execution 面 | 高：跨服务事务、可用性耦合 | 单一权威 |

## 建议

**A（接受双权威）+ B 的只读投影作为 0.3.x 后续候选**。理由：两条链的生命周期粒度不同（goal 迭代 vs 单次 dispatch），合并（C）引入跨服务写依赖，违背"不重复状态机"（C14）且当前无真实需求；B 的镜像只做"读便捷"不做"写权威"，可在写面恢复批（owner 凭据决策后）一并设计。本说明即选项 A 的文档化落点，请 owner/审计裁决是否接受。
