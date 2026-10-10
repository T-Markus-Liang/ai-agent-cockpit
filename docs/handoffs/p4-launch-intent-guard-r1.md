# 执行交接包：P4 Wave3 第1+2步 SessionRef.accountId 与 native launch intent + executionGuard（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包为 P4/B03 的 Wave3 第 1+2 步（首切片）：把 [p4-readiness-r1](./p4-readiness-r1.md) 的**缺口 2（launch intent 顺序错误）/ 缺口 3（executionGuard 形同虚设）/ 缺口 4（SessionRef 缺 account 字段）**落地。源码 + 纯合成测试，**不动生产、不启动任何真实 CLI**。

## 批次身份与状态

- batchId / revision：p4-launch-intent-guard / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话 subagent（deepseek-flash，执行方）；主 Agent 定稿设计合同、复跑验收
- branch `feat/0.3.0-progress`；cwd `/Users/markus/ai-agent-cockpit`
- 已读并确认协作协议：是。本批**写入且仅写入**：`control-plane/contracts.mjs`、`control-plane/native-acp-executor.mjs`、`control-plane/request-authority.mjs`、`interfaces/mcp/server.mjs`、`scripts/control-plane.mjs`、`tests/control-plane.test.mjs`、`tests/native-acp-executor.test.mjs`、`tests/approval-authority.test.mjs`、`tests/request-authority.test.mjs`、`docs/handoffs/p4-launch-intent-guard-r1.md`（新文件）。**未触碰** `package.json`、`docs/audits/**`、`docs/plans/**`、`control-plane/store.mjs`、`control-plane/session-index.mjs`、`control-plane/native-acp.mjs`、`gateway/control-plane.mjs`、任何生产服务/DB/launchd/真实用户文件/真实 CLI
- 对应：P4/B03 Wave3 第 1+2 步；缺口 2/3/4（[p4-readiness-r1.md:14-17](./p4-readiness-r1.md)）；M02 executor 接线的后续切片（前置 [m02-native-acp-executor-r1](./m02-native-acp-executor-r1.md)）
- 本批目标：① `createSessionRef` 增加可选 `accountId`（不伪造默认值）；② `executeNativeSessionPrompt` 改为 **launch intent 前置**（先落 running + engine ref 再 spawn）+ **传 executionGuard**（审批绑到确切的 execution 范围）。明确不做：启动真实 Codex/OpenCode/任何真实 Agent CLI（属授权批）、GUI 占用检测（缺口 V41）、native cancel、tool-call 接 broker 的续批、生产重启、commit/push
- **未执行任何 git 命令**（含只读）；故未取 base HEAD 与改动前旧 blob sha。审计方如需对拍，可按 branch `feat/0.3.0-progress` 自行复核。

## r1 固定来源（完整 sha256）

| 文件 | r1 sha256（完整） | 说明 |
| --- | --- | --- |
| `control-plane/contracts.mjs` | `dc4490366973c46831dea62e81a17e45417c4257879a0326b76060d03d0ce541` | `createSessionRef` 增可选 `accountId` |
| `control-plane/native-acp-executor.mjs` | `95463c2998709c9596cdec67263406f4584fa0d3cb666bc6c063947a8d97228a` | launch intent 前置 + executionGuard + 超时计时器泄漏修复 |
| `control-plane/request-authority.mjs` | `ec6c0f88075c926fecba446fb43f92768fc309f712b40630b5ff7bd608e82199` | `nativeRemoteInput` 白名单增 `accountId`/`profileId`（**仅此两键**；安检逻辑未动） |
| `interfaces/mcp/server.mjs` | `99810fe29ca7027a5ffb71d50b46e9e482969e303c0bb258eaca462ae5be4feb` | `prompt_native_session` inputSchema 增 `accountId`/`profileId` |
| `scripts/control-plane.mjs` | `2a5679065c54f2d69c96c34d168aa9dbc9c7818995d0b538ecc7f86ac05be07f` | `native prompt` CLI 增 `--account`/`--profile` |
| `tests/control-plane.test.mjs` | `60a75cec59ef33b8f87e896683bdde1f7f7d9e67b12b0b4a040763be65961e7a` | SessionRef.accountId 断言（用例数不变） |
| `tests/native-acp-executor.test.mjs` | `f429a9606c3fa99832b16770bd3253d4b6a854701d0c97e58c6f89476660470c` | 新增 9 用例（11 → 20，纯合成） |
| `tests/approval-authority.test.mjs` | `4335b46ae5425b6c9b0f5a7a57509400c136d04d3a06832bbe0b276e6a89b70a` | 严格 native 负例的终态断言随新顺序更新（用例数不变） |
| `tests/request-authority.test.mjs` | `c9ab2276e15dd4c9de15429eec6de109cde2ae44badbd0f916e97d3c1968b48c` | 扩展 nativeRemoteInput 用例（用例数不变） |
| `docs/handoffs/p4-launch-intent-guard-r1.md` | 本文件（新增） | — |
| `package.json` | `325074b22b2f9fc4127c3d6e034c55d7d5b4e4722fc92051e589c837e27f1436` | **未改**；与 m02-r1 冻结值逐字相同，确认未漂移 |
| `control-plane/store.mjs` | `3788ff2fa98d370d7365f2dce58542769a30ac373fdac811aabec098495be999` | **未改**；`consumeApproval`/`attachExecutionRef` 只读复用 |
| `control-plane/session-index.mjs` | `ea4ba6709adadcc038e7be330f6dc7d74dfcaf42423402f231d571fe32f200f2` | **未改**（见合同 1：无真实 account 来源，构造点保持缺省） |

- 无新依赖（`node:fs/promises`、`node:os`、`node:path` 为内置，测试侧新增）。

## 设计合同逐条落实

### 1. `contracts.mjs`：SessionRef 增 `accountId`

- `createSessionRef` 新增：`const accountId = string(input.accountId, 'accountId', { optional: true })`，随后 `...(accountId === undefined ? {} : { accountId })`。
- 语义：**可选**；出现时必须为**非空字符串**（复用既有 `string(...{optional:true})`，空白串抛 `ContractError`）；未知（`undefined`）时**不写该字段**，**绝不伪造默认值**。与 store guard 的「两侧同为 `undefined` 是合法一致」对齐。
- **全仓 SessionRef 构造点盘点**（`grep createSessionRef`）：`control-plane/session-index.mjs:150/178/213/245/280/338`（codex/opencode/kimi/devin/workbuddy/claude 索引）、`control-plane/native-acp.mjs:89`（ACP session/list）、`tests/control-plane.test.mjs:21`。逐一核对数据源（各 provider 的 SQLite/JSON 列、ACP session/list 结果）**均无真实 account 字段**，故**全部保持缺省**（不臆造）。→ 见「未覆盖项 · accountId 真实来源盘点」。
- `tests/control-plane.test.mjs` 首个用例增断言：缺省时 `'accountId' in session === false`；`accountId:'acct-1'` 时透传；`accountId:''` 抛 `ContractError`（用例数不变，仍 21）。

### 2. `native-acp-executor.mjs`：launch intent 前置 + guard 接线

`executeNativeSessionPrompt` 新顺序（对齐 `runtime/legacy-adapter.mjs:369-395` 的「先落盘意图、后落效应」）：

1. 校验（`getTask`/`EXECUTION_TASK_MISMATCH`/`EXECUTION_NOT_QUEUED`）+ `nativePromptPlan`（不变）。
2. **先 `attachExecutionRef`**（`engine:'native-acp'`、`id:\`${source}:${nativeSessionId}\``、`source`、`nativeSessionId`、`cwd`，以及真实获得的 `accountId`/`profileId`）+ **`updateExecutionStatus(running, 'launch intent registered')`**。
3. **`consumeApproval(..., { executionGuard: { executionId, taskId, source, nativeSessionId, cwd, accountId, profileId } })`**：store 比对 `engineRef` 的 `['source','nativeSessionId','cwd','accountId','profileId']` 且要求 `status==='running'`，任一不符即 `EXECUTION_SCOPE_CHANGED`。
4. 通过后才 `runNativeAcpPrompt`（spawn）。

- **幂等键**：沿用 `${idempotencyKey ?? executionId}:<step>`，每步独立——`attach` / `running` / `approval` / `evidence` / `verifying` / `blocked`。
- **第二次 attach 的语义（已定）**：**改为不再重复 attach**。engine ref 只在第 2 步落一次（`ops.filter(attachExecutionRef).length === 1`，测试断言）；spawn 完成后**不再**二次 attach。第 5 步完成路径改为直接 `addEvidence → verifying`。
- **失败终态诚实**：区分阶段——**未 launch**（`consumeApproval` 抛错）→ `outcome = 'native ACP launch was not authorized (<CODE>): <msg>'`；**已 launch**（spawn/run 失败）→ `outcome = 'native ACP prompt failed or is uncertain: <msg>'`。两种都转 `blocked`，**不删记录、不伪装**；未获授权时 engine ref 作为「未获授权的启动意图记录」**保留**。
- **HTTP Idempotency-Key 重放语义**：每步 store 写各自幂等；但 `executeNativeSessionPrompt` 顶部的 `execution.status !== 'queued'` 前置在**首次成功后**（执行已 `verifying`/`blocked`）会以 `EXECUTION_NOT_QUEUED` 拒绝整请求重放——**与旧行为一致**（旧代码同样在 consume 前查 queued）。即：**同请求重放不会二次 spawn，也不会重放写**，以 `EXECUTION_NOT_QUEUED` 明确拒绝。
- **超时计时器泄漏修复**（新顺序暴露）：`request()` 在 `Promise.race([response, processFailure])` 中，spawn 进程失败路径下 `response` 永不 settle，其 `setTimeout(timeoutMs=120000)` 计时器不会被清理，导致事件循环（及任何测试进程）**空转 120 秒**才退出。改为 `try/finally` 中 `clearTimeout(timer)` + `pending.delete(id)`。语义不变（正常/超时/失败三路都即时清计时器）；这正是本批 spawn 失败负例能在 ~1.2s 内跑完的原因（修复前该用例使套件总时长 ~121s）。

### 3. `accountId` / `profileId` 来源与三入口传参路径（已核实）

- **来源**：本切片**从调用输入解析**。核对 `ControlPlaneStore` 状态结构（`tasks`/`executions`/`evidence`/`approvals`/`idempotency`/`locks`/`events`）——**无 session 记录集合**（`sessionRefId` 仅出现在 Execution 与 locks），故**不存在**可解析 account 的 store session 记录；唯一来源是调用方显式输入。有真实来源才带；没有就**不带**（两侧同为 `undefined`）。
- **HTTP**：`gateway/control-plane.mjs:188` 已 `...spread` `nativeRemoteInput(...)` 的返回，故**网关无需改代码**；为此在 `control-plane/request-authority.mjs` 的 `nativeRemoteInput` 白名单**新增 `accountId`/`profileId` 两键**（仅两键；`command/args/env/store/principal` 等宿主依赖仍严格拒绝，**R R-F004 的安检逻辑逐字未动**）。
- **MCP**：`interfaces/mcp/server.mjs:82` `prompt_native_session` inputSchema（`properties` 即 `TOOL_ARGUMENT_ALLOWLIST` 来源）**新增 `accountId`/`profileId`**；`server.mjs:230` 的 `...args` 透传无需改。
- **CLI**：`scripts/control-plane.mjs:104` `native prompt` **新增 `--account`/`--profile`**（走既有 `value()` 帮助函数）。
- 三入口均**可选**：不传时行为与本批前一致（字段缺省）。

## 负例清单与原始结果

`npm run test:native-acp-executor`（**20 用例全绿**，原 11 + 新增 9）中的关键负例/断言（原始结果：全部 pass）：

| # | 用例名 | 断言要点 | 结果 |
| --- | --- | --- | --- |
| 1 | launch intent (engine ref + running) is durably registered before the native CLI is spawned | spy store 记录序：`attachExecutionRef` < `updateExecutionStatus(running)` < `consumeApproval` < `spawn`；`attachExecutionRef` **恰 1 次** | ✔ |
| 2 | executor passes a fully-populated execution guard that matches the registered engine ref | 捕获的 `engineRef` 与 `executionGuard` 逐项含 `source/nativeSessionId/cwd/accountId/profileId` 且相等 | ✔ |
| 3 | absent account/profile stays absent on both sides and the prompt still completes | 两侧均无 `accountId/profileId` → 通过并进入 `verifying`；`engineRef` 无 `accountId`（不伪造） | ✔ |
| 4 | rejected approval leaves the execution blocked with the launch ref retained and an honest outcome | 抛 `APPROVAL_NOT_APPROVED`；`status==='blocked'`；`outcome` 含 `not authorized` 与 `APPROVAL_NOT_APPROVED`；engine ref **保留**；approval `usedAt===undefined` | ✔ |
| 5 | an expired approval is refused and honestly blocks the execution | 抛 `APPROVAL_EXPIRED`；`blocked`；`outcome` 含码 | ✔ |
| 6 | an approval that does not cover the prompt scope is refused and blocks the execution | 抛 `APPROVAL_SCOPE_MISMATCH`；`blocked` | ✔ |
| 7 | a spawn failure after the launch intent is registered keeps a traceable engine ref and blocks honestly | 抛 `NATIVE_ACP_ERROR`；`blocked`；`outcome` 含 `failed or is uncertain`；**崩溃可追查**（engine ref 仍在） | ✔ |
| 8 | a scope drift between the launch intent and the approval is refused with EXECUTION_SCOPE_CHANGED | 并发「重绑」`cwd` 或 `nativeSessionId`（spy store 在 running 后覆写 engine ref）→ 抛 `EXECUTION_SCOPE_CHANGED`；`blocked` | ✔ |
| 9 | consumeApproval executionGuard refuses a non-running execution and a one-sided account scope | execution 非 running → `EXECUTION_SCOPE_CHANGED`；`accountId` **只在 engine ref 侧**或**只在 guard 侧** → `EXECUTION_SCOPE_CHANGED` | ✔ |

- 负例均为**合成夹具**：假 ACP agent 是测试内写的 Node 小脚本（`fakeAgentScript`），经 `command/args` spawn；`cwd='/tmp'`；store 落在 `mkdtemp` 的临时 state 目录；sandbox 为 passthrough spy（不触发真实 Seatbelt，除非既有 MAC-gated 用例显式不注入）。**无外呼、无真实 CLI、无真实用户文件**。
- 用例 8 的「篡改」经 spy store 在 **running 之后**覆写 engine ref 来模拟并发重绑（真实 store 的 `attachExecutionRef` 同 engine+id 时允许覆写，engine/id 不同则 `ENGINE_REF_CONFLICT`）；这是 guard 在单进程正常路径下**自洽**、其防护面体现在**并发/前置篡改**时的证据（见「未覆盖项」）。

## 验证（全绿）

| 套件 | 命令（cwd=仓库根） | 结果 |
| --- | --- | --- |
| native-acp-executor（本批扩写） | `npm run test:native-acp-executor` | **20/20 pass，exit 0**（~1.2s） |
| control-plane（含 http + MCP 工具名 + 既有 native 覆盖，回归） | `npm run test:control-plane` | **21/21 pass，exit 0** |
| runtime-contract（回归） | `npm run test:runtime-contract` | **14/14 pass，exit 0** |
| runtime-policy（request-authority/approval-authority/acp-permission-broker/control-plane-lock，回归） | `npm run test:runtime-policy` | **39/39 pass，exit 0** |
| goals（回归） | `npm run test:goals` | **74/74 pass，exit 0** |
| secret scan | `npm run audit:secrets` | **PASS：0 undispositioned credential-shaped hits** |
| native-sandbox（相邻回归） | `npm run test:native-sandbox` | **20/20 pass，exit 0** |
| session-permission-broker（相邻回归） | `npm run test:session-permission-broker` | **25/25 pass，exit 0** |
| legacy-adapter（顺序示范来源，相邻回归） | `npm run test:legacy-adapter` | **14/14 pass，exit 0** |

关键输出摘要（`npm run test:native-acp-executor`）：

```
✔ the launch intent (engine ref + running) is durably registered before the native CLI is spawned
✔ the executor passes a fully-populated execution guard that matches the registered engine ref
✔ an absent account/profile stays absent on both sides and the prompt still completes
✔ a rejected approval leaves the execution blocked with the launch ref retained and an honest outcome
✔ an expired approval is refused and honestly blocks the execution
✔ an approval that does not cover the prompt scope is refused and blocks the execution
✔ a spawn failure after the launch intent is registered keeps a traceable engine ref and blocks honestly
✔ a scope drift between the launch intent and the approval is refused with EXECUTION_SCOPE_CHANGED
✔ consumeApproval executionGuard refuses a non-running execution and a one-sided account scope
ℹ tests 20  ℹ pass 20  ℹ fail 0
```

- **既有覆盖的必需更新（设计强制）**：`tests/approval-authority.test.mjs` 的「strict native prompt rejects an unverified approval before any process starts」原断言执行终态为 `queued`；因本批把 running 前置到 consumeApproval 之前，该未被授权的启动如实转 `blocked`（并保留引擎 ref），故断言更新为 `blocked` + 断言 `engineRef` 内容。**用例数不变（runtime-policy 仍 39）**，且「任何进程都不曾启动」的语义不变（`command:'/does-not-exist-never-spawn'` 从未 spawn）。

## 未覆盖项与诚实边界声明

- **真实 CLI 合成会话（未覆盖，属授权批）**：本切片**不启动任何真实 Codex/OpenCode/Agent CLI**，故 native 侧「launch intent + guard」的真实端到端仅在 store + 合成 ACP agent 上验证；真实 `session/load + prompt` 的隔离合成会话属**单独授权批**。
- **accountId 真实来源盘点（未接线）**：全仓 SessionRef 构造点**均无真实 account 字段**（session-index 六 provider 的库列、`native-acp.mjs` 的 `session/list` 结果都只到 provider/title/cwd/model 一级）；`store` 亦**无 session 记录集合**。因此 `accountId` 目前只能由调用方显式输入（HTTP/MCP/CLI 已放行该键）。**真实来源（如把各 provider 的账号/组织并入索引、或在 session 注册时写入账号）需在后续切片建立**；在此之前生产入口通常两侧同为 `undefined`（合法一致）。
- **guard 在正常路径下自洽**：执行器第 2 步 attach 与第 3 步 guard 同源于一次 `scope` 解析，故单进程正常路径下两者必相等——guard 的**独立防护面**是「并发/前置篡改使 execution 的 engine ref 偏离审批范围」（用例 8 以 spy store 模拟重绑证明）与「execution 非 running」（用例 9）。本切片**不做跨进程并发压测**。
- **approval 参数摘要不含 account/profile（有意为之）**：`nativePromptPlan` 的 `parameters`（进而 approval 的 `parametersDigest`）仍为 `{ taskId, executionId, source, nativeSessionId, cwd, promptDigest }`；`accountId/profileId` 仅经 **execution guard** 绑定，不进入审批摘要。若要让审批人显式审阅 account/profile 范围，需另起切片改 `nativePromptPlan`（会改变既有多处 approval 夹具）。
- **SessionRef.accountId 未接入派生/比对链**：字段已加且测试覆盖，但 `session-index`/`native-acp`/`router`/`reviewer` 等**尚未消费**该字段（仅契约层就绪）。
- **生产未重启**：本批**未重启任何生产服务**；`gateway/control-plane.mjs` 调用点**未改**（`...spread` 已天然透传新键）。网关运行态是否已加载新代码属部署动作，本批不做。
- **不关闭项**：本包**不**关闭 P4 缺口 1/5/6（真实会话零成功、tool-call 全拒未接 broker、裸 spawn 无 OS 约束）等其余缺口，也不声称生产接线安全。

## 要求审计方做什么

- 按合同逐条复核本批 diff/hash/负例：① `createSessionRef` 的 `accountId` 是否**可选且不伪造**（缺省不写、空串拒）；② 执行器顺序是否确为 `attach → running → consume(guard) → spawn`，且 `attach` **仅一次**；③ guard 是否确含 `source/nativeSessionId/cwd/accountId/profileId` 且与 engine ref 同源；④ 未获授权/失败是否**如实 blocked 且保留 ref**、`outcome` 是否按阶段诚实；⑤ `request-authority.mjs` 是否**只**动了白名单两键（安检表达式逐字未动）；⑥ 三入口传参路径是否与所述一致。
- 已知不足/需决定：accountId 真实来源落点（索引/注册侧）；account/profile 是否应进 approval 摘要；guard 的并发防护是否需更强（跨进程）证据；真实 CLI 合成会话验证属授权批。
- 本包为 **r1 首切片**：无「未解决 Finding」；未覆盖项见上一节，均为**后续批或部署动作**，非本切片合同要求关闭的子项。
