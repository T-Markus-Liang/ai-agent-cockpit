# 执行交接包：M02/I03d runtime durable execution ownership（r1，全新合成切片）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包为 **r1**（首个 revision）。方向依据 [durable-ownership-proposal-r1 审计裁决](../audits/durable-ownership-proposal-r1.md)——审查**条件接受**「一个显式后台 execution 自持一条 durable conversation」作为关闭 V11/V12 的方向：可从**全新、无旧历史/生产效果**的隔离任务实施，先保留默认生产路由关闭，不触发实际 Agent/模型外呼。

## 批次身份与状态

- batchId / revision：m02-execution-ownership / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；branch `feat/0.3.0-progress`；cwd `/Users/markus/ai-agent-cockpit`；主 Agent 定稿设计合同，该会话 subagent（deepseek-flash）实现，主 Agent 复核
- 已读并确认协作协议：是。本批**允许写入且实际写入**：
  - `runtime/execution-ownership.mjs`（**新文件**）
  - `tests/execution-ownership.test.mjs`（**新文件**）
  - `docs/handoffs/m02-execution-ownership-r1.md`（**新文件**，即本包）
  - `package.json`（**仅新增一行** script：`"test:execution-ownership": "node --test tests/execution-ownership.test.mjs"`）
  - **未改** `docs/audits/**`、`docs/plans/**`、其他任何 `runtime/*` 模块、`control-plane/**`、`gateway/**`；未新建/覆盖任何证据或旧交接文件
- 对应：M02 / **I03d**（全新合成切片）；验收方向 V09–V13/16/18/31 的接口层（见「验收映射」）
- 本批目标：按已定稿设计合同实现 durable ownership 的**新合成核心**（复合键 / 单 in-flight Submission / 新任务分流 / 精确 scope 取消 / 崩溃恢复 / 并发 slot 与 fence）。**明确不做**：接生产 route、迁移旧 `stalled`、真实 SDK/模型/微信外呼、跨进程单 owner 实证、commit/push。

## 固定来源

- base HEAD：`c9e09b69d2ea11fdcd86f36df83b877f890e1d84`（branch `feat/0.3.0-progress`）。该值**读取自 `.git/HEAD` 文件**（`ref: refs/heads/feat/0.3.0-progress`）与 `.git/refs/heads/feat/0.3.0-progress`，**未执行任何 git 命令**。注意：本仓库工作区含历史共享的未提交内容，因此 HEAD 不等于「冻结基线」，仅作 sourceRef 锚点。
- 新建文件（SHA256，2026-10-08）：
  - `runtime/execution-ownership.mjs` = `1be2611cb6116b33ee5d5d37248fd43923b0add228ed96b179fceba67ac6f4ea`（967 行）
  - `tests/execution-ownership.test.mjs` = `fed166d4de7d5a46b14214cc7d8e64faeff45f2a2ea7bb435488cec61547a129`（607 行）
- 修改文件：
  - `package.json` = `1018caf317eb07bdac7aeb6a68d6d89c8385044246dd77b2f2a9f7f3024e1d24`（相对其上一版本的**唯一**变更为新增一行 script；其余 70 行零漂移）
- 语义参照（**只读未改**）：`runtime/budget-policy.mjs`（错误码精确区分 / fail-closed / 冻结记录风格）、`runtime/route-binding.mjs`（类型化键、幂等重放、快照重校验、`static fromJSON`）。
- 依赖：**无新依赖**；纯 ESM、零 import、注入时钟（默认 `Date.now`）、注入端口（`launcher` / `canceller`）。唯一 Node 内建用途是 `Buffer` 做 base64url 编解码（纯编解码，不读环境/文件/网络）。
- 自测前后 sourceRef 一致：是（仅上列文件被本批写入）。

## 设计合同逐条落实

### 1. 复合 ownership 键（审计条件 2）

- `ownershipKey({ channel, accountId, profileId, executionId, cycle })` → `own1.<channel>.<b64url(accountId)>.<b64url(profileId)>.<b64url(executionId)>.<cycle>`：channel 枚举 `fg|bg`；三个 id 为非空、well-formed 字符串；cycle 为非负安全整数；任一缺/错 → `invalid-key`，不产键。
- **防注入**：所有自由文本段经 base64url（字符集 `[A-Za-z0-9_-]`，不含 `.`），故 `.` 分隔符无法从 id 注入；`parseOwnershipKey` 按结构分割，段数必须恰为 6。
- `parseOwnershipKey` 为严格、规范化的反解：校验前缀、channel、cycle 段为**规范整数串**（拒 `00` / `-1` / 溢出 / 前导 `+`）、每段为**规范 base64url**（字符集 + 重编码比对，拒非规范尾比特/坏 UTF-8），并**重算 `ownershipKey` 与输入逐字节比对**，只接受唯一规范表示；外来/畸形键 → `invalid-key`。
- **前后台不碰撞**：同 account/profile/execution/cycle 下 `fg` 与 `bg` 得到**不同**键（首段 channel 区分）；不同 `cycle` 亦为不同键。宿主 Task/Execution/Grant 身份另由 `registerExecution({ goalId, taskId, grantRef })` 单独绑定。

### 2. ExecutionOwnership 注册表 + 单 in-flight Submission（审计条件 1）

- `registerExecution({ key, goalId, taskId, grantRef })`：绑定不可变；同键**同绑定**幂等返回原记录，**同键不同绑定** → `binding-conflict`（原绑定不动）。
- `beginSubmission(key, { submissionId, payloadDigest, intentId?, expectedFence? })`：该 execution 已有 in-flight → 拒 `submission-in-flight`（**同 execution 下新输入不得偷渡重放**）；`submissionId` 全注册表唯一（跨 execution 复用）→ 拒 `submission-exists`。
- `completeSubmission(key, submissionId, outcome='completed', { expectedFence? })` / `failSubmission(key, submissionId, outcome='failed', { expectedFence? })`：仅可转换**当前 in-flight 且 id 匹配**者；否则 `unknown-submission` / `submission-terminal`。
- Submission 状态机：`in-flight → completed | failed | cancelled | owner-lost | partial`，**终态不可变**（再转换 → `submission-terminal`）。**`partial` 是独立 outcome 值**，`status/outcome` 均为 `partial`，**绝不在 API 层被折叠成 `cancelled`**（亦不等于 `completed`）；测试显式断言三者互不相等。`failed` 的 outcome 另有更具体的 `launch-failed`（launch 故障留痕）。

### 3. 新任务分流（默认关闭 route，审计条件 6）

- 构造选项 `routes: { backgroundDispatch }` **默认 `false`**。
- `dispatchBackgroundTask({ key, intentId, payload, payloadDigest?, submissionId?, expectedFence? })`：
  - **route 关闭**：**先于任何校验/写入**短路，返回 `{ dispatched:false, reason:'route-disabled' }`，**零副作用**（无 slot、无 intent、无 submission；测试断言调用前后 `snapshot()` 逐字节相等，含对非法入参的静默短路）。
  - **route 开启**（原子序列）：预留 slot → 建**不可变** launch intent（`intentId/ownershipKey/payloadDigest/createdAt`，type=`LaunchIntent`）→ `beginSubmission` → 调注入端口 `launcher.launch(intent)`。`launcher` 抛错 → **补偿**（释放 slot、submission 置 `failed`+`outcome='launch-failed'`、intent 留痕 `status='launch-failed'`），**诚实返回** `{ dispatched:false, reason:'launch-failed', ... }`，**无 ghost 成功**。同 `intentId` 重放 → 返回原记录（**不重复 launch**）；同 `intentId` 但 key/payload 不一致 → `intent-conflict`。
  - payload 摘要：给定 `payloadDigest`（非空串）直接用；否则由 `payload` 经**确定性**指纹（规范化 JSON + FNV-1a 32，注明**非密码学哈希**）派生。原始 payload 不被本模块留存（只留摘要，避免无界状态）。

### 4. 精确 scope 取消（审计验收「单Submission/Execution/Goal各scope」）

- `cancel({ scope:'submission', key, submissionId })` / `{ scope:'execution', key }` / `{ scope:'goal', goalId }`。
- 经注入端口 `canceller.cancel(target)` 执行实际取消；**先调 canceller、成功后才迁移状态**。canceller 抛错 → 诚实报 `cancel-failed`，**不迁移、不递增 fence**（不假装已取消）。
- 终态目标诚实报 `already-terminal`（**不调 canceller、不递增 fence**）。goal scope 返回**逐 execution 结果数组**（含 `cancelled` / `already-terminal` / `cancel-failed` 混合）。
- **cancel 不删记录**：仅状态迁移 + fence `+1`（记录可审计）。

### 5. 崩溃恢复（审计条件 5，诚实、不自动驱动）

- `snapshot()` → 确定性、JSON 可序列化的普通对象；`ExecutionOwnership.fromJSON(snapshot, ports, options?)` 全量重校验重建（接受对象或 JSON 串）。
- 恢复时凡仍 `in-flight` 的 submission → **`owner-lost`**（owner 已死、**效果未知**），对应 intent（若 `launched`）→ `owner-lost`，**slot 释放**；**不自动重放、不自动继续**。恢复后要推进只能由宿主**显式开新 cycle 新 intent** 重新派单。
- **损坏快照拒绝**（`invalid-state`）：错 type/version、字段缺失/类型错、key 非规范、fence/submissionId 重复、status/outcome 不一致、intent 指向不存在的 execution/submission、`slotsInUse` 越界等。

### 6. 并发 slot（与预算分离，审计条件 3）

- 构造 `maxConcurrent`（默认 1）；宿主可传 `grantConcurrencyCap`，**若 `maxConcurrent > cap` 则拒绝启动**（`concurrency-cap`）——可配置并发**不得扩大已有许可**。
- slot acquire/release **显式**：`dispatchBackgroundTask` 先 `_assertSlotAvailable` 再占用；`complete` / `fail` / `cancel` / `owner-lost` **均释放**。只读观测 `slotsInUse` / `maxConcurrent` / `grantConcurrencyCap`。
- **与 `runtime/budget-policy.mjs` 零耦合**：budget 计**累计** tokens/calls/期限；slot 计**同时活跃** execution 数——不同关注点。本模块不 import budget-policy，不 settle/regrant 释放 slot，不把 `maxCalls` 当活跃数。

### 7. Pending 推进与 fence（审计条件 4）

- 每 execution 单调递增整数 fence；所有变更方法可选携带 `expectedFence`，**过期 → `stale-fence`**（拒绝且零移动）；`fence(key)` 只读。
- 本模块是**纯库**：**无 timer、无循环、无自动推进**——推进只能由宿主显式调用（**不叠第二 scheduler/registry**）。跨进程 fencing **未在本层实现**（属接线阶段，诚实声明见下）。

## 实现、自测与证据

| 合同点 / 测试 | 当前实现 | 验证命令与 cwd | 退出码 / 断言 | 尚未覆盖 |
| --- | --- | --- | --- | --- |
| 键派生/反解/碰撞/注入（测试 1–2） | `ownershipKey` / `parseOwnershipKey` | `npm run test:execution-ownership`，cwd 仓库根 | pass；含 11 类畸形键与 6 类非法入参全部 `invalid-key` | 键跨进程一致性命中 |
| 单 in-flight + 全局唯一 submissionId（测试 4–5） | `_openSubmission` / `_submissionIds` | 同上 | pass；第二个拒、完成后允许新、跨 execution 复用拒 | 真实排队语义（本层直接拒） |
| 终态机 + partial≠cancelled（测试 5） | `_finishSubmission` + `OUTCOMES_BY_STATUS` | 同上 | pass | 下游如何消费 `partial` 未接线 |
| route 默认关零副作用（测试 6） | `dispatchBackgroundTask` 短路 | 同上 | pass；`snapshot()` 前后逐字节相等 | 生产 route 开关未接 |
| route 开 happy / 补偿 / 幂等（测试 7–9） | 原子序列 + 补偿 + `_intents` 幂等 | 同上 | pass；`slot-exhausted` / `intent-conflict` 精确 | 与真实 launcher 的接线 |
| 三 scope 取消 + already-terminal（测试 10–11） | `cancel` + `_cancelSubmission` | 同上 | pass；含 `cancel-failed` 诚实分支、无 canceller 拒 | 与真实 canceller/产品调度的接线 |
| 崩溃恢复 owner-lost / slot 释放 / 不重放 / 新 cycle（测试 12–13） | `fromJSON` 恢复循环 | 同上 | pass；`launcher` 调用计数不增 | 跨进程 durable store 接线 |
| stale fence（测试 14） | `_assertFence` | 同上 | pass | 跨进程 fencing |
| slot 上限 / 释放路径 / cap 不得扩大（测试 15） | `_slotHolders` + 构造守卫 | 同上 | pass；`slot-exhausted` / `concurrency-cap` | 与预算层同时约束的联测 |
| 快照确定性 / 损坏拒绝（测试 16） | `snapshot` / `fromJSON` | 同上 | pass；14 类篡改全部 `invalid-state` | 真实持久化介质 |

**原始结果**：`tests 16 / pass 16 / fail 0`，exit 0（Node v24.15.0，`node --test tests/execution-ownership.test.mjs`）。

- 真实模型/原文外呼/生产 DB/服务/launchd/微信外发：**均未发生**。测试为纯模块合成夹具，时钟、`launcher`、`canceller` 全部测试内自建 fake；未 chmod、未修改任何真实用户文件、未触碰旧 `stalled`。
- 失败、部分结果和不明副作用：无。
- 活动进程/job/handle：无（纯同步模块，测试进程内完成）。
- 独立审计：⏳ 待审计 AI；部署/真机：未做。

## 验收映射（诚实标注本层覆盖度）

- **V09–V13 / 16 / 18 / 31** 的**接口层**已具备可测骨架：两种启动顺序（begin 后再 dispatch / dispatch 内 begin 的原子序列）、同 execution 重复不同 payload（`submission-in-flight` + `intent-conflict`）、多 execution 与多 scope 取消、无新用户消息推进（无 timer/自动推进）、owner 死/恢复（owner-lost、不重放、新 cycle）、完成效果不增加（终态不可变、cancel 不删记录）。
- **未关闭**：上述 V 的**端到端**断言需要与产品调度、真实 Task/Grant、持久状态、SDK 实体的**接线**；本层是纯模块，**不能单独宣告 V 通过**。

## 要求审计方做什么

- 按设计合同 7 点逐条复核 `runtime/execution-ownership.mjs` 与 16 条测试；重点风险：
  1. **单 in-flight 的强度**：是否确无路径可在同 execution 下并存两个 in-flight（含 dispatch 与 `beginSubmission` 混用、`expectedFence` 缺省路径）；
  2. **route 关闭的零副作用**是否彻底（是否可能在短路前读时钟/写状态——当前实现先判 route 再读 clock）；
  3. **补偿原子性**：`launcher` 抛错后的残留（intent 留痕 `launch-failed`、submission `failed`、slot 释放）是否自洽、无 ghost；
  4. **`partial` 不被折叠**的语义与快照校验是否一致；
  5. **`concurrency-cap` 语义**：只做「不得扩大」，`maxConcurrent <= cap` 放行是否接受；
  6. **恢复语义**：in-flight → owner-lost 是否足够诚实（本层不猜测效果、不重放）。
- 已知需裁决/延续项：
  - `expectedFence` 在合同第 7 点要求「所有状态迁移携带」，但合同第 2/4 点的 API 签名未列出该参数——本层实现为**可选**（提供即强制、缺省不校验），请裁决是否应改为**必填**；
  - goal-scope `cancel`：`expectedFence` 语义不明（跨多 execution 无单一 fence），本层**显式拒绝**在 goal scope 传 `expectedFence`（`invalid-argument`），请确认；
  - 额外错误码 `cancel-failed`（canceller 故障诚实上报）为本层新增，请裁决命名/语义。
- 非返工前请确认：本包**未接生产 route、未迁移旧 stalled、未外呼**；V11/V12 的关闭仍需接线切片。

## 未覆盖项与诚实边界声明

- **不接真实 SDK**：`launcher` / `canceller` 为注入端口，测试中即 fake；未接任何 pi-durable/chord/SDK 实体、未接产品调度。
- **不迁旧 stalled**：遵守审计第 5 点——旧 `queued/stalled` 标签不等于零效果，**本次不做任何自动迁移/转换**；本模块只承载全新合成任务合同。
- **不开生产 route**：`routes.backgroundDispatch` 默认关闭且**未在任何生产入口开启**。
- **跨进程单 owner 未实证**：fence 与单 in-flight 仅在本进程内（含快照恢复）成立；**跨进程单 owner/fencing 属接线阶段**，本层不做也不宣告。
- **隐私 epoch 仅以不透明 token 记录、不校验**：本层不携带/校验隐私 epoch 字段（键中有 account/profile 身份段，但 epoch 装配与校验依赖 context-assembler 接线另验）——此处如实声明为**未实现/未验证**。
- **slot 与预算的解耦是声明性的**：本层断言「不 import budget-policy、不做 settle/regrant 释放 slot」；二者**同时约束同一 Goal 的联测**未做（需接线切片）。
- **payload 摘要非密码学**：FNV-1a 32 仅用于**确定性去重/变更检测**，不提供抗碰撞安全性。
- **`snapshot()` 返回对象而非字符串**：合同写「`snapshot()` → JSON」；本层返回 JSON 可序列化的普通对象（`fromJSON` 同时接受对象与 JSON 串），与 `route-binding`/`budget-policy` 的 `toJSON` 风格一致——若审计要求字符串形式请裁决。
- 未执行真实外呼/生产读写/微信外发/服务重启/**任何 git 命令**；`package.json` 仅新增一行 script。
