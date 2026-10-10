# 执行交接包：durable ownership 设计提案（V11/V12 完整关闭，r1，提案非实施）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。**本包是设计提案，不含代码改动**。回应审计两轮共同指出的设计级缺口（M02-F001/F002 的诚实降级"不足以关闭完整 V11/V12"）。

## 问题重述（审计证据）

- **F001**：SDK 只在 generation final boundary 放置 queued 输入；前台 run 取消后无新边界，后台永远 stalled（`submissions.js:114-172`、`generation.js:182-194`）。
- **F002**：前台与后台被放入同一 active run 时，任务粒度无法精确取消；abortTask 会误伤非目标。
- **共同根因**：foreground 与 background **复用同一个 conversation**。队列停滞与混合 run 都是这个复用的直接产物。

## 方案 A（推荐）：按 ownership 分离 conversation

**规则**：foreground submissions 沿用调用方 conversation（现行为不变）；**每个 background executionId 获得独立的 durable conversation**（命名 `bg:<executionId>`）。

结构性效果：

| 审计缺陷 | 方案 A 下 |
| --- | --- |
| F001 队列停滞 | 每个 background 提交即在自己的 conversation 里启动自己的 run——**不存在排队**，无 stalled 态 |
| F002 混合 run | 前后台**结构上不可能同 run**——conversation 隔离即 turn 隔离 |
| V11 前台子树取消 | conversation abort 只作用于前台 conversation；background conversation 独立运行到终态，按原授权完成 |
| V12 作用域精确停止 | execution abort = 对 `bg:<executionId>` 的 conversation 做 abortTask——该 run 只含该 execution 的输入，**精确且可核对** |

## 关键设计点

1. **身份与效果守恒**：同一 requestId/effectKey/mapping；submissionId 照常入 mapping；recover 按 conversationId 逐个重建各 background conversation 的状态，不按标题猜。
2. **上下文来源**：background 不再"蹭"前台会话的上下文——由统一 ContextAssembler（M02-R2 已交付）按原授权装配注入，保留上下文来源（审计 V39 要求），不复制前台 transcript。
3. **并发上限**：复用 budget-policy（M02-R10 已交付）——每 owner 同时活跃 background conversation 数设预算（默认建议 3）；超额入 pending（非 SDK 队列，而是适配器自有的持久 pending 表，由完成事件驱动推进，**推进机制在我们手里，不依赖 SDK boundary**）。
4. **持久化**：route-binding-store 已持久 binding/intent；新增 background conversation 注册表（conversationId ↔ executionId ↔ requestKey ↔ status），同库同事务。
5. **迁移（r2 现状）**：现存的 stalled background（legacy conversation 内）保持 stalled 标记并进入核对清单；恢复路径为"在新 conversation 以同一 requestId 重新驱动，原 submission 标记 superseded-by-continuation，效果计数不增"——仅对从未产生效果的 stalled 项，且需逐项核对。
6. **取消语义映射**：submission abort → 该 background conversation 的 abortTask；execution abort → `bg:<executionId>` 整个 conversation；conversation abort（前台）→ 只前台；goal-wide 仍归 goal-runtime。

## 方案 B（已否决）

适配器自建队列驱动器，在 abort 后以新 run 重放 queued 输入：SDK 对同 requestId 重提交早返回不放置（`submissions.js:117-123`），换新 submissionId 则丢失效果键连续性，且"重派未明任务"正是审计禁止项。仅可作为"从未 placed、零效果"条目的兜底，不作主方案。

## 方案 C（现状，不充分）

r2 的诚实 stalled + 等外部 boundary 唤醒：已通过审计的诚实性审查，但不满足 V11"按原授权完成或失败"——被滞留后台可能永远等不到下一条用户消息。

## 实施切片建议（审计放行后）

1. background conversation 注册表 + `bg:<executionId>` 创建/恢复（runtime 新模块，复用 route-binding-store 同库）；
2. submit 路径按 ownership 分流（pi-adapter 修改，需 r3 revision）；
3. abort 三作用域重映射 + 精确性测试（前后台独立、execution 精确、不误伤）；
4. budget 并发上限 + 持久 pending 推进器；
5. stalled 迁移核对工具（仅核对，不自动重派）。

每片独立验收：F001/F002 的审计探针应全部转为"缺陷不存在"（结构消除而非降级）。

## 外部依赖说明

SDK 上游若提供 queue-advance API，方案 A 的 pending 推进器可简化；但方案 A 不依赖上游改动即可闭环 V11/V12，不把进度押在上游。

## 要求审计方做什么

- 裁决方案 A 是否作为 V11/V12 完整关闭的设计方向；重点审：conversation 分离的资源/状态成本、budget 上限语义、stalled 迁移的"仅零效果项可续"边界、与 Pi durable 模型的契合度。
