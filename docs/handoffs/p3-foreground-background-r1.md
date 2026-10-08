# 执行交接包：P3 / Wave 2.3 前台等待与后台执行分离（r1）——双时限替代单一整轮终结

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双 AI 协作协议](../plans/0.3.0-collaboration.md)。本包逐条回应 [p3-readiness-r1](p3-readiness-r1.md) 第 31 行识别的 **B02 核心项「前台等待与后台执行分离」**（现为零：单一 `promptTimeoutMs=300s` 结束整轮，session.ts:1374-1421，无后台延续概念）。r1 交接与旧文件保留不覆盖。

## 批次身份与状态

- batchId / revision：p3-foreground-background / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行 AI：Kimi Code 会话（执行方）；branch `feat/0.3.0-progress`；cwd `/Users/markus/ai-agent-cockpit`；subagent（deepseek-flash）实现，主 Agent 定稿设计合同、亲自复跑
- 已读并确认协作协议：是。本批允许写入且实际写入：`vendor/wechat-acp/src/acp/session.ts`、`vendor/wechat-acp/src/config.ts`、`vendor/wechat-acp/src/bridge.ts`、`vendor/wechat-acp/src/storage/message-inbox.ts`、`vendor/wechat-acp/README.md`、`vendor/wechat-acp/tests/session-timeout-retention.test.ts`、`vendor/wechat-acp/tests/session.test.ts`、`vendor/wechat-acp/tests/message-inbox.test.ts`、`vendor/wechat-acp/tests/session-foreground-background.test.ts`（新）、`vendor/wechat-acp/tests/bridge-foreground-background.test.ts`（新）、`scripts/test-memory-kimi.mjs`、`scripts/test-wechat-voice-live.mjs`、`docs/handoffs/p3-foreground-background-r1.md`（新）。**未改** `package.json`（根 / vendor）、`docs/audits/**`、`docs/plans/**`、`config/wechat-acp.json`（生产配置）、任何生产服务/launchd/真实用户文件；**未接真实微信、未启动真实 Agent CLI**；**未执行任何 git 命令**；**未新增任何依赖**
- 对应：B02/P3 核心项；T 前置就绪清单第 2、5 条。验收：前台等待到期不再终结整轮、只发一次后台 phase + 一条中文后台通知、receipt 标 `background`、迟到结果仍经 outbox 投递；唯一硬终结通道为 Grant 期限，文案/状态如实
- 本批目标：把单一 `promptTimeoutMs` 整轮终结拆为「前台等待（不杀）+ Grant 期限（唯一终结）」，并接上 `background` phase / receipt 状态 / 用户通知。明确不做：生产重启/部署、真实微信收发、真实外发、per-task 真实 Grant 由控制面下发（Wave 3 接线）、`/消息` 六类完整实现（Wave 2.4）、任何 git 操作
- vendor 说明：`vendor/wechat-acp/` 目录**无**自己的 `AGENTS.md`，故遵循仓库根 `AGENTS.md`；使用 vendor 自带测试 runner `node --import tsx/esm --test 'tests/**/*.ts'`，不新增依赖

## 固定来源

- base HEAD：`a9747bd185897504a4c63b96eebec6407d1b2a17`（读 `.git/HEAD` 与 `.git/refs/heads/feat/0.3.0-progress` 得到；**未执行任何 git 命令**）
- 变更/新增文件（SHA256，2026-10-08）：
  - `vendor/wechat-acp/src/acp/session.ts` `ef4101b5c17c52f82948281311edcb9699c4eb774e8d5204bbee95e1e91aae47`（1776 → 1813 行；`PromptTimeoutError`→`GrantDeadlineError`、`awaitAgentOperation` 两段式、新 opts、`onTurnEvent` 加 `background`、prompt 调用改造、catch 分支文案）
  - `vendor/wechat-acp/src/config.ts` `fba96d6326f3a30cb5f0009d893812e03682d9ead611ab4ec200c2a896291dfe`（511 → 523 行；`session` 类型删 `promptTimeoutMs`、加 `foregroundWaitMs`/`grantDeadlineMs` + 默认值）
  - `vendor/wechat-acp/src/bridge.ts` `adaea364294424ac535bc08d44f8a775ec6cdf992c9a0c3f579ac38f0e6563e5`（2456 → 2486 行；透传两键、`onTurnEvent` 处理 `background`、新增 `handleTurnBackground`、`/消息` labels 加「后台执行中」）
  - `vendor/wechat-acp/src/storage/message-inbox.ts` `252802e95747c274d51c08d30d6c80092359f5ec46017973e7a006e3411383f8`（583 → 586 行；`MESSAGE_INBOX_STATUSES`/`STATUS_RANK` 加 `background`、`recover()` 识别 `background`）
  - `vendor/wechat-acp/README.md` `640372d78e254eb9756aa2190d6b9cb8e258efcab5045dc8782279b5727b7dc7`（587 → 600 行；配置示例 + 两新键说明段）
  - `vendor/wechat-acp/tests/session-timeout-retention.test.ts` `41096ee4235752f1e319ecf1fe6bf6dc5f0d36e2f4444f65e67dbd7e5d2450dd`（161 行；7 处 `promptTimeoutMs`→`grantDeadlineMs`、1 处通知断言改中文「Grant 期限」）
  - `vendor/wechat-acp/tests/session.test.ts` `58bc14f35eac5501c34a5f43d89f0e5f3f37b7de724fe568b747c9bb5605771a`（626 行；1 处 `promptTimeoutMs: 20`→`grantDeadlineMs: 20`）
  - `vendor/wechat-acp/tests/message-inbox.test.ts` `e95b6d9f1102fecbe6f1cf03e7a3fe460e2769a04de548f772f54e79323a80fb`（353 → 389 行；新增 2 条 `background` 恢复用例）
  - `vendor/wechat-acp/tests/session-foreground-background.test.ts` `f43a21396336e20224aed45bfe2f3424067fa125d5d10e853cfb07343ad6c98a`（**新文件，167 行，5 用例**）
  - `vendor/wechat-acp/tests/bridge-foreground-background.test.ts` `17f8e6047fb2ade0bafd996092fca72702a981407c6ab4d712b2b2c26b3f2ab9`（**新文件，154 行，2 用例**）
  - `scripts/test-memory-kimi.mjs` `d190eced55e1d11e82e8cf8eda0fb51de5cf1ae5307e47264f6785651406339d`（63 行；`promptTimeoutMs: 90000`→`foregroundWaitMs: 60000, grantDeadlineMs: 90000`）
  - `scripts/test-wechat-voice-live.mjs` `63e68c7fe6d8af02d08ff41fccf0fe816855239d993c584b3e8e7465f3ba312a`（60 行；`promptTimeoutMs: 120000`→`foregroundWaitMs: 60000, grantDeadlineMs: 120000`）
- `package.json`（仓库根与 vendor）均**未改**；复用既有脚本：`test:runtime-policy` = `npm --prefix vendor/wechat-acp run build && node --test tests/request-authority.test.mjs …`
- 依赖：无新依赖
- 构建产物：按要求跑了 `npm --prefix vendor/wechat-acp run build`（`tsc`，strict），**`vendor/wechat-acp/dist/` 随之重新生成**（既有构建步骤，非源码改动）
- 自测前后 sourceRef 一致；只有上列 13 个源/测试/脚本文件按授权变更

## 设计合同逐条回答

### (1) 双时限替代单一整轮终结（`session.ts`）

**`awaitAgentOperation` 两段式重写**（改前 `:1614-1670`，改后 `:1633-1706`）：第 4 参数由 `timeoutMs?: number` 改为 `opts?: { foregroundWaitMs?, grantDeadlineMs?, onForegroundWaitExpired? }`。

- **前台等待（不杀）**：`foregroundWaitMs>0` 且有回调时注册一个 `setTimeout`；到期只调用 `onForegroundWaitExpired()`（`void Promise.resolve().then(...).catch(()=>{})`，fire-and-forget），**不 reject operation**，继续 `await` 同一 operation。定时器在 `finally` 清空，故每次 `awaitAgentOperation` **至多触发一次**前景到期。
- **Grant 期限（唯一终结）**：`grantDeadlineMs>0` 时注册 `deadlinePromise`，到期 `reject(new GrantDeadlineError(operationName, grantDeadlineMs))`，进入既有取消+cleanup 终止路径（`session.ts:1393` 起，语义复用）。
- 主循环结构**不动**：loop 仍 `await` 同一 operation；`result_ready→flush→onReply/outbox` 结果处理不变；前台到期仅多发一个 phase 事件。`"turn setup"` 调用（无 timeout）与 `"prompt response"` 调用（传新 opts）分别对应。
- prompt 调用改造（`session.ts:1283-1297`）：传 `foregroundWaitMs`/`grantDeadlineMs`，并挂 `onForegroundWaitExpired: () => this.opts.onTurnEvent?.(userId, pending, { phase: 'background', sessionId, processId })`。

**新 opts 与移除**：`SessionManagerOpts` 删 `promptTimeoutMs?: number`，加 `foregroundWaitMs?: number` / `grantDeadlineMs?: number`（`session.ts:119-130`）；`WeChatAcpConfig.session` 同步（`config.ts:205/211`）。**不留兼容别名**；全仓 `promptTimeoutMs` 引用已更新（见「固定来源」与「未覆盖项」——生产 `config/wechat-acp.json` 故意未动）。原 `PromptTimeoutError` 连同其 `timeoutMs` 字段重命名为 `GrantDeadlineError`/`deadlineMs`（`session.ts:217`）。

**终止路径文案如实**：
- 日志：`[..] Grant deadline of ${deadlineMs}ms exceeded; resetting the ACP session`（原 `Prompt timed out …`）。
- cleanup 延迟日志：`Grant-deadline ACP cleanup deferred`（原 `Timed-out ACP cleanup deferred`）。
- 用户通知（`session.ts:1434`，经 `onNotice/onReply` 投递，kind=`notice`）：`上一条任务已到 Grant 期限，未能完成，不能算作已处理。…`（原 `上一条处理超时…`），保留「后发消息已保留 / 原文已保留、不会自动重放 / 清理未确认」三段如实语义。
- fallback-retry 逻辑（`session.ts:1419` 起）**逐字未动**：Grant 期限到期后同样的单次 fallback 重试条件保持不变。

### (2) 新 phase 与用户通知（`bridge.ts`）

- `onTurnEvent` 事件的 `phase` 联合类型加 `'background'`（`session.ts:125`）。
- bridge 的 `onTurnEvent` handler（`bridge.ts:266-272`）：`event.phase === 'background'` 时改走新方法 `handleTurnBackground(userId, pending)` 并 `return`；其余 phase 逐字沿用原 checkpoint 逻辑（仅补了 `phase` 显式窄化以通过 strict 类型检查，行为不变）。
- **新增 `handleTurnBackground`**（`bridge.ts:791`）：
  1. 把该 turn 的 receipt 状态标为 `'background'`（`setReceiptStatus(receiptIds, 'background')`），失败只记日志、不打断 turn；
  2. 给用户发**一条**中文通知：`这条任务已转入后台执行，完成后的结果会照常发给你。后台期间你可以继续发新消息，也可以发 /acp-cancel 取消。`
  3. 通知走**既有 outbox 通道**：`replyOutbox.put({ kind: 'notice', receiptIds, dedupeKey: \`${receiptIds[0] ?? userId}:turn-background\` })` + `flushReplyOutbox(userId)`；无 outbox（理论上不会，因 onTurnEvent 仅在 recovery 启用时注册）时回退 `sendReply`。
- **每 turn 只发一次（去重）**：`replyOutbox.put` 以 `(userId, dedupeKey)` 哈希为 id，同 key 幂等返回既有记录、不新增、不重发；因此同一 turn 的重复 `background` 事件**持久级去重**（不依赖内存 Set）。
- **Grant 期限到期的终止**：session 已发中文「Grant 期限」通知（见 (1)）；receipt 侧由 `receiptCompletion.reject` → `retainFailedRequest(ids, 'GrantDeadlineError')` 落 `status='uncertain'` + `errorKind='GrantDeadlineError'`（与「崩溃/失败」在 errorKind 上可区分，且「不确定/待核对、永不自动重放」语义正确，见 (3)）。
- **后台期间 `/acp-cancel`**：session 仍存活，`/acp-cancel` 走既有 `handleAcpCancelCommand → sessionManager.cancelCurrent` 路径（无需改动），turn 以 `stopReason:'cancelled'` 收尾并回 `[cancelled]`。
- **后台完成的投递**：走既有 `result_ready → flush → onReply → outbox`，**未新增第二条投递通道**。
- `/消息` labels 加 `background: '后台执行中'`（`bridge.ts:570`），作为 receipt 新状态的最小可读数据源（`/消息` 六类完整重排仍属 Wave 2.4）。

### (3) 恢复语义不动

- `message-inbox.recover()`（`message-inbox.ts:557`）在 `running/buffered` 之外**新增识别 `background`**：`background` receipt 重启后按同一映射落到 `uncertain`（phase 为 dispatched/tool_activity）或 `reply_pending`（phase 已 result_ready），**永不自动重放**。
- `STATUS_RANK` 给 `background = 3`（与 `running` 同秩）：`running→background` 单调合法，`background→done/reply_pending/uncertain` 均合法；`background` **不是** `TERMINAL_STATUSES`（turn 仍在跑）。
- `sweepRecovery` **未改**：后台 receipt 若 session 仍存活，`liveIds.includes(id)` 直接跳过；若重启后已落 `uncertain`/`reply_pending`，由既有分支（`bridge.ts:865/877`）发「中断待核对」或补发结果——语义自洽，无需新增重放。
- **未新增任何重放通道。**

### (4) 测试（合成夹具 / fake ACP server）

见「反向负例清单」与「验证」。

## 默认值决策依据（标注待审计裁决）

| 键 | 默认值 | 依据 |
| --- | --- | --- |
| `foregroundWaitMs` | `120_000`（2 min） | 前台到期**不再杀 turn**，只多发一个「已转后台」事件 + 一次通知，因此 2 分钟是**安全的下界**，给出更好的聊天体验（用户更早知道任务转后台）。仅信息性，绝不终结。 |
| `grantDeadlineMs` | `30 * 60_000`（30 min） | Grant 期限是**唯一**硬终结通道；相对旧值 `promptTimeoutMs=300s` 放宽到 30 min，避免长任务被误杀，同时仍保证挂死 provider 不永久阻塞同用户队列。 |

两个默认值均落在 `config.ts:defaultConfig().session`。**per-task 真实 Grant 由控制面下发属 Wave 3 接线**（本批只落桥侧默认与通道）。

## 关键 diff 摘要

1. `session.ts`：`PromptTimeoutError`→`GrantDeadlineError`（含字段 `timeoutMs`→`deadlineMs`）；`SessionManagerOpts` 两新键、去 `promptTimeoutMs`；`onTurnEvent` phase 加 `background`；`awaitAgentOperation` 第 4 参数改 opts、新增前景定时器（不杀）+ Grant 定时器（reject）；prompt 调用挂 `onForegroundWaitExpired`；catch 分支 `instanceof GrantDeadlineError` + 日志/通知文案改「Grant 期限」。其余行未动。
2. `config.ts`：`session` 类型两新键 + 默认值；删 `promptTimeoutMs` 类型与默认。
3. `bridge.ts`：透传两键；`onTurnEvent` handler 分流 `background`；新增 `handleTurnBackground`；`/消息` labels 加一项。其它 handler、recovery sweep、outbox 投递**一行未动**。
4. `message-inbox.ts`：状态枚举/秩加 `background`；`recover()` 识别 `background`（更新 docstring）。
5. 测试：`session-timeout-retention.test.ts` 改键名 + 断言；`session.test.ts` 改键名；`message-inbox.test.ts` +2；新增 `session-foreground-background.test.ts`（5）+ `bridge-foreground-background.test.ts`（2）。
6. `scripts/test-*.mjs`：两处 dev 脚本键名迁移（拆分前台/Grant）。
7. 行尾：`session.ts`、`bridge.ts` 本就是**混合行尾**；本批仅在既为 LF 的区段插入 LF 行，未整文件归一化（避免噪声 diff），`tsc` 与运行时均无影响。

## 反向负例清单与原始结果摘要

新增用例均为 tmp 合成夹具（`fs.mkdtemp`）+ 内存/`EventEmitter` fake ACP session + 注入内存 `MessageInbox`/`ReplyOutbox`，**未接真实微信、未启动真实 Agent CLI、未发真实消息**：

- `session-foreground-background.test.ts`（5）：
  - 结果在前台窗口内返回 → 无 `background` phase、无通知（旧行为不变）
  - 前台到期 → **恰一次** `background` phase、session 仍存活、迟到结果仍投递
  - 前台窗口远小于实际耗时 → **恰一次** `background` phase（不重复、不重置）
  - Grant 期限到期 → 终止路径 + 中文「Grant 期限」通知 + 队列继续
  - 后台期间 `cancelCurrent` → `cancelledTurn=true`、cancel 到达连接、回 `[cancelled]`
- `bridge-foreground-background.test.ts`（2）：
  - 前台到期 → receipt 标 `background`、**恰好一条**去重后的可投递中文通知、不重派
  - 后台 receipt 未完成 → 重启后恢复为 `uncertain`、**永不重放**（含磁盘级复核）
- `message-inbox.test.ts`（+2）：`background`+dispatched → 恢复为 `uncertain` 且不进 pending；`background`+result_ready → 恢复为 `reply_pending`（结果补投、不重放）

为证明新负例**承重**而非仅正例通过，做两处**逆向变异**（每处先把原文件字节级备份到 `/tmp`，改后从备份还原并核对 SHA256 一致——**未使用 git**）：

| 变体 | 变异 | 结果 |
| --- | --- | --- |
| M1 original | 无 | `session-foreground-background.test.ts` **5/5 pass，0 fail** |
| M1 mutant | `session.ts` 前景定时器条件 → `if (false)`（前景到期从不触发） | **2 pass / 3 fail** |
| M2 original | 无 | `bridge-foreground-background.test.ts` **2/2 pass，0 fail** |
| M2 mutant | `bridge.ts` 通知 `dedupeKey` → 追加 `Math.random()`（去重失效） | **1 pass / 1 fail** |

M1 mutant 下失败的 3 条：`a foreground wait expiry emits one background phase and the late result is still delivered`（等待 background 事件超 2000ms）、`the foreground wait fires exactly once even when the turn runs many times longer`（`actual: 0, expected: 1`）、`a turn running in the background can still be cancelled`（等待 background 事件超时）。

M2 mutant 下失败的 1 条：`a foreground expiry marks receipts background and sends exactly one durable notice`（`actual: 2, expected: 1` —— 去重失效导致重复通知）。

还原后 `session.ts` SHA256=`ef4101b5…ae47`、`bridge.ts` SHA256=`adaea364…63e5`，与定稿逐字一致；`grep -rn MUTANT src/` 无残留。

## 验证

| 要求/Case | 实现 | 验证命令与 cwd | 结果 |
| --- | --- | --- | --- |
| 前台到期不杀、只发一次 background | 两段式 `awaitAgentOperation` | `node --import tsx/esm --test tests/session-foreground-background.test.ts`（vendor） | ✅ 5/5 |
| 结果在前台窗口内返回无 background | 前景定时器 finally 清空 | 同上 | ✅ 用例「a result returned inside the foreground window emits no background phase」 |
| Grant 期限到期终结且文案如实 | `GrantDeadlineError` + 中文通知 | 同上 | ✅ 用例「grant deadline terminates the turn with a truthful Chinese notice and continues the queue」`/Grant 期限/` |
| 后台期间可取消 | 既有 `cancelCurrent` | 同上 | ✅ 用例「a turn running in the background can still be cancelled」 |
| receipt 标 background + 单条通知 | `handleTurnBackground` + outbox dedupeKey | `node --import tsx/esm --test tests/bridge-foreground-background.test.ts`（vendor） | ✅ 2/2 |
| 后台崩溃恢复为 uncertain 不重放 | `recover()` 识别 `background` | `node --import tsx/esm --test tests/message-inbox.test.ts`（vendor） | ✅ +2 用例 |
| 既有超时保留语义回归 | 键名迁移 + 断言改中文 | `node --import tsx/esm --test tests/session-timeout-retention.test.ts`（vendor） | ✅ 8/8 |
| vendor 整包零回归 | — | `node --import tsx/esm --test 'tests/**/*.ts'`（vendor） | ✅ **tests 356 / pass 355 / fail 0 / skipped 1**（改前 347；+9） |
| vendor 类型构建 | `tsc` strict | `npm --prefix vendor/wechat-acp run build`（仓库根） | ✅ exit 0 |
| 仓库运行时策略门（含 vendor build） | — | `npm run test:runtime-policy`（仓库根） | ✅ **35/35**，exit 0 |
| 仓库密钥扫描门 | — | `npm run audit:secrets`（仓库根） | ✅ PASS：0 undispositioned credential-shaped hits |
| 逆向变异承重 | M1 / M2 重跑 | 见「反向负例」 | ✅ M1 3 用例、M2 1 用例精确失败 |

- 真实模型/原文外呼/生产读写/launchd/微信收发/真实外发：**均未发生**。全部为 tmp 合成夹具 + 内存注入；未 chmod 任何真实用户文件。
- 失败、部分结果和不明副作用：无。sourceRef 复核：仅上列 13 文件按授权变更；两处变异实验已还原并校验 SHA256。
- 活动进程/job/handle：测试用 `t.after`/`finally` 统一 `bridge.stop()`/`manager.stop()` 并 `fs.rm` 临时目录；`foregroundTimer`/`grantTimer` 在 `awaitAgentOperation` 的 `finally` 清空，无遗留定时器。`/tmp/session.ts.bak`、`/tmp/bridge.ts.bak` 为一次性还原备份，位于仓库外。
- 状态分列：实现完成 ✅（本批范围）；自测通过 ✅；独立审计：⏳ 待审计 AI；部署/真机：**未做**（生产服务仍跑旧代码）。

## 要求审计方做什么

- 按 **B02「前台等待与后台执行分离」** 复核本批 diff / 新 hash / 负例与反向变异结果。重点：① 前景到期是否**只**回调、绝不 terminate（`awaitAgentOperation` 前景分支不 reject）；② Grant 期限是否**唯一**终结通道且文案/日志/通知如实（`Grant 期限` / `Grant deadline`，无残留「超时重置」措辞）；③ `background` receipt 在恢复路径是否**永不自动重放**（`recover`/`sweep`/`hasUnconfirmedOldProcess` 一致性）；④ 通知去重是否**持久级**（outbox dedupeKey）且每 turn 至多一次；⑤ 未新增第二条结果投递通道（仍 `result_ready→outbox`）。
- 裁决两默认值（`foregroundWaitMs=120_000`、`grantDeadlineMs=30*60_000`）。
- 非返工前请确认：本包未触碰 `package.json`、`docs/audits/**`、`docs/plans/**`、`config/wechat-acp.json`（生产配置）。
- 等待期间继续的无冲突独立任务：`/消息` 六类（Wave 2.4，需「验收」第二类数据源）、Submission 登记收尾、派发小窗口收窄。

## 未覆盖项与诚实边界声明

- **per-task 真实 Grant 由控制面下发属 Wave 3 接线**：本批只落桥侧 `foregroundWaitMs`/`grantDeadlineMs` 默认值与通道，**未**接控制面按任务下发真实 Grant；真实 Grant 值随任务变化的效果**未经接线验证**。
- **生产配置 `config/wechat-acp.json` 未改**：其 `session.promptTimeoutMs: 300000` 为**生产文件**，本批按「不碰生产」铁律**故意未动**。运行中的 `bin/wechat-acp.ts` 以 `Object.assign(config.session, fileConfig.session)` 合并，故该 JSON 缺两新键时桥侧沿用 `config.ts` 默认值（`promptTimeoutMs` 成为无消费者的多余键，被静默忽略）。**建议 Wave 3 接线时由控制面/生产配置显式下发两新键并移除旧键**——本批不代改生产文件。
- **`/消息` 六类未完成**：本批只加 `background` 状态与 labels 一项；p3-readiness 第 33 行所指「后台 + 验收」两类的**完整** `/消息` 显示属 Wave 2.4；「验收」类数据源本批**未提供**。
- **真实微信抽验属 Markus/B02 验收**：本批只改代码 + 合成测试，**未**接真实微信、未发真实消息；后台通知、迟到结果补投的真机端到端效果**未经真机验证**。
- **生产未重启/未部署**：已在跑的服务仍执行旧代码；本包 READY 不授予部署权限。
- **sweep/恢复的 `hasUnconfirmedOldProcess` 未扩 `background`**：该函数只探活 `received/queued/retry_wait/running` 且 phase=`preparing` 的旧进程（`bridge.ts:942`）。后台 receipt 走 `recover()` 的 `uncertain` 分支——语义正确，未纳入探活；若审计要求后台态也做旧进程探活，请单列。
- **`/acp-more` 等既有文案**：本批**未改** `/消息`/`/acp-more` 文案；`/acp-cancel` 行为未改（仅验证后台态仍可取消）。
- **行尾**：`session.ts`/`bridge.ts` 为既有混合行尾，本批插入行为 LF，未整文件归一化——如后续有行尾统一策略，请单列，不在本批范围。
- 未执行真实外呼/生产读写/launchd/微信外发/服务重启/git；未改 `package.json`；未改 `config/wechat-acp.json`。
