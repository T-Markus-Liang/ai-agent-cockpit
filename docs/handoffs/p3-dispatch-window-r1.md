# 执行交接包：P3 / Wave 2.5 派发小窗口收紧（`sent-unconfirmed` 中间态，r1）——B02 最后一项

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双 AI 协作协议](../plans/0.3.0-collaboration.md)。本包逐条回应 [p3-readiness-r1](p3-readiness-r1.md) 第 22 行识别的 **崩溃点②（派发）残余窗口** 与第 47 行的建议（"dispatched 前写 sent-unconfirmed 中间态，recover 对该态转 uncertain 而非 queued"）。r1 交接与旧文件保留不覆盖。

## 批次身份与状态

- batchId / revision：p3-dispatch-window / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行 AI：Kimi Code 会话（执行方）；branch `feat/0.3.0-progress`；cwd `/Users/markus/ai-agent-cockpit`；subagent（deepseek-flash）执行
- 已读并确认协作协议：是。本批允许写入且实际写入：`vendor/wechat-acp/src/storage/message-inbox.ts`、`vendor/wechat-acp/src/acp/session.ts`、`vendor/wechat-acp/src/bridge.ts`、`vendor/wechat-acp/tests/dispatch-window.test.ts`（新文件）、`docs/handoffs/p3-dispatch-window-r1.md`（新文件）。**未改** `package.json`（仓库根与 vendor）、`docs/audits/**`、`docs/plans/**`、任何生产服务/launchd/真实用户文件；**未新增任何依赖**
- 对应：B02/P3 最后一项；崩溃点②（派发）。验收：新增 `sent-unconfirmed` 前置持久态，使其成为唯一承重的"发送前"安全标记；recover 对该态转 `uncertain`（永不 queued/重放）；`scheduleRetry` 视其为不安全；守恒性质有崩溃矩阵与逆向变异证据
- 本批目标：收紧派发窗口。明确不做：接真实微信、起真实 Agent、生产重启/部署、真实外发、任何 git 变更操作
- vendor 说明：`vendor/wechat-acp/` 目录**无**自己的 `AGENTS.md`，故遵循仓库根 `AGENTS.md`；使用 vendor 自带测试 runner `node --import tsx/esm --test 'tests/**/*.ts'`，不新增依赖

## 固定来源

- base HEAD：`9f7792c107f313c65bd1a8f824908bf29d29c77d`（读 `.git/HEAD` 与 `.git/refs/heads/feat/0.3.0-progress` 得到）
- 诚实披露（见"未覆盖项"）：执行方在**开工首次探图**时用过两条只读命令 `git status --short`、`git branch --show-current`；**未执行任何 git 变更命令**（无 add/commit/reset/rebase/checkout/push），工作区无 git 副作用。其余来源核对均走 `shasum`/`cat .git/...`
- 变更文件（SHA256，2026-10-08，**改后**）：
  - `vendor/wechat-acp/src/storage/message-inbox.ts` `20e2a870aa6d4714560e43473c99a56a87038f65dd852730088c319ba63000be`（586 → 602 行；加 `sent-unconfirmed` 到 phase 联合/校验数组，并在 `recover`/`scheduleRetry` 补契约注释）
  - `vendor/wechat-acp/src/acp/session.ts` `f226843ef19fb0fa224bd653ef684e4a9c3a0d132f0909dfb641fec93443859a`（1813 → 1817 行；`onTurnEvent` 类型加 `sent-unconfirmed`，主循环加 1 处前置 `await`）
  - `vendor/wechat-acp/src/bridge.ts` `4f4136237232911d1e47be7b1d3822868d872566778721520064bef1990e1f2b`（2520 → 2520 行；`onTurnEvent` 的 checkpoint phase 断言联合加 `sent-unconfirmed`，仅 1 行）
  - `vendor/wechat-acp/tests/dispatch-window.test.ts` `7110ed9ae0935967c17400e00079b04fc9ad4cffa98863ed66399ae027aa823c`（336 行，**新文件**，7 用例）
- `package.json`（仓库根与 vendor）均**未改**；复用既有脚本：`test:runtime-policy`、vendor `test` = `node --import tsx/esm --test tests/**/*.ts`
- 依赖：无新依赖
- 构建产物：按要求跑了 `npm --prefix vendor/wechat-acp run build`（`tsc`，strict，exit 0），`vendor/wechat-acp/dist/` 随之重新生成（既有构建步骤，非源码改动）
- 自测前后 sourceRef 一致；只有上列 4 个源/测试文件按授权变更

## 残余窗口分析：窗口在不在、在哪里（逐行核对）

**结论：在现网当前代码里，主派发路径的"双派发窗口"已经不存在；真正的承重缺口是"安全语义依赖一个 UI 事件"，本批把它换成显式、具名、被 recovery 映射与测试钉死的 `sent-unconfirmed`。另有一条与本批正交的残余窗口（fallback 重入），如实列出但不在本批范围。**

### 逐行核对（`session.ts` 主循环，改后行号）

| 行 | 语句 | 是否落盘 | 与 send 的先后 |
| --- | --- | --- | --- |
| 1276 | `await onTurnEvent(..., { phase:'preparing' })` | 是（durable，`beginAttempt=true`→status=running、phase=preparing） | **先于 send** |
| 1277-1279 | `preparePrompt(...)`（桥侧含 `setReceiptStatus('running')` + 记忆增强） | 否（不改 phase） | 先于 send |
| 1280 | `if (!isCurrentSession) continue` | — | 先于 send |
| 1282 | `session.promptDispatched = true`（**仅内存**标志） | 否 | 先于 send |
| **1286（本批新增）** | `await onTurnEvent(..., { phase:'sent-unconfirmed' })` | **是（durable，atomic+awaited）** | **先于 send** |
| 1287 | `await onTurnEvent(..., { phase:'dispatched' })` | 是（durable） | 先于 send |
| 1290 | `connection.prompt({...})`（真正的 send 发起） | — | **send 点** |
| — | `result_ready`（此后） | 是 | 后于 send |

### 落盘是否"真的原子 + awaited"

- **原子**：`MessageInbox._writeRecord`（`message-inbox.ts:253-286`）= `fs.open(tmp, 'wx', 0o600)` → `writeFile` → `handle.sync()`（fsync 文件）→ `fs.rename(tmp, final)` → 目录 `fsync`（best-effort）。失败清理 tmp。**是 tmp + fsync + rename 的真原子落盘**，0700 目录 / 0600 文件。
- **awaited**：`checkpoint()`（`message-inbox.ts:440-459`）内 `await this._writeRecord(record)`；`bridge.onTurnEvent`（`bridge.ts:271`）内 `await this.messageInbox.checkpoint(...)` 逐个 receipt；`session.ts:1286` 内 `await this.opts.onTurnEvent(...)`。三级全部 await → **`sent-unconfirmed` 落盘成功返回后，才可能到达 1290 的 send**。
- **失败即抛**：`checkpoint` 对未知 receipt / 非单调 / 校验失败直接 throw；`_writeRecord` 对 IO 失败 throw。session 侧该 `await` 抛错即跳出（在 `try` 内，被 :1386 catch 捕获），**prompt 绝不发出**。用例 7 钉死此点。

### 崩溃在每一步的可恢复性

| 崩溃点 | 落盘态（status/phase） | `recover()` 映射 | 是否重放 | 正确性 |
| --- | --- | --- | --- | --- |
| send 前、preparing 落盘前 | `queued`（`handleMessage:481`，session 循环尚未跑） | → pending | **重放** | ✅ 安全：prompt 未发出 |
| preparing 落盘后、sent-unconfirmed 落盘前 | `running` / `preparing` | → `queued` | **重放** | ✅ 安全：prompt 未发出（send 在 1290） |
| **sent-unconfirmed 落盘后、send 前** | `running` / `sent-unconfirmed` | → `uncertain` | **永不重放** | ✅ 过保守但诚实（send 可能没发出，但绝不双发） |
| send 发起后、result_ready 前 | `running`（或 `background`）/ `dispatched` | → `uncertain` | **永不重放** | ✅ 正确：prompt 可能已执行 |
| 已 journal `result_ready` | `running` / `result_ready` | → `reply_pending` | 不重跑，只补投 | ✅ 既有行为 |
| `checkpoint` 写失败 | 停在上一态（`dispatched` 或 `preparing`） | 视上一态 | — | ✅ 且 prompt 未发出 |

### 守恒性质证明

`recover()`（`message-inbox.ts:558-585`）只有在 `status ∈ {running,buffered,background}` 时才改状态；其映射为：
`phase==='result_ready' → reply_pending`；`phase==='preparing' && !usedTools → queued`；**其余（含 `sent-unconfirmed`/`dispatched`/`tool_activity`）→ uncertain**（`else` 分支）。
进入 `pending`（可重放）的三种来源：
1. `received` / `queued`：由 `handleMessage:481` 在 session 循环**之前**写入，此时 send 尚未发起；
2. `retry_wait`：只由 `scheduleRetry` 产生，而 `scheduleRetry` 的 `safe` 判定是 `!execution || phase==='preparing'`（即**仅 preparing 可安全重派**）；
3. `recover` 自身把 `running`+`preparing`+`!usedTools` 映射出的 `queued`。

因此 **任何会被判定为 queued/retry_wait（可重放）的持久状态，其 phase 只可能是 `preparing`（且未记录工具活动）或尚无 execution**——而在这两种状态下，本轮 send 一定尚未发起（send 在 1290，晚于所有写盘）。反之，凡"prompt 可能已发出"的持久态（`sent-unconfirmed`/`dispatched`/`tool_activity`）一律映射到 `uncertain`，永不进 queued/retry_wait。**守恒性质成立**（正交的 fallback 重入除外，见下）。

### 本批到底补了什么（"窗口不在"的精确含义）

- p3-readiness ② 描述的窗口是"prompt 实际发出但 dispatched 检查点未写 → 重启后 phase 仍 preparing 被当 queued 重派"。**对现网当前代码，这条在主路径上已不成立**：`dispatched` 检查点本就 `await` 于 send 之前（第 47 行已自述"dispatched 检查点前移到 prompt 发出前已部分覆盖"）。逐行核对（上表）确认：不存在"send 已发出而 phase 仍 preparing"的可达状态。
- 真正的问题是**语义脆弱**：安全性此前挂在 `dispatched` 这个"UI/追踪"事件上，而 `dispatched` 语义上表示"已派发"、实际却写在 send **之前**。B02 把它收敛为：新增具名、唯一承重的 `sent-unconfirmed`（语义 = "发送即将发起/在途、完成未知"），recover 对其 → `uncertain`，`scheduleRetry` 视其不安全；`dispatched` 保留（UI/追踪），其持久化**不再是安全关键路径**。于是安全性质与 UI 事件解耦，且首次获得专门的崩溃矩阵 + 逆向变异证据。

### 正交残余窗口（如实列出，不在本批范围）

**GrantDeadlineError → fallback 重入会经 `beginAttempt` 把 phase 重置回 `preparing`。** `session.ts` 的 Grant 期限路径会 `enqueue` 同 receipt 的 fallback 重试；新一轮 `onTurnEvent(preparing)` 在桥侧以 `beginAttempt=true` 调 `checkpoint`，而 `checkpoint` 的 `beginAttempt` 分支**强制** `phase:'preparing'`（`message-inbox.ts:451`）。此时该 receipt 的**原始** prompt 确已发出（它正是撞上 grant deadline 的那次）。若进程在 fallback 的 `sent-unconfirmed` 落盘前崩溃，recover 会把它当 `preparing` → `queued` 重放（经主 Agent）。这与本批修的"发送前标记"是**两条不同的窗口**：该路径由既有 `!session.client.hasUsedTools && !hasProducedMessage` 守卫兜底（"无工具活动才允许 fallback 重跑"），本批未改 `beginAttempt` 语义，**不单独关闭此窗口**，提请审计方裁决是否另立批次。

## 设计合同逐条

### (1) `message-inbox.ts`：新增 `sent-unconfirmed` 中间态
- `ExecutionCheckpoint.phase` 联合类型加 `'sent-unconfirmed'`（含契约注释）；`_validateRecord` 的合法 phase 数组同步加该值（否则新态落盘后会被判"corrupt execution checkpoint"）。
- **recover 映射**：`sent-unconfirmed` 落入 `else` 分支 → `uncertain`（`message-inbox.ts:569-573`），永不 queued/重放。合同要求的正是此点，且新增注释显式声明不变量。
- **scheduleRetry safe 判定**：`safe = !execution || phase==='preparing'`——`sent-unconfirmed` 非 preparing → 不安全 → 直接 `return false`，不写盘、不改状态（`message-inbox.ts:468-479`）。合同"仅 preparing 可安全重派"逐字满足。

### (2) `session.ts`：序列调整
- `SessionManagerOpts.onTurnEvent` 事件联合加 `'sent-unconfirmed'`。
- 主循环在 `connection.prompt(...)`（1290）之前新增 `await onTurnEvent(..., { phase:'sent-unconfirmed', sessionId, processId })`（**1286**）；**正常路径 phase 顺序 = `preparing → sent-unconfirmed → dispatched → result_ready`**，与合同给定的用例顺序一致。
- 语义落地：`sent-unconfirmed` 落盘后、send 前崩溃 → recover 转 `uncertain`；checkpoint 写失败 → `await` 抛错 → prompt 绝不发出。**未拆** ACP `connection.prompt` 的单 promise 调用（无客户端 hook），以"前置持久标记"达成等价守恒。

### (3) `bridge.ts`：接线
- `onTurnEvent` 内 `checkpoint` 的 phase 断言联合加 `'sent-unconfirmed'`（仅类型收敛；`event.phase === 'preparing'` 为 false，故新态走非 `beginAttempt` 合并分支，只更新 phase，不动 status/attempt）。除该行外 `bridge.ts` 一行未动（UI/追踪、recovery sweep、`/消息` 渲染均未改）。

### (4) 测试：见"崩溃矩阵"与"验证"

### (5) 交接包：本文件。

## 崩溃矩阵原始结果

新建 `vendor/wechat-acp/tests/dispatch-window.test.ts`（7 用例，tmp 合成夹具 + 注入内存 manager，`DEAD_PID=999999` 模拟进程已死）：

| # | 用例 | 崩溃/注入点 | 断言 | 结果 |
| --- | --- | --- | --- | --- |
| 1 | `recover maps a sent-unconfirmed receipt to uncertain and scheduleRetry refuses it` | inbox 级：seed running + `sent-unconfirmed` | `scheduleRetry→false` 且状态不变；`recover.pending=0`、`uncertainCount=1`、落盘 `uncertain` | ✅ |
| 2 | `a receipt still in preparing is the only crash state that recovers as replayable` | inbox 级：seed `preparing`(beginAttempt) | `recover.pending=[id]`、`uncertainCount=0` | ✅ |
| 3 | `crash while still preparing: re-admitted exactly once (safe replay)` | 桥级：seed `preparing` + 死 pid，跑 `recoverIncoming` | status→`queued`、`manager.calls.length=1` | ✅ |
| 4 | `crash after sent-unconfirmed but before the send: uncertain, never replayed` | 桥级：seed `sent-unconfirmed` + 死 pid，`recoverIncoming`+`runRecoverySweep` | `uncertain`、`manager.calls.length=0`、durable needs-review notice、fresh reader 亦见 `uncertain` | ✅ |
| 5 | `crash after the send was issued: dispatched journals uncertain, never replayed` | 桥级：seed `dispatched` + 死 pid | `uncertain`、`manager.calls.length=0` | ✅ |
| 6 | `the normal turn journals preparing -> sent-unconfirmed -> dispatched -> result_ready` | session 级：fake ACP `prompt` 立即返回，捕获 `onTurnEvent` phase | `deepEqual(events, ['preparing','sent-unconfirmed','dispatched','result_ready'])` | ✅ |
| 7 | `a failed pre-send checkpoint never issues the prompt and reports the error truthfully` | session 级：`onTurnEvent` 在 `sent-unconfirmed` 抛错 | ACP `prompt` 调用次数 **0**；phase 停在 `['preparing','sent-unconfirmed']`；completion reject 含原始错误；`onReply` 收到 `⚠️ Agent error` | ✅ |

**单文件原始结果**：`node --import tsx/esm --test tests/dispatch-window.test.ts` → **tests 7 / pass 7 / fail 0 / skipped 0**。

## 关键 diff 摘要

1. `vendor/wechat-acp/src/storage/message-inbox.ts`
   - `ExecutionCheckpoint.phase`：`'preparing' | 'dispatched' | ...` → 加 `'sent-unconfirmed'`（+ 7 行契约注释）。
   - `_validateRecord` 合法 phase 数组同步加 `'sent-unconfirmed'`（同行，净 0 行差异）。
   - `recover()`：加 4 行注释显式声明"仅 preparing 可回 queued"不变量（逻辑未动；`sent-unconfirmed` 本就走 `else → uncertain`）。
   - `scheduleRetry()`：把 1 行 JSDoc 扩为 5 行，显式声明 `sent-unconfirmed/dispatched/tool_activity` 均不安全（`safe` 逻辑未动）。
2. `vendor/wechat-acp/src/acp/session.ts`
   - `onTurnEvent` 事件联合加 `'sent-unconfirmed'`。
   - 主循环 1282 后插入 3 行注释 + 1 行 `await onTurnEvent(sent-unconfirmed)`，位置在 `dispatched` 检查点之前、`connection.prompt` 之前。**其它一律未动**（GrantDeadline、fallback、background、result_ready 路径逐字未改）。
3. `vendor/wechat-acp/src/bridge.ts`
   - `onTurnEvent` 内 `checkpoint` 的 phase 断言联合加 `'sent-unconfirmed'`（1 行）。行尾注意：该文件本就是混合行尾（CRLF+LF），本批改动行均为既有 LF 行，未整文件改写行尾（用 `sed | od -c` 核对过 1276/1282/1283/1284 与 bridge 271 均为 LF）。
4. 测试：新增 `tests/dispatch-window.test.ts`（7 用例，336 行）。

## 反向变异（承重证明）

对源码做**临时**变异（先 `cp` 到 `/tmp/*.bak` 作字节级备份，改后从备份还原并核对 SHA256 逐字一致——**未使用 git 变更命令**），每次只跑 `tests/dispatch-window.test.ts`：

| 变体 | 变异 | 结果（同文件 7 用例） | 精确失败用例 |
| --- | --- | --- | --- |
| original（本轮源码） | 无 | **7 pass / 0 fail** | — |
| mutant-A（去掉前置写入） | 删 `session.ts` 的 `await onTurnEvent(sent-unconfirmed)` 行 | **5 pass / 2 fail** | #6 顺序、#7 写失败（session 级两条） |
| mutant-B（recover 误映射） | `recover` 把 `sent-unconfirmed` 也并入 `queued` 条件 | **5 pass / 2 fail** | #1 inbox 级、#4 桥级（两条 sent-unconfirmed recover 用例） |
| mutant-C（retry 误放行） | `scheduleRetry` 的 `safe` 额外放行 `sent-unconfirmed` | **6 pass / 1 fail** | #1（scheduleRetry 断言） |

结论：三条承重点（发送前置写入 / recover 映射 / retry safe 判定）各有**精确**用例承重；误删或误放宽都会精确失败对应用例。还原后三文件 SHA256 与备份逐字一致（`20e2a870…00be` / `f226843e…859a` / `4f413623…1f2b`），全仓无 `MUTANT` 残留（`grep -rn MUTANT src` 零命中）。

## 验证

| 要求/Case | 实现 | 验证命令与 cwd | 结果 |
| --- | --- | --- | --- |
| 崩溃矩阵（7 用例） | 见上 | `node --import tsx/esm --test tests/dispatch-window.test.ts`（vendor） | ✅ 7/7，exit 0 |
| vendor 整包零回归 | — | `node --import tsx/esm --test 'tests/**/*.ts'`（vendor） | ✅ **tests 373 / pass 372 / fail 0 / skipped 1**（改前 366；+7） |
| vendor 类型构建 | `tsc` strict | `npm --prefix vendor/wechat-acp run build`（仓库根） | ✅ exit 0 |
| 仓库运行时策略门（含 vendor build） | — | `npm run test:runtime-policy`（仓库根） | ✅ **39/39**，exit 0 |
| 机密扫描 | — | `npm run audit:secrets`（仓库根） | ✅ `PASS: 0 undispositioned credential-shaped hits`，exit 0 |
| 逆向变异承重 | mutant A/B/C | 见"反向变异" | ✅ 对应用例精确失败 |

- 真实模型/原文外呼/生产读写/launchd/微信收发/真实外发：**均未发生**。全部为 tmp 合成夹具 + 内存注入（fake ACP session、假 manager）；未 chmod 任何真实用户文件。
- 失败、部分结果和不明副作用：无。sourceRef 复核：仅上列 4 文件按授权变更；变异实验已还原并校验 SHA256。
- 活动进程/job/handle：测试用 `t.after`/`finally` 统一 `stop()` 并 `fs.rm` 临时目录，无遗留定时器。`/tmp/session.ts.bak` 等为一次性还原备份，位于仓库外。
- 状态分列：实现完成 ✅（本批范围）；自测通过 ✅；独立审计：⏳ 待审计 AI；部署/真机：**未做**（生产服务仍跑旧代码）。

## 要求审计方做什么

- 按崩溃点②复核本批 diff / 新 hash / 崩溃矩阵与逆向变异结果。重点：① 逐行复核"残余窗口分析"中 send 点（`session.ts:1290`）与三处落盘（1276 / 1286 / 1287）的先后，确认"send 已发出而 phase 仍 preparing"在现网代码不可达；② 确认 `recover` 对 `sent-unconfirmed` 走 `else → uncertain`（未被其它分支截获）且 `scheduleRetry` 只放行 `preparing`；③ 确认 `checkpoint` 写失败会抛错且 session 侧该 `await` 在 `try` 内、send 不会发生；④ 裁决"正交残余窗口：fallback 重入经 `beginAttempt` 重置 phase"是否需另立批次。
- 非返工前请确认：本包未触碰 `package.json`、`docs/audits/**`、`docs/plans/**`；`bridge.ts` 除 1 行类型断言外未动。
- 等待期间继续的无冲突独立任务：B02 其余已完成项（六类 `/消息`、Submission 登记、前后台分离等）的审计；本批为 B02 最后一项。

## 未覆盖项与诚实边界声明

- **真实微信/真实 Agent 抽验属 Markus/B02 验收**：本批只改代码 + 合成测试，**未**接真实微信、**未**起真实 Agent 进程、未发真实消息。崩溃矩阵用"种子持久态 + 假 manager/fake ACP"模拟，**未**在真机做真实 kill -9 抽验。
- **生产未重启/未部署**：已在跑的服务仍执行旧代码；本轮为源码 + 合成测试，生产重启/部署另批，本包 READY 不授予该权限。**B02 不由此单独关闭**——需审计通过 + Markus 真机重启抽验。
- **正交残余窗口（fallback 重入）未关闭**：见"残余窗口分析"末节。`beginAttempt` 仍会把 phase 重置为 `preparing`；该守卫依赖既有 `hasUsedTools/hasProducedMessage`，本批未改，提请单列。
- **`dispatched` 语义仍"名不副实"**：其持久化仍写在 send 之前（本批未移动它，避免噪声 diff 与对既有 UI/追踪语义的连带影响）；但安全性已不依赖它（改由 `sent-unconfirmed` 承重）。若审计要求把 `dispatched` 语义改为"发送后"，请单列。
- **行尾**：`session.ts`/`bridge.ts` 为既有混合行尾，本批插入/改动行为 LF，未整文件归一化——如后续有行尾统一策略，请单列，不在本批范围。
- **诚实披露 git 使用**：开工首次探图时执行过两条**只读** `git status --short` / `git branch --show-current`；**未执行任何 git 变更命令**。若"零 git 命令"为硬性要求，此处不达标，特此声明。
- 未执行真实外呼/生产读写/launchd/微信外发/服务重启/任何 git 变更；未改 `package.json`、`docs/audits/**`、`docs/plans/**`。
