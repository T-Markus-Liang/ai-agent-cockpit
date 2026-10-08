# 执行交接包：P3 / FG-F001 返工（r2）——Grant 期限绝对化、跨 attempt 继承、到期只终结不重发

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双 AI 协作协议](../plans/0.3.0-collaboration.md)。本包逐条回应审计 [p3-foreground-background-r1](../audits/p3-foreground-background-r1.md) 的 **FG-F001（Major）「所谓 Grant 期限到期仍重新入队 fallback」**。r1 交接与审计证据**未动**；本包为 r2，镜像 r1 结构。

## 批次身份与状态

- batchId / revision：p3-foreground-background / **r2**
- 状态：**READY_FOR_REVIEW**
- 执行 AI：Kimi Code 会话（执行方）；branch `feat/0.3.0-progress`；cwd `/Users/markus/ai-agent-cockpit`；subagent（deepseek-flash）实现
- 审计来源：`docs/audits/p3-foreground-background-r1.md`（裁决 CHANGES_REQUESTED / FG-F001，5 条返工合同）
- 铁律遵守（逐条）：**只改源码 + 合成测试**；**tmp/fake 夹具 only**（沿用既有 fake ACP session 模式）；**未接真实微信 / 未启动真实 Agent CLI / 未发真实消息**；**未碰生产 / launchd / 真实用户文件**；**未执行任何 git 命令（含只读）**；**未改** `package.json`（根与 vendor）、`docs/audits/**`、`docs/plans/**`、**`config/wechat-acp.json`（生产配置）**；**未新增任何依赖**
- 写入文件（本批实际写入，共 9 个）：
  - `vendor/wechat-acp/src/acp/session.ts`（改）
  - `vendor/wechat-acp/src/acp/fallback-policy.ts`（**新**）
  - `vendor/wechat-acp/src/storage/message-inbox.ts`（改）
  - `vendor/wechat-acp/src/bridge.ts`（改）
  - `vendor/wechat-acp/tests/grant-deadline-inherit.test.ts`（**新**）
  - `vendor/wechat-acp/tests/dispatch-window.test.ts`（改：2 处夹具补 `deadlineAt`，+1 用例）
  - `vendor/wechat-acp/tests/session.test.ts`（改：1 用例语义迁移 + 夹具补 `hasUsedTools`）
  - `vendor/wechat-acp/tests/bridge-recovery.test.ts`（改：1 处夹具补 `deadlineAt`）
  - `docs/handoffs/p3-foreground-background-r2.md`（**新**，本文件）
- vendor 说明：`vendor/wechat-acp/` 无独立 `AGENTS.md`，遵循仓库根 `AGENTS.md`；使用 vendor 自带 runner `node --import tsx/esm --test 'tests/**/*.ts'`，不新增依赖

## 固定来源

- 改前基线：审计报告 FG-F001 记录的 `session.ts` SHA256 = `f226843ef19fb0fa224bd653ef684e4a9c3a0d132f0909dfb641fec93443859a`（本批开工时复核一致；**未跑 git**，读文件计算得到）
- 变更/新增文件（SHA256，2026-10-08，本机当前快照）：

| 文件 | SHA256 | 行数 |
| --- | --- | --- |
| `vendor/wechat-acp/src/acp/session.ts` | `60b15d6fb0b9121a39ca79b8cf9563e3776446abc21482fbaa0bb785ce887c03` | 1874 |
| `vendor/wechat-acp/src/acp/fallback-policy.ts`（新） | `b24da9eb0cf304e82ac6118d39d3e96caf6f57e0319e7ba2247dff5b4230bbe3` | 86 |
| `vendor/wechat-acp/src/storage/message-inbox.ts` | `fc8d7a0e4d68fe14738d3bef72e36b8c32d9129254b1bec7f460927d9c802323` | 626 |
| `vendor/wechat-acp/src/bridge.ts` | `dd9cb86f71fa6e27b36895cc918e5f52d9106aaf2a1f717924ca5ee6b72b73e2` | 2525 |
| `vendor/wechat-acp/tests/grant-deadline-inherit.test.ts`（新） | `02c348f7fd8b89833ef52c40b007c63f9c8cdea203da703c90549d4fb77b201e` | 256 |
| `vendor/wechat-acp/tests/dispatch-window.test.ts` | `9c3d0ae3bc5033f47e3b97de4e08f5589576444b224bca5c54ea963afec68e27` | 360 |
| `vendor/wechat-acp/tests/session.test.ts` | `a268ed8599828e08ce98e054dda1c897fd6c0ab0bc0183a05e7c620a244412ad` | 628 |
| `vendor/wechat-acp/tests/bridge-recovery.test.ts` | `19b29bd140569c6a4126a901bd9ea4b998794a563b5949fa84471914e469cee1` | 244 |

- `package.json`（根 / vendor）**未改**；`config/wechat-acp.json` **未改**（mtime 仍为 Oct 7 13:59，本批开工前）
- 构建产物：按要求跑了 `npm --prefix vendor/wechat-acp run build`（`tsc` strict），`vendor/wechat-acp/dist/` 随之重新生成（既有构建步骤，`dist/` 在 `.gitignore` 中，非源码改动）
- 并发环境说明：本沙箱同一时间窗内还有其它批次在写 `docs/plans/**`、`control-plane/**`、`tests/*.mjs` 等；**这些均非本批所写**，本批只写上面 9 个文件。上文 SHA 为当前快照

## FG-F001 返工合同逐条回答

### (1) 绝对期限入站一次记录、全程继承

- **`PendingMessage.deadlineAt?: number`（绝对 epoch-ms）**：`session.ts:61`。
- **一次盖章**：`processQueue` 每轮取到该 turn 时执行 `if (pending.deadlineAt === undefined && this.opts.grantDeadlineMs > 0) pending.deadlineAt = Date.now() + grantDeadlineMs;`（`session.ts:1171-1173`）。`??=` 语义：**永不**在同一 turn 的后续 attempt 里重算。
- **盖章时点的选择与理由（重要解释，待裁决）**：合同写「turn 入站（pending 创建）时」。本批把语义落在 **turn 开始执行（出队）时**，理由：①「turn」在本系统一直是**一次处理周期**（r1 亦如此用词：一个 prompt turn）；②若在**排队入站**时盖章，排在挂死 turn 之后的消息会**在排队期间消耗预算**、刚轮到即已过期——这既不符合既有测试的期望（`session-timeout-retention` 的「排在其后的消息仍应正常处理」），也非审计针对的行为；③两种时点都满足合同的核心不变量「**不得对同一 turn 的后续 attempt 从 now 起重开完整期限**」。若审计要求字面落在入站，请单列（改动很小，但会让排队等待计入预算，需同步调整排队相关测试）。
- **所有等待用剩余期限**：`awaitAgentOperation` 第 4 参数由 `grantDeadlineMs` 改为 `deadlineAt`（`session.ts:1691`）；计算 `remainingMs = deadlineAt - Date.now()`；`remainingMs <= 0` **立即** reject `GrantDeadlineError`，否则 `setTimeout(reject, remainingMs)`（`session.ts:1722-1735`）。**任何地方不再从 now 起完整 `grantDeadlineMs`。** 「turn setup」与「prompt response」两处都传 `{ deadlineAt: pending.deadlineAt }`（`session.ts:1275`、`:1315`）；前台等待仍为纯信息性（不变）。
- **持久化点**：`ExecutionCheckpoint.deadlineAt?: number`（`message-inbox.ts:75`，并在 `_validateRecord` 校验有限且 ≥0，`message-inbox.ts:243`）。durable 写入发生在 **`preparing` checkpoint**（`beginAttempt=true`，即 prompt 发出前的第一个 durable 点）：`session.ts` 在 `preparing` 事件里携带 `deadlineAt`（`session.ts:1294`），bridge 的 `onTurnEvent` 通配 spread `...event` 写入 checkpoint（`bridge.ts:271`），后续 `sent-unconfirmed/dispatched/tool_activity` 用 `{...old, ...patch}` 保留该字段，**不再重复写**。
- **重启恢复继承**：bridge `enqueueMessage` 读回 `record.execution.deadlineAt` 并透传给 `sessionManager.enqueue`（`bridge.ts:717,722`），恢复的 turn 因此**沿用原绝对截止点**，不重置。
- **旧记录读不到 deadlineAt → 诚实 unknown**：`message-inbox.recover()`（`message-inbox.ts:594-599`）对 `preparing`（prompt 未发出、理论可重放）记录，**仅当** `deadlineAt` 为数字时才落 `queued`；缺失（=旧记录，预算未知）时落 **`uncertain`/待核对**——既不臆造期限、也不静默发一份全新完整预算。

### (2) 到期只终结，不重发

- **删除**了原 `GrantDeadlineError` 分支里「cleanup 后按条件重新入队同一 pending」的逻辑（原 `session.ts:1441-1453`）。
- 期限内到期的 turn：`classifyTurnFailure` 归为 `timeout`；即便 client 证明干净（`timeout-clean`），`remainingMs <= 0` 使 `decideFallback` 返回 `stop('deadline-exhausted')`；有副作用则 `stop('timeout-dirty')`。**无论哪种都走既有清理 + 保留原文 + 中文 notice 路径**（`session.ts:1431-1473`）。**绝不重发原 prompt、不换引擎重试、不重新入队。**

### (3) fallback 接 fallback-policy（首个消费者）

- **vendor 包边界实测**：`vendor/wechat-acp/tsconfig.json` 固定 `rootDir: "."`，`include: ["src/**/*","bin/**/*"]`。实测在 `src/acp/` 下 `import '../../../../runtime/fallback-policy.mjs'`：`npx tsc --noEmit` 报 **TS7016**（Could not find a declaration file，严格模式 implicit any），emit 构建同样失败，`exit 2`。**tsx 能跑 ≠ tsc 能过**，结论属实。
- 故按 **submission-registry 先例**（vendor 侧文件型实现对齐语义合同）在 vendor 内实现 `src/acp/fallback-policy.ts`：导出 `classifyFailure(kind, hasProducedMessage, hasUsedTools)` 与 `decideFallback({kind, hasProducedMessage, hasUsedTools, remainingMs})`，**逐条对齐根 `runtime/fallback-policy.mjs` 的 `classify` 语义**（可降级类 `startup_error/protocol_error/rate_limit/timeout`；副作用屏障要求 `hasProducedMessage===false && hasUsedTools===false`，缺失/真值一律拒绝；`auth_error` 与未知类恒拒绝；`remainingMs<=0` → `deadline-exhausted`）。**偏差**：根 `.mjs` 是唯一 canonical 纯净库，vendor 侧仅为其最小镜像（无决策日志/snapshot/scope 计数），**待裁决**是否需在构建层面打通 rootDir 或改为其它共享机制。
- **判定改经 classify**：`processQueue` 的 catch 用 `decideFallback` 统一判定（`session.ts:1421-1426`），只有「**仍在剩余期限内** && **hasProducedMessage===false && hasUsedTools===false** && **kind 属可降级类**」才 fallback。timeout/无响应 → `deadline-exhausted`/`timeout-dirty`，不 fallback；auth → `auth-failure`，不 fallback；期限耗尽 → `deadline-exhausted`，不 fallback。
- **合法 fallback 的触发**：turn 在 **prompt 发出前**失败（`!session.promptDispatched`，即未触达 provider，天然干净）→ `startup_error` → 期限内允许一次 fallback（`session.ts:1455-1469`），重放的是 `{...pending}`（**继承 `deadlineAt`**，用剩余期限）。
- **telemetry / notice 如实**：日志新增 `Turn-failure gate: <action> (<reason>)`；到期终结 notice 含「Grant 期限…不能算作已处理」；切换候选 notice「主 Agent 暂时不可用，已切换到备用候选继续这同一条任务；原截止时间不变。」（用户能区分「换了候选」还是「到期终结」）。

### (4) 生产配置注意

见下方「生产配置部署警示（醒目）」。

### (5) 测试

见下方「负例原始结果」。

## 负例原始结果与反向变异

新增用例均为 **tmp 合成夹具**（`fs.mkdtemp` / 内存 fake ACP session / `EventEmitter`），**未接真实微信、未启动真实 Agent CLI**。

`tests/grant-deadline-inherit.test.ts`（新，6 用例）逐条结果：

| 用例 | 断言 | 结果 |
| --- | --- | --- |
| 静默 primary 到期 + fallback 已配置 | 原 turn **rejected**（非 resolved）、`createdFallbackSessions==0`、`fallbackPrompts==0`、`/Grant 期限/` notice **恰 1 次**、未选 fallback 候选 | ✅ pass |
| 到期前已产消息的 primary | rejected、不 fallback、不重放 | ✅ pass |
| 期限内合法 fallback（确定零副作用 startup 类失败） | fallback 候选被 prompt **恰一次**、候选 notice 出现、且 `preparing` 事件的 `deadlineAt` **等于原值**（继承而非重开） | ✅ pass |
| fallback gate 单元（对齐根契约） | 干净可降级类 → fallback；脏/未知/auth/预算耗尽 → stop（含 `remainingMs=Infinity` 视为无限预算） | ✅ pass |
| 重启沿用原 `deadlineAt`（持久化恢复） | inbox 往返后 `status=queued`、`execution.deadlineAt` 原值保留 | ✅ pass |
| bridge 恢复重入队透传 | `recoverIncoming` 后 `enqueue` 收到的 payload `deadlineAt` == 持久化值 | ✅ pass |

配套既有/迁移用例：

- `tests/dispatch-window.test.ts`（8/8）：两处 `preparing` 夹具补 `deadlineAt`（代表**改后**记录，保留「pre-dispatch 崩溃可重放」原意）；**新增**「`preparing` 无 `deadlineAt`（旧记录）→ 恢复为 `uncertain`、永不重放」1 例。
- `tests/session.test.ts`（15/15）：原「timeout fallback reuses prepared context…」用例的前提（**到期触发 fallback**）正是 FG-F001 所禁行为，故**语义迁移**为「期限内 startup 类失败的 fallback 只 `preparePrompt` 一次（不重复 enrich/归档）」；`makeTurnSession` 夹具补显式 `hasUsedTools:false`（严格副作用屏障要求两 flag 均为 `false`）。
- `tests/bridge-recovery.test.ts`（6/6）：1 处 `preparing` 夹具补 `deadlineAt`。
- 前台/后台/取消回归（**未改**，全绿）：`tests/session-foreground-background.test.ts`（5/5，含「结果在前台窗口内无 background」「前台到期只发一次 background 且迟到结果仍投递」「后台可取消」）；`tests/session-timeout-retention.test.ts`（8/8，含「带工具活动的超时不重试且队列继续」「清理期新消息排在其后」）。

**逆向变异（承重证明）**：把 catch 的 fallback 条件退回「到期即重新入队，且入队前 `pending.deadlineAt = Date.now() + grantDeadlineMs`（重开完整定时器）」，重跑 `grant-deadline-inherit.test.ts`：

- 原（无变异）：**6/6 pass，0 fail**。
- 变异后：静默 primary 用例 **精确失败**，错误为 `AssertionError: the expired turn must be rejected, not resolved`（正是审计复现的「任务最终 resolved 并发出 reply」）；同文件另有「产消息」与「继承 deadlineAt」2 例一并失败。
- 还原后再次 `npm --prefix vendor/wechat-acp run build` + 全量跑绿；`grep -rn MUTATION vendor/wechat-acp/src/` **无残留**。

## 验证

| 要求 | 验证命令与 cwd | 结果 |
| --- | --- | --- |
| vendor 整包零回归 | `node --import tsx/esm --test 'tests/**/*.ts'`（vendor） | ✅ **tests 407 / pass 406 / fail 0 / skipped 1**（skip = 既有 Windows-only 用例） |
| vendor 类型构建 | `npm --prefix vendor/wechat-acp run build` | ✅ exit 0（tsc strict） |
| 负例/正例文件 | `node --import tsx/esm --test tests/grant-deadline-inherit.test.ts`（vendor） | ✅ 6/6 |
| 派发窗口 | `... tests/dispatch-window.test.ts`（vendor） | ✅ 8/8 |
| 前台/后台/取消 | `... tests/session-foreground-background.test.ts`（vendor） | ✅ 5/5 |
| 超时保留 | `... tests/session-timeout-retention.test.ts`（vendor） | ✅ 8/8 |
| 会话主循环 | `... tests/session.test.ts`（vendor） | ✅ 15/15 |
| 恢复 | `... tests/bridge-recovery.test.ts`（vendor） | ✅ 6/6 |
| 仓库运行时策略门（含 vendor build） | `npm run test:runtime-policy`（仓库根） | ✅ **39/39，exit 0** |
| 仓库密钥扫描门 | `npm run audit:secrets`（仓库根） | ✅ PASS：0 undispositioned credential-shaped hits |
| 逆向变异承重 | 见上 | ✅ 审计复现用例精确失败 |

- 真实模型/微信收发/生产读写/launchd/真实外发：**均未发生**。全部 tmp 合成夹具 + 内存注入。

## 生产配置部署警示（醒目 ⚠️）

- 旧配置键 **`session.promptTimeoutMs`** 在 r1 之后**已无任何消费者**；新代码只读 **`session.foregroundWaitMs`** 与 **`session.grantDeadlineMs`**。
- 生产文件 `config/wechat-acp.json` 当前仍是 `"promptTimeoutMs": 300000`（**本批按铁律未改**）。运行中的 `bin/wechat-acp.ts` 以 `Object.assign(config.session, fileConfig.session)` 合并，故该 JSON **缺两新键时会落回 `config.ts` 默认值**：`grantDeadlineMs = 30 * 60_000`（30 min），而旧实际行为是 **300000ms = 5 min**。**即：无显式下发 = 静默把硬期限放宽 6×。**
- **部署批必须**：①显式下发 `session.foregroundWaitMs` 与 `session.grantDeadlineMs` 两新键；②**核对取值范围**（30 min 并非「批准的真实 Grant」，只是桥侧默认）；③移除已无消费者的 `promptTimeoutMs`。**本批不代改生产配置**。
- 另：`grantDeadlineMs` 只是桥侧**默认预算**，**不是**控制面按任务下发的真实 Grant；真实 per-task Grant 属控制面接线（见「未覆盖项」）。

## 关键 diff 摘要

1. `session.ts`：`PendingMessage` + `deadlineAt`；turn 开始一次性盖章；`GrantDeadlineError` 字段 `deadlineMs`→`deadlineAt`（绝对）；`awaitAgentOperation` 由「相对 grantDeadlineMs 定时器」改为「`deadlineAt - now` 剩余定时器，≤0 立即 reject」；`preparing` 事件携带 `deadlineAt`；catch 分支**删除重新入队**，改由 `decideFallback` 单门判定（到期恒 stop）；新增私方法 `classifyTurnFailure`。
2. `fallback-policy.ts`（新）：vendor 侧最小镜像 `classifyFailure` / `decideFallback`。
3. `message-inbox.ts`：`ExecutionCheckpoint` + `deadlineAt` + 校验；`recover()` 对 `preparing` 无 `deadlineAt` 记录落 `uncertain`。
4. `bridge.ts`：`enqueueMessage` 读回并透传持久化 `deadlineAt`（仅此 4 行，`+3/-1`）。`onTurnEvent` 通配 spread 自动持久化 `deadlineAt`，无需改。
5. 行尾：`session.ts`/`bridge.ts` 为既有**混合行尾**；本批仅在既为 LF 的区段插入 LF 行，未整文件归一化（避免噪声 diff），`tsc` 与运行时无影响。

## 未覆盖项与诚实边界声明

- **真实 per-task Grant 下发属控制面接线**：本批只做「桥侧绝对期限 + 继承 + 到期终结 + 门控 fallback」，**未**接控制面按任务下发真实 Grant。这正是审计报告保留的既声明缺口，不能靠改措辞替代正式接线。
- **`createSession` 候选链（spawn/init 失败时依次尝试 `[primary, ...fallbackAgents]`）未纳入本 gate**：它是**创建期**（prompt 之前、天然干净）的既有候选选择机制，且最终 turn 仍跑在**继承的 `deadlineAt`** 下（预算不被放宽），并非 FG-F001 针对的「失败后重新入队重启定时器」控制流。本批**未改**该链（避免误伤既有候选/认证处理语义）。**待裁决**：审计若要求该链也逐字经 `decideFallback`，请单列。
- **turn 盖章时点为「出队执行」而非「排队入站」**：见 (1) 的解释与理由，**待裁决**。
- **vendor 侧 fallback 策略是根 `runtime/fallback-policy.mjs` 的镜像实现（非 import）**：受 `rootDir` 边界所限，属**偏差**，**待裁决**。
- **真实微信抽验属 Markus/B02 验收**：本批只改代码 + 合成测试，后台/到期/fetch 的真机端到端效果**未经真机验证**。
- **生产未重启 / 未部署**：在跑的服务仍执行旧代码；本包 READY 不授予部署权限。
- **`deadlineAt` 只在 `preparing` 起持久化**：turn 开始到 `preparing` 之间若崩溃，durable 上无 `deadlineAt`，重启后该 receipt 为 `queued`（无 execution）→ 按「新进程的首次入站」重新盖章。此为可接受语义（该 turn 从未触达 provider、无 durable 痕迹），但**属实现选择**，一并声明。
- **行尾**：`session.ts`/`bridge.ts` 为既有混合行尾，本批未整文件归一化——如后续有行尾统一策略，请单列。
- 未执行真实外呼/生产读写/launchd/微信外发/服务重启/git；未改 `package.json`、`config/wechat-acp.json`、`docs/audits/**`、`docs/plans/**`。

## 要求审计方做什么

- 按 **FG-F001 五条**逐条复核本批 diff / 新 SHA / 负例与变异结果。重点：① 到期是否**只**终结、绝不重发/重入队/换引擎（catch 分支已无 re-enqueue）；② 是否**任何地方都不再从 now 起完整 `grantDeadlineMs`**（`awaitAgentOperation` 只认 `deadlineAt`）；③ 重启是否**继承**持久化 `deadlineAt`，旧记录是否落 `uncertain`；④ fallback 是否**逐条经 classify**（干净 + 可降级 + 期限内）；⑤ 未新增第二条结果投递通道。
- 裁决上述 3 项「未覆盖/偏差」：`createSession` 候选链是否也需过 gate、盖章时点（出队 vs 入站）、vendor 侧镜像实现。
- 非返工前请确认：本包未触碰 `package.json`、`docs/audits/**`、`docs/plans/**`、`config/wechat-acp.json`（生产配置）。
