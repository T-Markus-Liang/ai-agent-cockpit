# 执行交接包：P4 Wave3 第8步 reviewer 只读约束的代码强制（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包为 P4/B03 的 Wave3 第 8 步（reviewer 切片）：把 [p4-readiness-r1](./p4-readiness-r1.md) **最小施工面第 8 步**中的「**reviewer 只读约束（当前无代码强制）**」落地为第一处**代码强制**。源码 + 纯合成测试，**不动生产、不启动任何真实 CLI、无外呼**。

## 批次身份与状态

- batchId / revision：p4-reviewer-readonly / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Markus 的 Personal AI OS 会话 subagent（deepseek-flash，执行方）；主 Agent 定稿设计合同、复跑验收
- branch `feat/0.3.0-progress`；cwd `/Users/markus/ai-agent-cockpit`
- 已读并确认协作协议：是。本批**写入且仅写入**：`control-plane/contracts.mjs`、`control-plane/reviewer.mjs`、`control-plane/native-acp-executor.mjs`、`tests/control-plane.test.mjs`、`tests/native-acp-executor.test.mjs`、`docs/handoffs/p4-reviewer-readonly-r1.md`（新文件）。**未触碰** `package.json`、`docs/audits/**`、`docs/plans/**`、`control-plane/store.mjs`、`control-plane/native-sandbox.mjs`、`control-plane/native-acp.mjs`、`control-plane/dispatcher.mjs`、`gateway/control-plane.mjs`、任何生产服务/DB/launchd/真实用户文件/真实 CLI
- 对应：P4/B03 Wave3 第 8 步；缺口 8（[p4-readiness-r1.md:37](./p4-readiness-r1.md)「第二个真实 Worker 做 Reviewer（满足 workerId 独立 + 同 artifact）+ reviewer 只读约束（当前无代码强制）」）；本批**只做**「reviewer 只读约束的代码强制」，workerId 独立 / 同 artifact 的完成门槛校验 [store.mjs:242-281](../control-plane/store.mjs) 已存在（只读复用）
- 本批目标：① `contracts.createExecution` 增加**可选** `role: 'worker' | 'reviewer'` 枚举（缺省不写、非法即拒、绝不伪造）；② `createReviewerExecution` 创建时标 `role:'reviewer'`；③ `runNativeAcpPrompt` / `executeNativeSessionPrompt` 的 **sandbox spec 派生**对 reviewer 执行**强制 writeLiterals 为空**并留痕。明确不做：真实 Worker 评审（属授权批）、其它执行路径（cezar/vendor）的 reviewer 只读、GUI 占用检测（缺口 V41）、session 索引一致性接线、生产重启、commit/push
- **未执行任何 git 命令**（含只读）；故未取 base HEAD 与改动前旧 blob sha。审计方如需对拍，可按 branch `feat/0.3.0-progress` 自行复核。

## r1 固定来源（完整 sha256）

| 文件 | r1 sha256（完整） | 说明 |
| --- | --- | --- |
| `control-plane/contracts.mjs` | `1619d002a4d1f9b8e7d139822a4d42743bae07da5209d9a628da7b5b64f06abc` | 新增 `EXECUTION_ROLES`；`createExecution` 增可选 `role`（缺省省略、非法拒） |
| `control-plane/reviewer.mjs` | `f3761b786565cf40816a6a8c37c713d7afa97480c07308f73689a372e6f85714` | `createReviewerExecution` 创建执行时带 `role:'reviewer'` |
| `control-plane/native-acp-executor.mjs` | `ea3127dd9076f17e883e415a64f2e1a97a27fb81d3e6f0cc964814b7779aac02` | `REVIEWER_READONLY_APPLIED` + `applyReviewerReadonlyConstraint`；`runNativeAcpPrompt` 增 `role` 并派生只读 spec；`executeNativeSessionPrompt` 从 Execution 取 role、留痕 Evidence |
| `tests/control-plane.test.mjs` | `7dc84a86eb8b7c3a5d927ed1b008d46a1a49f7d3036125f413a527e1a8db2e9b` | 新增 2 用例（role 枚举 + store 透传/拒非法）+ reviewer 用例加 role 断言（21 → 23） |
| `tests/native-acp-executor.test.mjs` | `4ad2b99623b94c0b4368d7aaa405b3171b4f8ed048391d4b94d4c80a0dfa7866` | 新增 4 用例（36 → 40，纯合成） |
| `docs/handoffs/p4-reviewer-readonly-r1.md` | 本文件（新增；其内容哈希在写入自身时不可自洽，故按模板留空） | — |
| `package.json` | `325074b22b2f9fc4127c3d6e034c55d7d5b4e4722fc92051e589c837e27f1436` | **未改**；与 D54/D55/D56 冻结值逐字相同，确认未漂移 |
| `control-plane/store.mjs` | `e255511ef936ac3acc58d6d5bf26b890b14cc895744207dc5fcd3e3023b3e688` | **未改**；`createExecution` 经 `contracts.createExecution` 天然透传/校验 `role`，`completionPlanState` 的独立 reviewer 结构校验（:242-281）只读复用 |
| `gateway/control-plane.mjs` | `34c362d8a5975d72f44a9c3e0c67089f2c2d512adf4c8122f3ad1b0148af4e61` | **未改**；reviewer 创建路径不经网关改键（role 由 `reviewer.mjs` 内部注入） |

- 无新依赖（改动仅用既有模块；测试侧 `node:test`/`node:fs`/`node:os`/`node:path` 为内置）。

## 设计合同逐条落实

### 1. `contracts.mjs`：Execution 增 `role`（可选枚举）

- 新增导出 `EXECUTION_ROLES = Object.freeze(['worker','reviewer'])`。
- `createExecution`：`const role = input.role === undefined ? undefined : enumValue(input.role, 'role', EXECUTION_ROLES)`，随后 `...(role === undefined ? {} : { role })`。
- 语义：**可选**；**缺省不写该字段**（= worker 语义，**不为旧记录伪造**，旧记录 `'role' in execution === false`）；出现时必须是合法枚举值，否则抛 `ContractError`（`enumValue` 路径，`path=['role']`）。空白串 `''` 亦拒（非枚举值）。
- **序列化/校验路径盘点**：`createExecution` 是全仓唯一的 Execution 构造/校验点（`ControlPlaneStore.createExecution` 直接调它；无独立 `toJSON`/`validate`；state 以 JSON 落盘，`JSON.stringify/parse` 对新增可选键无形状约束）。故仅此一处即同步。store 层无需改：`store.createExecution(taskId, input, ...)` → `createExecution({ ...input, taskId, status })` 已自然携带并校验 `role`。

### 2. `reviewer.mjs`：`createReviewerExecution` 标 `role:'reviewer'`

- `store.createExecution(taskId, { workerId: reviewerId, role: 'reviewer', sessionRefId, parentExecutionId: sourceExecutionId, artifactRef: source.artifactRef }, { idempotencyKey })`——仅在入参对象**新增一个 `role:'reviewer'`**，其余判定（`STORE_REQUIRED`/`REVIEWER_REQUIRED`/`EXECUTION_TASK_MISMATCH`/`SOURCE_NOT_REVIEWABLE`）与「同 artifactRef、parentExecutionId 链接」不变。
- 返回体：`{ ...execution, reviewOf, independent }`，其中 `execution` 为 store 返回的 `{ ...result, execution }`，故 **`review.execution.role === 'reviewer'`**（返回体含 role）。
- **不标 role 的后果（只读强制的触发条件）**：`executeNativeSessionPrompt` 从**存储的** `execution.role` 派生只读，故 reviewer 子执行一旦创建即带 `role`，只读约束自动生效；漏标则退化为 worker 语义（可写）——这是本批「创建即标 role」的意义。

### 3. 只读强制（`native-acp-executor.mjs`，本批唯一强制点）

- 新增导出常量 `REVIEWER_READONLY_APPLIED`（稳定机读码）与函数 `applyReviewerReadonlyConstraint(spec, role)`：
  - `role !== 'reviewer'` → **原样返回同一 spec 对象**（`spec` 引用不变）+ `{ code, applied:false }`；调用方 grant 的 `writeLiterals` **原样传递**。
  - `role === 'reviewer'` → 返回**新** spec：`writeLiterals: []`（强制清空，**即便调用方 grant 显式给了写路径**），`readLiterals`/`execLiterals`/`workspaceDir`/`denyNetwork` **逐字保留**（评审需要读 artifact；network 沿用 grant）；`readonly = { code: REVIEWER_READONLY_APPLIED, applied:true, strippedWriteLiterals:[...] }`。**不修改入参 spec**（返回新对象）。
- `runNativeAcpPrompt({ ..., role })`：`spec = applyReviewerReadonlyConstraint(nativeAcpSandboxSpec({ command: selected.command, cwd, grant: sandboxGrant }), role).spec`，只有**剥过的** spec 进 `wrap(...)`；结果对象新增 `reviewerReadonly`。
- `executeNativeSessionPrompt`：**从存储的 `execution.role` 取 role**（非调用方入参，调用方无法靠漏参洗掉约束）传给 `runNativeAcpPrompt`；当 `result.reviewerReadonly.applied` 为真时，**additionally** 写一条 `kind:'log'` 的 Evidence：
  - 有被剥路径：`REVIEWER_READONLY_APPLIED: reviewer execution forced read-only; stripped caller-supplied writeLiterals [<paths>]`；
  - 无写路径：`REVIEWER_READONLY_APPLIED: reviewer execution forced read-only; no writeLiterals were granted`。
  - 该 Evidence 用独立幂等步 `<key>:readonly`，在 `evidence`/`verifying`（或 `cancelled`）之前落盘；运行结果（`executeNativeSessionPrompt` 与 `runNativeAcpPrompt`）都带回 `reviewerReadonly`。
- **强制降级 + 留痕（非静默接受）**：调用方给 reviewer 执行传 `writeLiterals` **不被拒绝**（运行照常，只是只读），但**被剥除并双处留痕**（run 结果字段 + store Evidence），符合设计「不是静默接受而是强制降级+留痕」。
- **路径语义**：read-only 强制在 **spec 派生层**（executor 内），不依赖调用方自觉；`native-sandbox.normalizeSpec` 未改（`writeLiterals:[]` 是合法 spec）。workspace 读（Seatbelt 默认 allow default + 具体 deny/allow 由 wrapper 处理）不受本批影响。

### 4. 测试

- `tests/control-plane.test.mjs`（**21 → 23**）：
  - 新增「Execution.role is an optional worker|reviewer enum and is never fabricated」：缺省 `'role' in exec === false`；`'worker'`/`'reviewer'` 透传；`'chief'`/`''` 抛 `ContractError`。
  - 新增「store.createExecution passes role through and rejects an illegal role」：store 层无 role → 不写；`role:'reviewer'` → 透传；`role:'chief'` → `ContractError`（合同经 store 自然生效）。
  - 「reviewer execution is an independent auditable child」加断言：`review.execution.role === 'reviewer'`；source worker 执行 `'role' in === false`。
- `tests/native-acp-executor.test.mjs`（**36 → 40**）：
  - 单元：`applyReviewerReadonlyConstraint` 对 reviewer 剥 `writeLiterals`、保 read/network、**不改入参**、worker/undefined 原样返回。
  - 端到端 1：`runNativeAcpPrompt` + `role:'reviewer'` + 显式 `writeLiterals` → **spy sandbox 捕获的 spec.writeLiterals 为空**，read 保留，结果 `reviewerReadonly.applied===true` 且 `strippedWriteLiterals` 含被剥路径。
  - 端到端 2：`runNativeAcpPrompt` 无 role（worker）→ `spec.writeLiterals` **原样传递**，`applied===false`。
  - 端到端 3：`executeNativeSessionPrompt` 用 store 里 `role:'reviewer'` 的执行 → spy sandbox spec.writeLiterals 空、结果带标记、store 里存在 `kind:'log'` 且摘要含 `REVIEWER_READONLY_APPLIED` 与路径的 Evidence。

## 负例清单与原始结果

`npm run test:native-acp-executor`（**40 用例全绿**，原 36 + 新增 4）新增用例（原始结果：全部 pass）：

| # | 用例名 | 断言要点 | 结果 |
| --- | --- | --- | --- |
| 1 | applyReviewerReadonlyConstraint strips writeLiterals only for a reviewer and never mutates the input | reviewer → `writeLiterals:[]`、read/denyNetwork 保留、入参 spec 未被改、`strippedWriteLiterals` 正确；`undefined`/`worker` → **同一 spec 引用原样返回**且 `applied:false` | ✔ |
| 2 | a reviewer native prompt forces writeLiterals empty in the sandbox spec and reports the marker | spy sandbox 捕获 `spec.writeLiterals===[]`、`readLiterals` 保留、`denyNetwork` 不变；结果 `code===REVIEWER_READONLY_APPLIED`、`applied===true`、`strippedWriteLiterals` 含 `/tmp/must-not-write.txt`；prompt 仍 `end_turn` | ✔ |
| 3 | a worker native prompt passes writeLiterals through unchanged | 无 role（worker）→ `spec.writeLiterals===['/tmp/write.txt']`（**不受影响**）；`applied===false` | ✔ |
| 4 | executeNativeSessionPrompt takes the role from the stored execution and records the read-only constraint | 存储执行 `role:'reviewer'` → spy sandbox `writeLiterals===[]`；execution 进 `verifying`；结果带标记；store Evidence 有 `kind:'log'`、摘要含码与路径 | ✔ |

`npm run test:control-plane`（**23 用例全绿**，原 21 + 新增 2）新增/加强用例（原始结果：全部 pass）：

| # | 用例名 | 断言要点 | 结果 |
| --- | --- | --- | --- |
| 1 | Execution.role is an optional worker\|reviewer enum and is never fabricated | 缺省**不写字段**；`worker`/`reviewer` 合法；`chief`/`''` → `ContractError` | ✔ |
| 2 | store.createExecution passes role through and rejects an illegal role | store 无 role 不写、`reviewer` 透传、`chief` → `ContractError` | ✔ |
| 3 | reviewer execution is an independent auditable child（加强） | `review.execution.role==='reviewer'`；source worker `'role' ∈ ===false` | ✔ |

- 负例均为**合成夹具**：假 ACP agent 是测试内写的 Node 小脚本（`fakeAgentScript`），经 `command/args` spawn；`cwd='/tmp'`；store 落在 `mkdtemp` 的临时 state 目录；sandbox 为 passthrough spy（不触发真实 Seatbelt，除非既有 MAC-gated 用例显式不注入）。**无外呼、无真实 CLI、无真实用户文件**。

## 验证（全绿）

| 套件 | 命令（cwd=仓库根） | 结果 |
| --- | --- | --- |
| native-acp-executor（本批扩写） | `npm run test:native-acp-executor` | **40/40 pass，exit 0** |
| control-plane（含 http + MCP 工具名 + 既有 native 覆盖，本批扩写） | `npm run test:control-plane` | **23/23 pass，exit 0** |
| runtime-contract（回归） | `npm run test:runtime-contract` | **14/14 pass，exit 0** |
| runtime-policy（request-authority/approval-authority/acp-permission-broker/control-plane-lock，回归） | `npm run test:runtime-policy` | **39/39 pass，exit 0** |
| goals（回归） | `npm run test:goals` | **74/74 pass，exit 0** |
| secret scan | `npm run audit:secrets` | **PASS：0 undispositioned credential-shaped hits** |

关键输出摘要（`npm run test:native-acp-executor`，新增 4 条）：

```
✔ applyReviewerReadonlyConstraint strips writeLiterals only for a reviewer and never mutates the input
✔ a reviewer native prompt forces writeLiterals empty in the sandbox spec and reports the marker
✔ a worker native prompt passes writeLiterals through unchanged
✔ executeNativeSessionPrompt takes the role from the stored execution and records the read-only constraint
ℹ tests 40  ℹ pass 40  ℹ fail 0
```

关键输出摘要（`npm run test:control-plane`，新增 2 条）：`Execution.role is an optional worker|reviewer enum and is never fabricated`、`store.createExecution passes role through and rejects an illegal role`；`ℹ tests 23  ℹ pass 23  ℹ fail 0`。

- **既有用例零改动**：`role` 为可选且缺省省略，故既有 fixture（不含 role）全部按 worker 语义运行，`native-acp-executor` 原 36、`control-plane` 原 21 用例断言逐字未因本批改写（仅新增用例 + reviewer 用例加断言）。

## 未覆盖项与诚实边界声明

- **只强制 native-acp 路径（本批范围）**：本批的代码强制**仅在 `native-acp-executor.mjs`**（`runNativeAcpPrompt`/`executeNativeSessionPrompt` 的 sandbox spec 派生）。**其它执行路径**——Cezar（`dispatcher.mjs` 的 `dispatchCezar`/`watchCezarExecution`/`cancelCezarExecution`）、vendor/wechat-acp 等——**尚无 reviewer 只读强制**，属**各自批次的后续切片**。本包**不声称**全仓 reviewer 只读已闭环。
- **真实 Worker 评审（未覆盖，属授权批）**：p4-readiness 第 8 步的「**第二个真实 Worker 做 Reviewer**」（真实 Codex/OpenCode 对真实 artifact 做 pass/fail 评审）**本批未做**，属**单独授权批**。本批只保证：reviewer 执行**被标记** `role:'reviewer'`，且 native 执行路径**对 reviewer 强制只读**——「同 artifact、workerId 独立、parentExecutionId 链接」的完成门槛（`store.completionPlanState`）**已存在**，本批只读复用、未改。
- **prompt 计划/审批摘要不含 role**：`nativePromptPlan` 的 parameters（进而 `parametersDigest`）**不含 role**；role 经**存储执行**派生（executor 内部），**不进入审批摘要**。即审批人显式审阅的仍是「哪个会话/哪个 prompt」，**不是**「worker 还是 reviewer」。若要让审批显式绑 role，需另起切片改 `nativePromptPlan`（会改动多处既有审批夹具）。
- **store Evidence 的 `kind:'log'` 是通用日志类**：只读留痕复用 `createEvidence` 既有允许的 `'log'` kind（未新增 kind）；下游若对 Evidence kind 有白名单消费需自行识别该条。
- **V41 GUI 占用检测（记录项，本批未做）**：p4-readiness「最小施工面」第 7/8 步并列的「GUI 占用检测列显式记录项（V41）」**本批未实现**，仍为未覆盖记录项。
- **只读约束在正常路径下自洽**：role 只源于**存储执行**（`execution.role`），调用方**无法**通过漏传/改传入参洗掉约束；`applyReviewerReadonlyConstraint` 非 reviewer 分支**原样返回** spec，故 worker/未标 role 的既有行为**逐字不变**。**未做跨进程并发压测**。
- **文件系统层未再验证**：只读强制的可观测证据在 **sandbox spec 层**（spy 捕获的 `spec.writeLiterals===[]`）；wrapper（`native-sandbox.mjs`）的 Seatbelt profile 生成与真实 OS 执法**本批未触碰、未新增证据**（既有 `tests/native-sandbox.test.mjs` 覆盖 wrapper 本体）。
- **生产未重启**：本批**未重启任何生产服务**（gateway/launchd 未动）；`gateway/control-plane.mjs` 调用点未改。网关运行态是否已加载新代码属部署动作，本批不做。
- **不关闭项**：本包**不**关闭 P4 其余缺口（真实会话零成功、tool-call 全拒未接 broker、裸 spawn 无 OS 约束、其它执行路径的 reviewer 只读、V41 GUI 占用、session 索引一致性接线）等，也不声称生产接线安全。

## 要求审计方做什么

- 按合同逐条复核本批 diff/hash/负例：① `contracts.createExecution` 的 `role` 是否**可选且不伪造**（缺省不写、非法枚举拒、旧记录不 back-fill）；② `reviewer.mjs` 是否**只**在创建入参加 `role:'reviewer'`，判定逻辑未动，返回体 `execution.role==='reviewer'`；③ `native-acp-executor.mjs` 是否在 **spec 派生层**对 reviewer **强制 `writeLiterals:[]`**（含剥掉显式 grant）、保留 read/network、**双处留痕**（run 结果 + Evidence log），且 role **取自存储执行**（非调用方入参）；④ 非 reviewer 分支是否**原样返回**（worker/未标 role 行为逐字不变）；⑤ 未改文件（`package.json`/`store.mjs`/`gateway/control-plane.mjs`）是否比对上表冻结 sha256 未漂移；⑥ `native-sandbox.mjs` 是否**未改**（本批只读复用）。
- 已知不足/需决定：其它执行路径（cezar/vendor）的 reviewer 只读何时立项；role 是否应进入 prompt 计划/审批摘要；只读留痕用 `kind:'log'` 是否需专用 kind；真实 Worker 评审与真实 CLI 合成会话属授权批；V41 GUI 占用检测何时立项。
- 本包为 **r1 首切片**：无「未解决 Finding」；未覆盖项见上一节，均为**后续批或部署动作**，非本切片合同要求关闭的子项。
