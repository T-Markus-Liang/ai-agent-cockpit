# 执行交接包：P3/B02 微信链路现状地图与接线就绪清单（r1，只读探索）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。**本包是只读探索成果，不含代码改动**；目的是让 B02 实施（等 P1/P2 接线审计通过后）直接按图施工。

## 批次身份与状态

- batchId / revision：p3-readiness / r1
- 状态：**READY_FOR_REVIEW（探索）**
- 执行AI：Kimi Code 会话（执行方）；探索由该会话 subagent 完成，主 Agent 核对关键结论
- 对应：B02/P3 前置；T02/T03、V06–14/37/39/48
- 本批目标：MessageInbox→派发→结果→通知四段现状、四个崩溃点守恒清单、upgrade.md:101 映射链覆盖度、实施插入点。明确不做：任何代码改动

## 总体判断

桥侧今天是"MessageInbox→本地 ACP prompt→ReplyOutbox"legacy 链路。**收件/结果/通知三点守恒基本扎实（各有专项测试）**；B02 新增需求集中在：唯一 runtime Submission 登记、前台等待与后台执行分离、Grant 期限接入、`/消息` 六类显示——**这四项全部缺失**。

## 四个崩溃点守恒清单

| 崩溃点 | 现状 | 证据 |
| --- | --- | --- |
| ① 收件 | **扎实**：原子落盘（tmp+fsync+rename，0700/0600）先于游标推进；重放经 computeId 去重抑制；同 id 不同正文 fail closed | message-inbox.ts:147-159,251-284；monitor.ts:28-31；测试 monitor-admission/bridge-inbox |
| ② 派发 | **有小窗口**：prompt 实际发出但 dispatched 检查点未写（session.ts:1272-1276 之间）→ 重启后 phase 仍 preparing 被当 queued 重派；hasUnconfirmedOldProcess(pid 探活) 兜底但不覆盖"已发出未记 tool 活动"。已派发（dispatched/tool_activity）转 uncertain 永不自动重放是正确兜底 | message-inbox.ts:554-558；bridge.ts:892-901；测试 bridge-recovery:128-175 |
| ③ 结果 | **扎实**：result_ready 先落盘（含 resultText/stopReason）再入 Outbox；补发经 recoveredId+dedupeKey 幂等、绝不重跑；完成凭据查询要求 test exitCode=0+review passed+digest 匹配 | session.ts:1289；bridge.ts:768-803,844-867；测试 linked-task-recovery |
| ④ 通知 | **扎实**：Outbox 先 persist（0600）再发送；clientId 创建即固定；sending 重启复位 pending 续投；按用户 sequence 队首串行。注意点：无 dedupeKey 的 Outbox 记录（randomUUID id）无法跨重启去重 | reply-outbox.ts:155-235,260-321；bridge.ts:869-890 |

## B02 交付清单缺口

| B02 要求 | 现状 |
| --- | --- |
| 唯一 runtime Submission 登记 | **零**：桥侧 receipt id ≠ runtime Submission，grep submissionId/runtimeBinding 零命中 |
| 前台等待与后台执行分离 | **零**：单一 promptTimeoutMs=300s 结束整轮（session.ts:1374-1421），无后台延续概念 |
| Grant 期限接入 | **零**：桥侧无 grant/期限字段 |
| `/消息` 六类显示 | **3.5/6**：running/uncertain/failed/reply_pending/queued/retry_wait 有近似；**缺"后台"与"验收"两类**（receipt 无此状态数据源） |
| `/acp-more` 待补发 | **断链**：`/消息` 文案承诺"发 /acp-more 可重试补发"（bridge.ts:560），但 handler 走内存 pending-text（:1282-1321），未接 `replyOutbox.retryBlockedForUser`（唯一调用点在 :1500 的缓冲路径）——**T02/T03 直接缺口** |

## upgrade.md:101 映射链覆盖（11 环）

已有（近似）：userId、sourceRequestId（=receipt id）、payloadDigest（≈identity digest）、productTaskId（=execution.sourceTaskId）、outboxDeliveryId（≈Outbox id/clientId）。
**缺失**：ownerId、runtimeBinding、submissionId、executionId、durableTaskId、nativeRunRef（6 环，全部在 runtime 侧已建契约——runtimeBinding/submissionId 已有 route-binding/legacy-adapter 批次待审计）。

## 实施插入点（施工时按此，非现在改动）

1. **Submission 登记**：插在 `admitIncoming`（bridge.ts:711-720）`messageInbox.put` 成功后、`handleMessage` 前；数据源现成（record.id=sourceRequestId，附 ownerId）。
2. **后台事件通道**：复用 `onTurnEvent`（bridge.ts:260-262）四 phase 检查点；新增后台/Grant 期限通道（替代单一 promptTimeoutMs 的整轮终结语义）。
3. **`/消息` 六类**：bridge.ts:556 labels 外增"后台/验收"两类，需 receipt 增加对应状态数据源。
4. **`/acp-more` 断链修复**：handler 接 `replyOutbox.retryBlockedForUser`（只续投递不重执行语义已有，reply-outbox.ts:346-351）。
5. **派发小窗口**：dispatched 检查点前移到 prompt 发出前已部分覆盖（session.ts:1273 先于 :1276），剩余窗口需在接线设计时评估（建议：dispatched 前写"sent-unconfirmed"中间态，recover 对该态转 uncertain 而非 queued）。

## 要求审计方做什么

- 核对本地图与代码的一致性；裁决 B02 实施的先后（建议顺序：断链修复 → Submission 登记 → 后台分离 → /消息 六类 → 派发窗口）。
- 本包不含变更请求；B02 实施须等 P1/P2 接线审计通过（执行计划 B02 前置条件）。
