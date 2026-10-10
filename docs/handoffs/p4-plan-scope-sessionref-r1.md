# 执行交接包：P4 Wave3 第7步 sessionRefId 进入 plan/approval scope（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包为 P4/B03 的 Wave3 第 7 步（plan/approval scope 切片）：把 [p4-readiness-r1](./p4-readiness-r1.md) 的**缺口 7（plan/approval scope 不含 sessionRefId/cwd，SESSION_LOCKED/SESSION_BUSY 两道防线对 native 会话不生效）**落地——让 native prompt/cancel 的 plan 与审批 **绑定 sessionRefId**，并使 native prompt 链路携带的 sessionRefId 与 Execution 一致（两道防线按 `execution.sessionRefId` 生效）。源码 + 纯合成测试，**不动生产、不启动任何真实 CLI、无外呼**。

## 批次身份与状态

- batchId / revision：p4-plan-scope-sessionref / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Markus 的 Personal AI OS 会话 subagent（deepseek-flash，执行方）；主 Agent 定稿设计合同、复跑验收
- branch `feat/0.3.0-progress`；cwd `/Users/markus/ai-agent-cockpit`
- 已读并确认协作协议：是。本批**写入且仅写入**：`control-plane/native-acp-executor.mjs`、`control-plane/store.mjs`、`control-plane/request-authority.mjs`、`interfaces/mcp/server.mjs`、`scripts/control-plane.mjs`、`runtime/chief-tools.mjs`、`tests/native-acp-executor.test.mjs`、`tests/control-plane.test.mjs`、`tests/approval-authority.test.mjs`、`tests/request-authority.test.mjs`、`tests/runtime-tools.test.mjs`、`docs/handoffs/p4-plan-scope-sessionref-r1.md`（新文件）。**未触碰** `package.json`、`docs/audits/**`、`docs/plans/**`、`gateway/control-plane.mjs`、`control-plane/contracts.mjs`、`control-plane/session-index.mjs`、`control-plane/native-acp.mjs`、`control-plane/dispatcher.mjs`、任何生产服务/DB/launchd/真实用户文件/真实 CLI
- 对应：P4/B03 Wave3 第 7 步；缺口 7（[p4-readiness-r1.md:36](./p4-readiness-r1.md)）；承接 [p4-launch-intent-guard-r1](./p4-launch-intent-guard-r1.md)（launch intent + executionGuard）与 [p4-native-cancel-r1](./p4-native-cancel-r1.md)（native cancel 通道），保持其既定语义
- 本批目标：① `nativePromptPlan` 的 `parameters`/`parametersDigest` 及 `nativeCancelPlan` 的 `parameters`/`parametersDigest` **覆盖 sessionRefId**（一会话的审批不能用于另一会话）；② `executeNativeSessionPrompt` **必填 sessionRefId**（缺失→400，不造默认值）且必须与 `execution.sessionRefId` 一致（不一致→409）；③ `attachExecutionRef` 的 engineRef 与 `consumeApproval` 的 executionGuard 两侧都带 sessionRefId，且 store guard 字段表加 `sessionRefId`；④ sessionRefId 经 HTTP/MCP/CLI 入口透传。明确不做：启动真实 Codex/OpenCode/任何真实 Agent CLI（属授权批）、GUI 占用检测（缺口 V41）、session 索引一致性接线、生产重启、commit/push
- **未执行任何 git 命令**（含只读）；故未取 base HEAD 与改动前旧 blob sha。审计方如需对拍，可按 branch `feat/0.3.0-progress` 自行复核。

## r1 固定来源（完整 sha256）

| 文件 | r1 sha256（完整） | 说明 |
| --- | --- | --- |
| `control-plane/native-acp-executor.mjs` | `2ac4350147cb72d5f6568da47b9951908cbb7e1baa07b0e338ebd8128048ec76` | nativePromptPlan/nativeCancelPlan 纳入并必填 sessionRefId；executeNativeSessionPrompt 必填+一致性校验；engineRef/guard 带 sessionRefId |
| `control-plane/store.mjs` | `e255511ef936ac3acc58d6d5bf26b890b14cc895744207dc5fcd3e3023b3e688` | `consumeApproval` 的 executionGuard 字段表增 `sessionRefId`（**仅此一处**；SESSION_LOCKED/SESSION_BUSY 既有逻辑未动） |
| `control-plane/request-authority.mjs` | `6e602a674a5ace9b3443dc0901f948c15662d6c654fe5823e9b83d636de8844d` | `nativeRemoteInput` 白名单增 `sessionRefId`（**仅此一键**；RR-F004 安检逻辑逐字未动） |
| `interfaces/mcp/server.mjs` | `2c9d7b7bc781533fdd263feb5edfcd0b64450e92d5d6f7dff8d4bda99acfac22` | `plan_native_prompt`/`prompt_native_session` inputSchema 增必填 `sessionRefId` |
| `scripts/control-plane.mjs` | `fa51bf1854ef2cada2ff60be953af8e4a5edb73566ba52493a19bf0155725574` | `native plan`/`native prompt` 增必填 `--session-ref` |
| `runtime/chief-tools.mjs` | `f531fbff48727429cd8df0ec493dbe94bef63fa645891a5c77172f041fe62340` | `aios_plan_native_prompt` 增必填 `sessionRefId` 并校验与子 Execution 的绑定一致（见合同 5：nativePromptPlan 的必填字段牵连此调用方） |
| `tests/native-acp-executor.test.mjs` | `9524e00f2c6fdabfeae6d57fe5a0fe1439dc6cfc5fa0d7c31df48880539220f0` | 既有夹具适配必填字段 + 新增 6 用例（30 → 36，纯合成） |
| `tests/control-plane.test.mjs` | `a7565af880183f2af1a95402722803d9c6cc14e5502778d070fc2c0a7e2ea6fd` | 两个 native executor 用例透传 sessionRefId（用例数不变，仍 20） |
| `tests/approval-authority.test.mjs` | `09fa6ae787c38f6a1bcdaec92cbbfb8ae1476fcefc246560184a0d76d1c73307` | strict native 负例透传 sessionRefId + engineRef 断言含 sessionRefId（用例数不变） |
| `tests/request-authority.test.mjs` | `f713b1d911ef1143a2065da785931490808a338468d9c365a75680744ef8e6b6` | nativeRemoteInput 作用域用例增 `sessionRefId`（用例数不变） |
| `tests/runtime-tools.test.mjs` | `a434cda378853e4a886507853c37c8981cf4dece4c7948584e0bb2f0cfacd612` | chief-tools plan 用例透传 sessionRefId（用例数不变，仍 19） |
| `docs/handoffs/p4-plan-scope-sessionref-r1.md` | 本文件（新增） | — |
| `package.json` | `325074b22b2f9fc4127c3d6e034c55d7d5b4e4722fc92051e589c837e27f1436` | **未改**；与 D54/D55 冻结值逐字相同，确认未漂移 |
| `gateway/control-plane.mjs` | `34c362d8a5975d72f44a9c3e0c67089f2c2d512adf4c8122f3ad1b0148af4e61` | **未改**；native plan/prompt 路由已 `...spread` `nativeRemoteInput(...)`，sessionRefId 天然透传（与 D55 冻结值逐字相同） |
| `control-plane/contracts.mjs` | `dc4490366973c46831dea62e81a17e45417c4257879a0326b76060d03d0ce541` | **未改**；`createExecution` 的 `sessionRefId` 字段（可选非空串）D54 已就绪，本批只读复用（与 D54 冻结值相同） |
| `control-plane/session-index.mjs` | 未改 | 只读复用；见「未覆盖项 · session 索引一致性接线」 |

- 无新依赖（`control-plane/*`、`interfaces/mcp/*`、`scripts/*`、`runtime/*` 皆只用内置与既有模块；测试侧 `node:test`/`node:fs`/`node:os`/`node:path` 为内置）。

## 设计合同逐条落实

### 1. sessionRefId 进入 plan/approval scope

- **`nativePromptPlan`**：新增解构字段 `sessionRefId`，**必填**（缺失/空串 → `NATIVE_PROMPT_PLAN_INVALID`，400）；写入 `parameters.sessionRefId`，故 `parametersDigest` 覆盖它——**A 会话的审批摘要 ≠ B 会话的审批摘要**。
- **`nativeCancelPlan`**：新增 `sessionRefId`，**必填**（缺失 → `NATIVE_CANCEL_PLAN_INVALID`，400）；`parameters = { executionId, target, sessionRefId }`，digest 覆盖三者（与 prompt 同 scope 口径）。
- **`executeNativeSessionPrompt`**：
  1. `if (!sessionRefId) throw SESSION_REF_REQUIRED (400)`——**缺失即拒，不造默认值**；在写任何 launch intent / 消费审批**之前**抛出，零副作用。
  2. `if (execution.sessionRefId !== sessionRefId) throw EXECUTION_SESSION_MISMATCH (409)`——**execution 绑定与输入不一致即拒**。
  3. `scope = { source, nativeSessionId, sessionRefId, cwd, ...(accountId?), ...(profileId?) }`，engineRef 与 executionGuard **同源于此 scope**，两侧都含 sessionRefId。
- **`attachExecutionRef` engineRef**：`{ engine:'native-acp', id:\`${source}:${nativeSessionId}\`, ...scope }` → 现含 `sessionRefId`（durable ref 也带上会话绑定）。
- **`store.consumeApproval` executionGuard 字段表**：`['source','nativeSessionId','cwd','sessionRefId','accountId','profileId']`——engineRef 与 guard 两侧逐项一致比较（任一不符 → `EXECUTION_SCOPE_CHANGED` 403）。
- **cancel 路径**：`cancelNativeExecution` 以 `execution.sessionRefId` 构造 `nativeCancelPlan({ executionId, engineRef, sessionRefId })`——cancel 审批同样只绑定一个会话。取消的 `consumeApproval` 不传 executionGuard（沿用 D55 口径），故只经 plan 摘要口径 + `requireOperator` 绑定。

### 2. 一致性而不是伪造

- **不造默认值**：prompt 与 cancel 两条路径的 sessionRefId 均**必填**，缺失即 **400 拒绝**（`SESSION_REF_REQUIRED` / `NATIVE_PROMPT_PLAN_INVALID` / `NATIVE_CANCEL_PLAN_INVALID`）。调用方（HTTP/MCP/CLI/测试/chief-tools）显式传。
- **SESSION_BUSY 的实际触发**：由 `store.createExecution` **创建时**携带 `execution.sessionRefId` 触发（既有逻辑，store.mjs:399-405，**本批未改该段**）。本批保证 native prompt 链路携带的 sessionRefId 与 `execution.sessionRefId` 一致（否则 409），因此「两道防线守护的会话」= 「实际被 prompt 的会话」，二者不可能分叉。既有的 `acquireSessionLock`（SESSION_LOCKED，store.mjs:605-628）同理按 sessionRefId 生效。

### 3. 三入口（+chief-tools）传参路径

- **HTTP**：`gateway/control-plane.mjs` 的 `/native/plan` 与 `/native/prompt` 已 `...spread` `nativeRemoteInput(...)` 的返回，故**网关无需改代码**；为此在 `control-plane/request-authority.mjs` 的 `nativeRemoteInput` 白名单**新增 `sessionRefId` 一键**（`accountId`/`profileId` 同批已加；`command/args/env/store/principal` 等宿主依赖仍严格拒绝，**RR-F004 的安检逻辑逐字未动**）。cancel 路由（`.../native/cancel`）与 cezar cancel 一致，走裸 `body(req)`，不经 `nativeRemoteInput`；其 sessionRefId 由 `execution.sessionRefId` 在 executor 内派生，调用方无需传。
- **MCP**：`interfaces/mcp/server.mjs` 的 `plan_native_prompt` 与 `prompt_native_session` 的 `inputSchema` **新增必填 `sessionRefId`**（`TOOL_ARGUMENT_ALLOWLIST` 由 schema properties 派生，自动放行）；`callTool` 分支的 `...args` 透传无需改。
- **CLI**：`scripts/control-plane.mjs` 的 `native plan` 与 `native prompt` **新增必填 `--session-ref`**（注意：`--session` 沿用为 `nativeSessionId`，故新键用 `--session-ref`，避免歧义）。
- **chief-tools（Pi 首席扩展）**：`aios_plan_native_prompt` 的工具参数**新增必填 `sessionRefId`**，并校验 `child.sessionRefId === args.sessionRefId`（规划范围必绑定子 Execution 的会话），随后 `...args` 透传 `nativePromptPlan`。此处为合同 1（nativePromptPlan 必填）的连带调用方，见「未覆盖项/偏差」。

### 4. 验证与负例（见下节）

### 5. 合同偏差说明（诚实边界）

- **`nativePromptPlan` 的 sessionRefId 采用了「必填」而非「可选」**：合同写「parameters 增加 sessionRefId」，未逐字要求 plan 层必填，但本批取 **fail-closed 强解读**（「缺失即拒」），使 HTTP `/native/plan`、MCP `plan_native_prompt`、CLI `native plan`、chief-tools 规划**四个规划入口**统一在缺 sessionRefId 时 400，避免产出「无会话绑定的空审批摘要」。**连带影响**：调用方 `runtime/chief-tools.mjs` 与其测试 `tests/runtime-tools.test.mjs` 必须同步改（二者均在本批写入集内）。若审计方判定 plan 层应保持「可选」，改回只需去掉 `nativePromptPlan` 校验串中的 `!sessionRefId` 并复原 chief-tools/其测试。
- **sessionRefId 现进入审批 `parametersDigest`**：与 D54 边界「approval 参数摘要不含 account/profile（仅有 execution guard 绑定）」不同——按本批合同，**sessionRefId 进入摘要**（account/profile 仍不进摘要，仅经 guard）。即：审批人显式审阅的是「哪个会话」，account/profile 仍是 guard-only。
- **cancel 的 sessionRefId 由 Execution 派生（非入参）**：cancel 侧不新增调用方入参；`execution.sessionRefId` 缺失时 `nativeCancelPlan` 会以 `NATIVE_CANCEL_PLAN_INVALID`(400) 拒绝（fail-closed）。既有 `idleNativeExecution`/`cancelFixture` 夹具已补 sessionRefId。

## 负例清单与原始结果

`npm run test:native-acp-executor`（**36 用例全绿**，原 30 + 新增 6）中的新增用例（原始结果：全部 pass）：

| # | 用例名 | 断言要点 | 结果 |
| --- | --- | --- | --- |
| 1 | nativePromptPlan carries sessionRefId into the approval digest and refuses a plan without one | `parameters` 逐项含 `sessionRefId`；digest 等于 `parametersDigest(parameters)`；缺 sessionRefId → `NATIVE_PROMPT_PLAN_INVALID`(400)；仅 sessionRefId 不同 → **digest 不同** | ✔ |
| 2 | executeNativeSessionPrompt refuses a missing sessionRefId fail-closed before any effect | 缺 sessionRefId → `SESSION_REF_REQUIRED`(400)；execution 仍 `queued`、`engineRef===undefined`、审批 `usedAt===undefined`（**零副作用**） | ✔ |
| 3 | executeNativeSessionPrompt refuses a sessionRefId that differs from the execution binding | 输入 sessionRefId ≠ execution.sessionRefId → `EXECUTION_SESSION_MISMATCH`(409)；execution 仍 `queued`、审批未消费 | ✔ |
| 4 | an approval bound to one session cannot authorize a prompt on another session | 审批摘要**仅**因 sessionRefId 不同而与执行 plan 不同 → 抛 `APPROVAL_SCOPE_MISMATCH`；execution `blocked`；错会话审批未被消费 | ✔ |
| 5 | the sessionRefId the native prompt binds is the session SESSION_BUSY/SESSION_LOCKED guard | 同会话第二个活跃 execution → `SESSION_BUSY`；被锁会话无 token → `SESSION_LOCKED`；native prompt 用其它 sessionRefId → `EXECUTION_SESSION_MISMATCH`（防线与会话不分叉） | ✔ |
| 6 | a cancel approval bound to one session cannot cancel another session | cancel 摘要仅因 sessionRefId 不同 → `APPROVAL_SCOPE_MISMATCH`；execution 仍 `running`；错会话审批未消费 | ✔ |

**既有用例的必要适配**（因 sessionRefId 变为必填）：
- `native-acp-executor.test.mjs`：`launchFixture`/`cancelFixture`/`idleNativeExecution` 补 sessionRefId；guard/engineRef 断言含 sessionRefId；scope-drift 用例新增 `sessionRefId` 篡改分支（现覆盖 `cwd`/`nativeSessionId`/`sessionRefId` 三字段 → `EXECUTION_SCOPE_CHANGED`）；guard 用例新增 `sessionref-mismatch` 分支。nativeCancelPlan 形状用例断言 `parameters` 含 `sessionRefId` 且缺 sessionRefId 抛 400。
- `control-plane.test.mjs`（2 个 native 用例）、`approval-authority.test.mjs`（strict native 负例）、`request-authority.test.mjs`（nativeRemoteInput 作用域）、`runtime-tools.test.mjs`（chief-tools plan 用例）：透传 sessionRefId；用例总数均不变。

- 负例均为**合成夹具**：假 ACP agent 是测试内写的 Node 小脚本，经 `command/args` spawn；`cwd='/tmp'`；store 落在 `mkdtemp` 的临时 state 目录；sandbox 为 passthrough spy。**无外呼、无真实 CLI、无真实用户文件**。

## 验证（全绿）

| 套件 | 命令（cwd=仓库根） | 结果 |
| --- | --- | --- |
| native-acp-executor（本批扩写） | `npm run test:native-acp-executor` | **36/36 pass，exit 0**（~3.1s） |
| control-plane（含 http + MCP 工具名 + native 回归） | `npm run test:control-plane` | **21/21 pass，exit 0** |
| runtime-policy（request-authority/approval-authority/acp-permission-broker/control-plane-lock，本批改前两者） | `npm run test:runtime-policy` | **39/39 pass，exit 0** |
| goals（回归） | `npm run test:goals` | **74/74 pass，exit 0** |
| secret scan | `npm run audit:secrets` | **PASS：0 undispositioned credential-shaped hits** |
| runtime-contract + native-sandbox + session-permission-broker + legacy-adapter（相邻回归） | `node --test tests/runtime-contract.test.mjs tests/native-sandbox.test.mjs tests/session-permission-broker.test.mjs tests/legacy-adapter.test.mjs` | **73/73 pass，exit 0**（14+20+25+14） |
| runtime-tools（chief-tools 连带回归） | `node --test tests/runtime-tools.test.mjs` | **19/19 pass，exit 0** |

关键输出摘要（`npm run test:native-acp-executor`，新增 6 条）：

```
✔ nativePromptPlan carries sessionRefId into the approval digest and refuses a plan without one
✔ executeNativeSessionPrompt refuses a missing sessionRefId fail-closed before any effect
✔ executeNativeSessionPrompt refuses a sessionRefId that differs from the execution binding
✔ an approval bound to one session cannot authorize a prompt on another session
✔ the sessionRefId the native prompt binds is the session SESSION_BUSY/SESSION_LOCKED guard
✔ a cancel approval bound to one session cannot cancel another session
ℹ tests 36  ℹ pass 36  ℹ fail 0
```

## 未覆盖项与诚实边界声明

- **真实 CLI 合成会话（未覆盖，属授权批）**：本切片**不启动任何真实 Codex/OpenCode/Agent CLI**，故「plan/审批绑定 sessionRefId」的真实端到端仅在 store + 合成 ACP agent 上验证；真实 `session/load + prompt` 的隔离合成会话属**单独授权批**。
- **session 索引一致性接线（未覆盖）**：设计合同要求「若 store 有 session 索引可查证 sessionRefId 与 nativeSessionId/cwd 的对应关系则校验，没有就如实说明」。经核对：`ControlPlaneStore` 状态集合为 `tasks/executions/evidence/approvals/idempotency/locks/events`，**无 session 记录集合**；`control-plane/session-index.mjs` 产出的是只读快照（`indexLocalSessions`），**不落 store**，且其 `nativeSessionId→cwd` 映射亦非 store 可查。故**本批无法**在 store 层校验 `sessionRefId ↔ nativeSessionId/cwd` 的一致性——**索引一致性待接线**（需在后续切片把会话注册/索引写入 store，或在 executor 侧查 session-index 快照）。当前保证的是「输入 sessionRefId 必须等于 execution 上已绑定的 sessionRefId」，即**同一 Execution 的会话自洽**，但「该 sessionRefId 是否真指向 nativeSessionId/cwd 所描述的那条会话」尚无第二来源可核。
- **V41 GUI 占用检测（记录项，本批未做）**：p4-readiness「最小施工面」把「GUI 占用检测列显式记录项（V41）」与缺口 7 并列；本批**只**做 plan/approval scope 的 sessionRefId 绑定，**未实现** GUI 占用检测。缺口 7 的「SESSION_LOCKED/SESSION_BUSY 对 native 生效」这一**控制面**语义已落地，但**事前**的 GUI/宿主占用互斥检测仍为未覆盖记录项。
- **两道防线在正常路径下自洽**：SESSION_LOCKED/SESSION_BUSY 由 store 创建路径按 `execution.sessionRefId` 生效（既有逻辑）；本批保证 native prompt 的 sessionRefId 与 execution 一致（409 兜底），故防线与「实际 prompt 的会话」不分叉。**未做跨进程并发压测**。
- **生产未重启**：本批**未重启任何生产服务**（gateway/launchd 未动）；`gateway/control-plane.mjs` 调用点未改（`...spread` 已天然透传新键）。网关运行态是否已加载新代码属部署动作，本批不做。
- **`runtime/chief-tools.mjs` 为连带改动**：因合同 1 使 `nativePromptPlan` 必填 sessionRefId，此调用方必须同步（否则其 plan 工具恒返回 isError）。其冻结 descriptor digest 会随之变化（见 `docs/audits/evidence/**/live-check.sha256` 等历史证据文件——本批**未改**这些证据文件，仅提示审计方留意）。
- **不关闭项**：本包**不**关闭 P4 其余缺口（真实会话零成功、tool-call 全拒未接 broker、裸 spawn 无 OS 约束、V41 GUI 占用、session 索引一致性接线）等，也不声称生产接线安全。

## 要求审计方做什么

- 按合同逐条复核本批 diff/hash/负例：① `nativePromptPlan`/`nativeCancelPlan` 是否**必填** sessionRefId 且进入 `parametersDigest`；② `executeNativeSessionPrompt` 是否「缺 sessionRefId → 400（零副作用）」且「与 execution.sessionRefId 不一致 → 409」；③ engineRef 与 executionGuard 是否**同源于一 scope**且都含 sessionRefId；④ `store.consumeApproval` guard 字段表是否**只**加 `sessionRefId` 一项（SESSION_LOCKED/SESSION_BUSY 段逐字未动）；⑤ `request-authority.mjs` 是否**只**动 `nativeRemoteInput` 白名单一键（RR-F004 安检表达式逐字未动）；⑥ 三入口（HTTP 透传 / MCP schema / CLI `--session-ref`）与 chief-tools 连带改动是否与所述一致；⑦ 未改文件（`package.json`/`gateway/control-plane.mjs`/`contracts.mjs`）是否比对上表冻结 sha256 未漂移。
- 已知不足/需决定：`nativePromptPlan` 的 sessionRefId 取「必填」vs「可选」；sessionRefId 进入审批摘要（与 account/profile 口径不同）是否需统一；session 索引一致性接线的落点（store 会话集合 vs executor 侧查快照）；V41 GUI 占用检测何时立项；真实 CLI 合成会话验证属授权批。
- 本包为 **r1 首切片**：无「未解决 Finding」；未覆盖项见上一节，均为**后续批或部署动作**，非本切片合同要求关闭的子项（索引一致性为设计合同明确的「没有就如实说明」项）。
