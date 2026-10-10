# 执行交接包：P3 / Wave 2.1 `/acp-more` 断链修复（r1）——durable outbox 续投投递接线

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双 AI 协作协议](../plans/0.3.0-collaboration.md)。本包逐条回应 [p3-readiness-r1](p3-readiness-r1.md) 第 34 行识别的 **`/acp-more` 断链（T02/T03 直接缺口）**。r1 交接与旧文件保留不覆盖。

## 批次身份与状态

- batchId / revision：p3-acp-more / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行 AI：Kimi Code 会话（执行方）；branch `feat/0.3.0-progress`；cwd `/Users/markus/ai-agent-cockpit`；subagent（deepseek-flash）实现，主 Agent 定稿设计合同、亲自复跑
- 已读并确认协作协议：是。本批允许写入且实际写入：`vendor/wechat-acp/src/storage/reply-outbox.ts`、`vendor/wechat-acp/src/bridge.ts`、`vendor/wechat-acp/src/telemetry/index.ts`、`vendor/wechat-acp/tests/bridge-more.test.ts`、`vendor/wechat-acp/tests/reply-outbox.test.ts`、`vendor/wechat-acp/tests/telemetry.test.ts`、`docs/handoffs/p3-acp-more-r1.md`（新文件）。**未改** `package.json`、`docs/audits/**`、`docs/plans/**`、任何生产服务/launchd/真实用户文件；**未执行任何 git 命令**；**未新增任何依赖**
- 对应：B02/P3 前置；T02/T03。验收：`/消息` 文案承诺的“发 /acp-more 可重试补发”在 handler 侧真正接上 durable outbox 续投，且只续投递、绝不重执行任务
- 本批目标：修复 `/acp-more` 断链。明确不做：生产重启/部署、真实微信收发、真实外发、把 durable 段的实际发送塞进 handler、任何 git 操作
- vendor 说明：`vendor/wechat-acp/` 目录**无**自己的 `AGENTS.md`，故遵循仓库根 `AGENTS.md`；使用 vendor 自带测试 runner `node --import tsx/esm --test 'tests/**/*.ts'`，不新增依赖

## 固定来源

- base HEAD：`3eb1bb8dce9560aa633e4fe005b1ea26a4e44747`（读 `.git/HEAD` 与分支 ref 得到；**未执行任何 git 命令**）
- 变更文件（SHA256，2026-10-08）：
  - `vendor/wechat-acp/src/storage/reply-outbox.ts` `bdbe7642284825d87ab4f344110b464428059580b4c7f0d8386e93f609ca004c`（363 行 → 374 行；仅改 `retryBlockedForUser`）
  - `vendor/wechat-acp/src/bridge.ts` `b56943b01ca9afea53bd1088a6be2e62fef28fed0f9ffb9df6af789b2bff0543`（2394 行 → 2411 行；仅改 `handleAcpMoreCommand`）
  - `vendor/wechat-acp/src/telemetry/index.ts` `c6553c4f72d392f8a39c8a5a5dc8979ec79d764a88d140462003df5c2dc71ac3`（630 行 → 631 行；仅 `command.acp_more` 允许键加 1 条）
  - `vendor/wechat-acp/tests/bridge-more.test.ts` `795fc100fa53d36e5b22fa8a10f7288c11509262b0225632a245267377703a6f`（199 行 → 328 行；**6 → 10 用例**，新增 4 条 + 3 条既有断言改中文）
  - `vendor/wechat-acp/tests/reply-outbox.test.ts` `15ad02e60023935c237aee2051422d1c9768686de4421b5bd1cef2c3fe517bf7`（184 行 → 193 行；强化 1 条既有用例断言续投计数）
  - `vendor/wechat-acp/tests/telemetry.test.ts` `b3f1f0fc9868714c89fce97dc22d7bdc59cded45a1214fd334dd17b937595c48`（539 行 → 578 行；新增 1 条白名单用例）
- `package.json`（仓库根与 vendor）均**未改**；复用既有脚本：`test:runtime-policy` = `npm --prefix vendor/wechat-acp run build && node --test tests/request-authority.test.mjs …`（多批共享）；vendor `test` = `node --import tsx/esm --test tests/**/*.ts`
- 依赖：无新依赖（仅复用既有 `ReplyOutbox` / telemetry 单例）
- 构建产物：按要求跑了 `npm --prefix vendor/wechat-acp run build`（`tsc`，strict），**`vendor/wechat-acp/dist/` 随之重新生成**（既有构建步骤，非源码改动）
- 自测前后 sourceRef 一致；只有上列 6 个源/测试文件按授权变更

## Finding 逐条回答

### T02/T03 直接缺口（`/acp-more` 断链）→ durable outbox 续投接线

**断链根因（定位）**：`bridge.ts:560` 的 `/消息` 文案承诺“待补发文本 N 段，其中 M 段已到重试上限；发 /acp-more 可重试补发”，但 `/acp-more` 的 handler `handleAcpMoreCommand`（改前 `bridge.ts:1282-1321`）只调用 `drainPendingText` 排空**内存** `pendingText`，**从未**调用 `this.replyOutbox.retryBlockedForUser(userId)`。`retryBlockedForUser`（`storage/reply-outbox.ts:346-351`）改前唯一调用点在 `bridge.ts:1500` 的缓冲刷新路径（`enqueueBufferedPrompt`），因此 durable outbox 里 `status === 'blocked'`（已到重试上限）的段**永远等不到续投**——用户按文案发 `/acp-more` 也无济于事。这是纯“漏接线”，不是逻辑错误：续投语义（只续投递、attempts 归零、nextAttemptAt=now）早已存在于 outbox。

**合同逐条**：

**(1) `reply-outbox.ts`：`retryBlockedForUser(userId)` 改返回 `Promise<number>`**
- 返回值 = 本次**实际**从 `blocked` 续投为 `pending` 的记录数（每次 `persist({ ...record, status: 'pending', attempts: 0, nextAttemptAt: this.now() })` 后 `renewedCount++`）。
- 其余语义**逐条不变**：只续投递、不重执行任务、`attempts` 归零、`nextAttemptAt = now`；非 `blocked` 记录跳过；仍走 `this.run(...)` 串行队列（与 outbox 其它写入互斥）。未新增/删除任何入参校验（保持原样，避免语义漂移）。
- 既有唯一消费点 `bridge.ts:1517`（缓冲路径）`await` 后忽略返回值，单值语义变化对其无影响。

**(2) `bridge.ts handleAcpMoreCommand`：在内存 drain 之外续投 durable blocked**
- 在 `queueSendTask(userId, …)` 内、`drainPendingText` **之前**先执行：`const renewedBlockedCount = this.replyOutbox ? await this.replyOutbox.retryBlockedForUser(userId) : 0;`（无 outbox 时为 `0`）。随后照旧 `drainPendingText` 排空内存段——**两路都做**。
- 保持 `queueSendTask` 串行与 `isCurrent()`（`isMessageGenerationCurrent`）generation 检查**不变**：续投前、续投后、drain 后各保留 `isCurrent()` 短路（旧代次不续投、不发送）。
- **用户反馈如实反映两路**（中文，风格与 `:560` `/消息` 文案一致）：
  - 有续投：`已恢复 {n} 段到重试上限的待补发文本，稍后会自动重试补发。`
  - 有内存段：`待补发文本共 {pendingCount} 段，本次已发出 {sentCount} 段[，仍有 {remainingCount} 段未发出]。`
  - 两路都空才回：`目前没有待补发的消息。`（改前英文 `"No pending messages right now."` 是缺口，**一并改为中文**；交接包在此注明，见下“未覆盖项”关于下游断言同步）
- telemetry `command.acp_more` 新增属性 `renewedBlockedCount`（有界整数）。
- **语义（务必写入审计）**：本 handler **不直接发送** durable 段——续投后 `blocked → pending`（`nextAttemptAt = now`）即返回；durable 段的**实际发送由既有 outbox drain 机制接管**（`flushReplyOutbox` 由 recovery sweep `bridge.ts:841` 按用户驱动）。即 `/acp-more` 只做“续投递 + 如实反馈”。

**(3) telemetry 白名单（r2 版）同步扩**
- `vendor/wechat-acp/src/telemetry/index.ts` 的 `EVENT_PROP_SCHEMA["command.acp_more"]` 加 `renewedBlockedCount: "int"`。`trackEvent` 对未知键**静默丢弃**（不抛），故必须显式加入；`int` 走既有有界化：非有限/负值丢弃、`Math.trunc` 截断、上限 `MAX_INT = 1e12`。值为有界整数，符合合同要求。

**(4) 测试**（见“反向负例清单”）。

**(5) 交接包**：本文件。

## 关键 diff 摘要

1. `vendor/wechat-acp/src/storage/reply-outbox.ts`（`retryBlockedForUser`）
   - 签名 `Promise<void>` → `Promise<number>`；函数体加 `let renewedCount = 0;`，对每个 `userId` 匹配且 `status === 'blocked'` 的记录 `persist` 后 `renewedCount++`，`return renewedCount;`；补契约注释。其余方法（`put/claimDue/settle/recover/cancelForUser/…`）逐字未动。
2. `vendor/wechat-acp/src/bridge.ts`（`handleAcpMoreCommand`，改前 `:1282-1321`）
   - 新增续投块（`drainPendingText` 之前）+ `renewedBlockedCount`；`trackEvent("command.acp_more", …)` 属性加 `renewedBlockedCount`；把原来“仅当 `pendingCount === 0` 才发英文空态”改为“构造两路中文反馈段，两路都空才发中文空态”。其它 handler（`/消息`、`/目标`、`/acp-new`、`/acp-cancel`、缓冲、recovery、`flushReplyOutbox` 等）**一行未动**；`bridge.ts:560` `/消息` 文案**未改**（其承诺现在真正兑现）。
3. `vendor/wechat-acp/src/telemetry/index.ts`：`command.acp_more` 允许键加 `renewedBlockedCount: "int"`，仅此 1 行。
4. 测试：`bridge-more.test.ts` 新增 4 用例 + 既有 3 处英文断言改中文；`reply-outbox.test.ts` 1 用例断言续投计数（0 / 2 / 0）；`telemetry.test.ts` 新增 1 条白名单用例。
   - 行尾注意：`bridge.ts` 本就是**混合行尾**（改前即 1814 处 CRLF + 580 处 LF）；本批在 `handleAcpMoreCommand` 内插入的新行采用 LF，与该函数内既有混合行尾一致，`tsc` 与运行时均无影响（未整文件改写行尾，避免噪声 diff）。

## 反向负例清单与原始结果摘要

新增/强化用例覆盖：durable blocked 续投（段回 `pending`、`attempts` 归零）、durable + 内存两路同时续、两路皆空的中文空态、续投计数如实（2 条 → 含 2）、outbox 级计数（0 / 2 / 0）、telemetry 白名单含 `renewedBlockedCount` 且有界。全部为 tmp 合成夹具（`fs.mkdtemp`）+ 注入内存 outbox，**未接真实微信、未发真实消息**。

为证明新负例**承重**而非仅正例通过，对 `vendor/wechat-acp/src/bridge.ts` 做**一处逆向变异**（先把原文件复制到 `/tmp/bridge.ts.bak` 作字节级备份，改后从备份还原并核对 SHA256 一致——**未使用 git**）：把 handler 内 `? await this.replyOutbox.retryBlockedForUser(userId)` 的续投调用替换为 `? 0 /*MUTANT: no renewal*/`（即“handler 不续投”，仅模拟断链，不动 outbox 本体），重跑 `tests/bridge-more.test.ts`：

| 变体 | 变异 | 结果（同一测试文件） |
| --- | --- | --- |
| original（本轮源码） | 无 | **10/10 pass，0 fail** |
| mutant | handler 续投调用 → `? 0` | **7 pass / 3 fail** |

mutant 下失败的 3 条（原始断言输出）：

- `acp-more renews durable blocked segments and never re-executes the task` → `AssertionError: actual: 'blocked', expected: 'pending'`
- `acp-more renews both durable blocked segments and in-memory pending text` → `AssertionError: actual: 'blocked', expected: 'pending'`
- `acp-more reports the exact renewed blocked count` → `AssertionError: actual: [{ contextToken: 'context-more', segment: '目前没有待补发的消息。' }], expected: [{ contextToken: 'context-more', segment: '已恢复 2 段到重试上限的待补发文本，稍后会自动重试补发。' }]`

结论：3 条续投用例精确捕获“handler 未续投 durable blocked”这一断链回归（第 4 条空态用例在 mutant 下仍通过，符合预期——它不依赖续投路径）。还原后 `bridge.ts` SHA256 与备份逐字一致（`b56943b0…0543`），无 `MUTANT` 残留。

## 验证

| 要求/Case | 实现 | 验证命令与 cwd | 结果 |
| --- | --- | --- | --- |
| blocked 段回 pending、attempts 归零、任务不重执行 | handler 续投 + `enqueued` 断言 | `node --import tsx/esm --test tests/bridge-more.test.ts`（vendor） | ✅ 用例「acp-more renews durable blocked segments…」：`status pending`、`attempts 0`、`nextAttemptAt ≤ now`、`enqueued === []` |
| blocked + 内存两路都续 | 续投 + drain 两路 | 同上 | ✅ 用例「…renews both durable blocked segments and in-memory pending text」：段回 pending 且内存段已发出 |
| 两路皆空如实中文回复 | `renewedParts.length === 0 && pendingCount === 0` | 同上 | ✅ 用例「…nothing to renew replies in Chinese…」：`目前没有待补发的消息。`、outbox 无新记录 |
| 续投计数如实（2 → 含 2） | `renewedCount` 回传 + 反馈拼接 | 同上 | ✅ 用例「…reports the exact renewed blocked count」：反馈含 `已恢复 2 段…`，且 blocked 归 0 |
| outbox 方法计数语义 | `retryBlockedForUser` 返回记录数 | `node --import tsx/esm --test tests/reply-outbox.test.ts` | ✅ 强化用例：`someone-else → 0`、`u1 → 2`、取消后再调 `→ 0` |
| telemetry 白名单含新键且有界 | 允许键 + `int` 有界化 | `node --import tsx/esm --test tests/telemetry.test.ts` | ✅ 新用例：`renewedBlockedCount: 3` 透出为 `"3"`、未知键丢弃、负值丢弃 |
| 既有英文空态断言同步 | — | 同上 | ✅ 3 处既有断言改中文后通过 |
| vendor 整包零回归 | — | `node --import tsx/esm --test 'tests/**/*.ts'`（vendor） | ✅ **tests 331 / pass 330 / fail 0 / skipped 1**（改前 326；+5） |
| vendor 类型构建 | `tsc` strict | `npm --prefix vendor/wechat-acp run build`（仓库根） | ✅ exit 0 |
| 仓库运行时策略门（含 vendor build） | — | `npm run test:runtime-policy`（仓库根） | ✅ **35/35**，exit 0 |
| 逆向变异承重 | mutant 重跑 | 见“反向负例” | ✅ 3 条续投用例在 mutant 下精确失败 |

- 真实模型/原文外呼/生产读写/launchd/微信收发/真实外发：**均未发生**。全部为 tmp 合成夹具 + 内存注入；未 chmod 任何真实用户文件。
- 失败、部分结果和不明副作用：无。sourceRef 复核：仅上列 6 文件按授权变更；`bridge.ts` 变异实验已还原并校验 SHA256。
- 活动进程/job/handle：测试用 `after` 钩子在用例结束统一 `outbox.close()` 并 `fs.rm` 临时目录，无遗留定时器（所注入 outbox 不启动 sweep）；`/tmp/bridge.ts.bak` 为一次性还原备份，位于仓库外。
- 状态分列：实现完成 ✅（本批范围）；自测通过 ✅；独立审计：⏳ 待审计 AI；部署/真机：**未做**（生产服务仍跑旧代码，`/acp-more` 断链的真机效果另批验收）。

## 要求审计方做什么

- 按 **T02/T03 断链** 复核本批 diff / 新 hash / 负例与反向变异结果。重点：① handler 是否同时做了“续投 durable”与“drain 内存”两路，且不直接发送 durable 段（只靠既有 outbox drain）；② `retryBlockedForUser` 返回计数是否只计**实际**续投记录；③ telemetry 新键是否真的进了白名单且为有界整数（未知键会被静默丢弃，务必确认没有漏加）；④ 中文反馈在三态（仅续投 / 仅内存 / 两路 / 皆空）下是否如实。
- 非返工前请确认：本包未触碰 `package.json`、`docs/audits/**`、`docs/plans/**`；`bridge.ts:560` `/消息` 文案未改。
- 等待期间继续的无冲突独立任务：p3-readiness 中“Submission 登记 → 后台分离 → `/消息` 六类 → 派发窗口”等其它 T 项。

## 未覆盖项与诚实边界声明

- **真实微信抽验属 Markus/B02 验收**：本批只改代码 + 合成测试，**未**接真实微信、未发真实消息。`/acp-more` 在真实 blocked 段上的端到端补发效果**未经真机验证**，需 Markus/B02 在验收环境抽验。
- **真实外发未测**：durable 段的**实际发送**由既有 outbox drain（recovery sweep `bridge.ts:841` → `flushReplyOutbox`）接管；本批**未**在 handler 内直接发送，也**未**新增/触发 drain。测试仅断言“段回到 `pending`”，durable 段随后是否被 sweep 发出**依赖运行中的 sweep 周期与真实发送通道**，不在本批合成测试覆盖内。
- **生产未重启/未部署**：已在跑的服务仍执行旧代码；本轮为源码 + 合成测试，生产重启/部署另批，本包 READY 不授予该权限。
- **空态文案变更的下游影响**：`handleAcpMoreCommand` 的英文空态 `"No pending messages right now."` 改为中文 `目前没有待补发的消息。`。本批已同步 `/acp-more` 相关的 3 处 vendor 断言；**若仓库其它位置（文档/其它测试/e2e）存在对该英文字面量的依赖，需另行核对**——本批未全仓扫描该字面量。
- **durable 段无 dedupeKey 时跨重启不去重**：p3-readiness 第 24 行已点出（randomUUID id）。本批续投沿用既有记录 id（`persist` 保留 `record.id`/`clientId`），**未**改变去重语义；若审计要求跨重启强去重，请单列。
- **行尾**：`bridge.ts` 为既有混合行尾，本批插入行为 LF，未整文件归一化——如后续有行尾统一策略，请单列，不在本批范围。
- 未执行真实外呼/生产读写/launchd/微信外发/服务重启/git；未改 `package.json`。
