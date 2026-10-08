# 执行交接包：P4 Wave3 第6步 native ACP 取消通道（审批绑定 → ACP session/cancel + SIGTERM → running→cancelled）（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包为 P4/B03 的 Wave3 第 6 步（native cancel 切片）：新增**原生 ACP 取消通道**，对齐 `cancelCezarExecution` 的「审批绑定 → 效应 → 终态」模式。源码 + 纯合成测试，**不动生产、不启动任何真实 CLI、无外呼**。

## 批次身份与状态

- batchId / revision：p4-native-cancel / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Markus 的 Personal AI OS 会话 subagent（deepseek-flash，执行方）；主 Agent 定稿设计合同、复跑验收
- branch `feat/0.3.0-progress`；cwd `/Users/markus/ai-agent-cockpit`
- 已读并确认协作协议：是。本批**写入且仅写入**：`control-plane/native-acp-executor.mjs`、`control-plane/request-authority.mjs`、`gateway/control-plane.mjs`、`interfaces/mcp/server.mjs`、`scripts/control-plane.mjs`、`tests/native-acp-executor.test.mjs`、`tests/request-authority.test.mjs`、`tests/control-plane-http.test.mjs`、`docs/handoffs/p4-native-cancel-r1.md`（新文件）。**未触碰** `package.json`、`docs/audits/**`、`docs/plans/**`、`control-plane/store.mjs`、`control-plane/dispatcher.mjs`、`control-plane/contracts.mjs`、任何生产服务/DB/launchd/真实用户文件/真实微信/真实 CLI
- 对应：P4/B03 Wave3 第 6 步；承接 [p4-launch-intent-guard-r1](./p4-launch-intent-guard-r1.md)（native launch intent + executionGuard）与 [m02-native-acp-executor-r1](./m02-native-acp-executor-r1.md)
- 本批目标：① 在 `native-acp-executor.mjs` 建**进程内**在途注册表（executionId → {cancel()}），`cancel()` 先发 ACP `session/cancel`、2s 未收尾再 SIGTERM，幂等；② 新增 `nativeCancelPlan` + `cancelNativeExecution`（对齐 `cancelCezarExecution`）；③ 三入口接线（gateway / MCP / CLI）；④ 合成测试覆盖在途取消 / kill 兜底 / 审批绑定 / 不在途·已终态 / 幂等重放。明确不做：启动真实 Codex/OpenCode/任何真实 Agent CLI（属授权批）、生产重启、跨进程在途注册表、commit/push
- **未执行任何 git 命令**（含只读）；故未取 base HEAD 与改动前旧 blob sha。审计方如需对拍，可按 branch `feat/0.3.0-progress` 自行复核。

## r1 固定来源（完整 sha256）

| 文件 | r1 sha256（完整） | 说明 |
| --- | --- | --- |
| `control-plane/native-acp-executor.mjs` | `f17c38eae5dc0135a71bcaa2f1f0ba0ac2c91e0c0e8dfbd4a27a88bfbeee54ad` | 在途注册表 + cancel handle + `nativeCancelPlan` + `cancelNativeExecution`；`executeNativeSessionPrompt` 的 cancelled 结果路径 |
| `control-plane/request-authority.mjs` | `004eac5f13b5064f7fe61c98e3d035227d2d4cc848bc097fd18bec1697e168f6` | chief 正则 `native\/(plan\|prompt)` → `native\/(plan\|prompt\|cancel)`（**仅此一处**） |
| `gateway/control-plane.mjs` | `34c362d8a5975d72f44a9c3e0c67089f2c2d512adf4c8122f3ad1b0148af4e61` | 新增 `POST /api/control-plane/executions/:id/native/cancel` |
| `interfaces/mcp/server.mjs` | `95c32ab1f3eba8e433a21fbb91a051665157283f8af5acb50c56c68fa865cce1` | 新增 `cancel_native_session` 工具 |
| `scripts/control-plane.mjs` | `eccfcf600f815f8ba71735307e75240682eb41bee528c814a5215fe23ca03145` | 新增 `native cancel` 子命令 |
| `tests/native-acp-executor.test.mjs` | `1e4fe61dfd3d4edf20e636330bc15c039ea995f8f60662f5887c372d6157832d` | 新增 10 用例（20 → 30，纯合成） |
| `tests/request-authority.test.mjs` | `5bf05efb4dcf40f4b3484a6ac84183fe86541e9a463ad518a6604b1c8d0de379` | roles 用例增 `native/cancel` 授权/拒绝断言（用例数不变） |
| `tests/control-plane-http.test.mjs` | `24b18015264447c64a4391168968669186623090794d4ecfe3865395d8c9990d` | tools/list 断言增 `cancel_native_session`（用例数不变） |
| `docs/handoffs/p4-native-cancel-r1.md` | 本文件（新增） | — |
| `package.json` | `325074b22b2f9fc4127c3d6e034c55d7d5b4e4722fc92051e589c837e27f1436` | **未改**；与 p4-launch-intent-guard-r1 冻结值逐字相同，确认未漂移 |
| `control-plane/store.mjs` | `3788ff2fa98d370d7365f2dce58542769a30ac373fdac811aabec098495be999` | **未改**；`consumeApproval`/`updateExecutionStatus`（`running→cancelled` 合法）只读复用 |
| `control-plane/contracts.mjs` | `dc4490366973c46831dea62e81a17e45417c4257879a0326b76060d03d0ce541` | **未改** |
| `control-plane/dispatcher.mjs` | `272b642cea0f8ff3defb7f0dfb0dc40b8a465906f33374f1c5a259c9072ce644` | **未改**；`cancelCezarExecution` 为对齐来源 |

- 无新依赖（`node:child_process`、`node:readline`、`node:fs`（测试侧）均为内置）。

## 设计合同逐条落实

### 1. `native-acp-executor.mjs`：在途注册表 + `cancelNativeExecution`

- **在途注册表**：模块级 `const inFlightNativeExecutions = new Map()`，键 `executionId`、值 cancel handle。`runNativeAcpPrompt` 新增 `executionId` 形参：**在 `spawn` 之前 `set`，在 `finally` 中 `delete`**（`executeNativeSessionPrompt` 把 `executionId` 透传进来）。同步 spawn 失败（几乎不可能，仍防护）也会回滚注册。只读探针 `nativeInFlightExecutionIds()` 供取消通道与测试观测。
- **cancel handle 语义**：`cancel()` **一次性**发送 ACP `session/cancel` 通知（`{ method:'session/cancel', params:{ sessionId } }`，无 id），并起一个 `NATIVE_CANCEL_GRACE_MS = 2000` 的宽限计时器；若 2s 后子进程仍未退出（`exitCode`/`signalCode` 均空）则 `SIGTERM`。**幂等**：`requested` 标志后重复调用直接返回，永不重复发信号。
- **kill 兜底可收尾**：`child.once('close')` 时，**仅当 `cancelHandle.requested` 为真**，把仍在途的请求以 `StoreError('NATIVE_ACP_CANCELLED', …, 502)` 拒绝——避免「代理忽略 cancel → 进程被 SIGTERM → 请求悬挂到 120s 超时」；非取消路径（意外死亡）**保持既有行为逐字不变**，故 spawn 失败负例仍拿到 `NATIVE_ACP_ERROR`。
- **`nativeCancelPlan({ executionId, engineRef })`**：`action:'native.session.cancel'`、`target = engineRef.id`（即 `<source>:<nativeSessionId>`）、`parameters = { executionId, target }`、`parametersDigest` 覆盖该二者、`requiresApproval:true`。缺 `executionId`/`engineRef.id` 抛 `NATIVE_CANCEL_PLAN_INVALID`（400）。
- **`cancelNativeExecution({ store, executionId, approvalId, idempotencyKey, requireOperator })`**（对齐 `cancelCezarExecution` 的顺序）：
  1. `getExecution`（缺 → `EXECUTION_NOT_FOUND` 404）；
  2. `engineRef.engine !== 'native-acp'` → `NATIVE_REF_REQUIRED`（409）；
  3. 缺 `approvalId` → `APPROVAL_REQUIRED`（403）；
  4. **已终态**（`succeeded/failed/cancelled/blocked`）→ **幂等返回** `{ replay:true, alreadyTerminal:true, cancelled:status==='cancelled', liveProcess:false, delivered:false, execution, outcome:'execution is already …; no cancel was performed' }`（**不消费审批、不伪造 kill**）；
  5. 非终态且无在途进程、且状态不属 `{queued, running}`（如 `verifying`/`reviewing`）→ `EXECUTION_NOT_CANCELLABLE`（409）**如实拒绝**（不强行非法转移）；
  6. `consumeApproval(approvalId, { action, target, parametersDigest }, { idempotencyKey:':approval', requireOperator })`；
  7. 在途 → `handle.cancel()`；不在途但 `status==='running'` → 诚实 outcome **`no live process found; marked cancelled from store state (no process kill was performed)`**；
  8. `updateExecutionStatus(executionId, { status:'cancelled', outcome }, { idempotencyKey:':cancel' })`。

  返回 `{ replay:false, alreadyTerminal:false, liveProcess, delivered, execution, outcome }`。
- **在途 prompt 被取消时的结果路径诚实**：`executeNativeSessionPrompt` 收到 `result.stopReason === 'cancelled'` 时**不进入 VERIFYING**——写一条 `message` 证据（`native ACP prompt was cancelled (stopReason=cancelled)`）后转 `cancelled`，返回 `{ …, stopReason:'cancelled', cancelled:true }`；若被 SIGTERM 强杀，catch 到 `NATIVE_ACP_CANCELLED` 也如实转 `cancelled`（**不是 `blocked`、不谎报完成**）。取消侧与执行侧都写 `cancelled`，谁先写谁生效，另一方为同状态幂等 no-op（两处幂等键不同：执行侧 `:<step>`、取消侧 `:cancel`）。

### 2. 三入口接线

- **gateway**：新增 `POST /api/control-plane/executions/:id/native/cancel`，形态对齐 `POST …/cezar/cancel`（裸 `await body(req)` + `requireOperator: authority.mode==='strict'` + Idempotency-Key），返回 200。
- **authorizeHttpRequest（`request-authority.mjs:193`）**：chief 正则里 `native\/(plan|prompt)` **扩展为** `native\/(plan|prompt|cancel)`。**request-authority 其余安检逻辑逐字未动**（`nativeRemoteInput` 无改动，取消路由亦不走它——与 cezar cancel 一致）。
- **MCP `server.mjs`**：新增工具 `cancel_native_session`（required `executionId/approvalId/idempotencyKey`；schema 风格对齐 `prompt_native_session`），`callTool` 分支 `cancelNativeExecution({ ...args, store, requireOperator, idempotencyKey })`。
- **CLI `scripts/control-plane.mjs`**：新增 `native cancel` 子命令（`--execution`/`--approval`/`--idempotency`），用法串一并更新。

### 3. 测试（纯合成）

- 新增假 ACP agent `fakeCancelAgentScript({ behavior })`：`session/prompt` **阻塞在途**（并写 `PROMPT_SENTINEL`）；收到 `session/cancel` 时写 `CANCEL_SENTINEL`，`behavior:'graceful'` 回 `{ stopReason:'cancelled' }`、`behavior:'ignore'` 不回（逼迫 SIGTERM 升级）。无真实 CLI、无网络、无真实用户文件。
- 夹具：`cancelFixture`（queued execution + prompt 审批 + cancel 审批，绑定 `nativeCancelPlan` 的 engine ref id `fake:native-1`）、`idleNativeExecution`（`running` 但**无在途进程**）、`countingStore`（统计 store 方法调用次数以证明「重放不重复消费/不重复写」）、`waitFor`/`fileHas`。
- `runNativeAcpPrompt`/`executeNativeSessionPrompt` 增内部 seam `cancelGraceMs`（默认取 `NATIVE_CANCEL_GRACE_MS`，仅测试注入 150ms 加速 SIGTERM 用例；**不经任何 REST/MCP/CLI 暴露**，不在 `nativeRemoteInput` 白名单内）。

## 负例清单与原始结果

`npm run test:native-acp-executor`（**30 用例全绿**，原 20 + 新增 10）中的新增用例（原始结果：全部 pass）：

| # | 用例名 | 断言要点 | 结果 |
| --- | --- | --- | --- |
| 1 | nativeCancelPlan binds the cancel action to the native engine ref id | `action==='native.session.cancel'`、`target==='fake:native-1'`、`parameters==={executionId,target}`、digest 等于 `parametersDigest`、`NATIVE_CANCEL_GRACE_MS===2000`、缺参抛 `NATIVE_CANCEL_PLAN_INVALID` | ✔ |
| 2 | cancelNativeExecution requires a native engine ref and an approval id | 非 native engine → `NATIVE_REF_REQUIRED`；缺 approvalId → `APPROVAL_REQUIRED` | ✔ |
| 3 | …refuses an approval that does not cover the exact cancel plan | target 不符 → `APPROVAL_SCOPE_MISMATCH`；execution 仍 `running` | ✔ |
| 4 | …refuses an approval that has already been consumed | 预消费后 → `APPROVAL_ALREADY_USED` | ✔ |
| 5 | …records an honest cancelled state when there is no live process | `liveProcess:false`/`delivered:false`；outcome 匹配 `/no live process found/`；状态 `cancelled` | ✔ |
| 6 | …refuses to force a non-terminal execution with no live process | `verifying` 且无进程 → `EXECUTION_NOT_CANCELLABLE`；仍 `verifying` | ✔ |
| 7 | …on an already-terminal execution returns idempotently without consuming the approval | `replay:true`/`alreadyTerminal:true`；新审批 `usedAt===undefined`（未消费） | ✔ |
| 8 | cancelNativeExecution cancels an in-flight prompt over ACP and drains the registry | 在途注册命中 → `delivered:true`、`liveProcess:true`；fake agent 收到 `session/cancel`（哨兵文件）；prompt 结果 `stopReason:'cancelled'`、`cancelled:true`、execution `cancelled`；注册表清空 | ✔ |
| 9 | a cancel the agent ignores escalates to SIGTERM and is recorded as cancelled, never as a failure | 代理忽略 cancel → 请求以 `NATIVE_ACP_CANCELLED` 拒绝；哨兵证明 cancel 已到达；execution `cancelled`（非 `blocked`）；注册表清空 | ✔ |
| 10 | replaying a cancel never re-consumes the approval nor re-enters the kill path | 两次同幂等键：`consumeApproval` **恰 1 次**、`updateExecutionStatus` **恰 1 次**；第二次 `alreadyTerminal`/`liveProcess:false` | ✔ |

- 负例均为**合成夹具**：假 ACP agent 为测试内写的 Node 小脚本，经 `command/args` spawn；store 落在 `mkdtemp` 临时 state 目录；sandbox 为 passthrough spy（不触发真实 Seatbelt）。**无外呼、无真实 CLI、无真实用户文件**。

## 验证（全绿）

| 套件 | 命令（cwd=仓库根） | 结果 |
| --- | --- | --- |
| native-acp-executor（本批扩写） | `npm run test:native-acp-executor` | **30/30 pass，exit 0**（~2.5s） |
| control-plane（含 http + MCP 工具名 + native 回归） | `npm run test:control-plane` | **21/21 pass，exit 0** |
| runtime-policy（request-authority/approval-authority/acp-permission-broker/control-plane-lock） | `npm run test:runtime-policy` | **39/39 pass，exit 0** |
| goals（回归） | `npm run test:goals` | **74/74 pass，exit 0** |
| runtime-contract（相邻回归） | `npm run test:runtime-contract` | **14/14 pass，exit 0** |
| native-sandbox（相邻回归） | `npm run test:native-sandbox` | **20/20 pass，exit 0** |
| session-permission-broker（相邻回归） | `npm run test:session-permission-broker` | **25/25 pass，exit 0** |
| legacy-adapter（相邻回归） | `npm run test:legacy-adapter` | **14/14 pass，exit 0** |
| secret scan | `npm run audit:secrets` | **PASS：0 undispositioned credential-shaped hits** |

关键输出摘要（`npm run test:native-acp-executor`，新增 10 条）：

```
✔ nativeCancelPlan binds the cancel action to the native engine ref id
✔ cancelNativeExecution requires a native engine ref and an approval id
✔ cancelNativeExecution refuses an approval that does not cover the exact cancel plan
✔ cancelNativeExecution refuses an approval that has already been consumed
✔ cancelNativeExecution records an honest cancelled state when there is no live process
✔ cancelNativeExecution refuses to force a non-terminal execution with no live process
✔ cancelNativeExecution on an already-terminal execution returns idempotently without consuming the approval
✔ cancelNativeExecution cancels an in-flight prompt over ACP and drains the registry
✔ a cancel the agent ignores escalates to SIGTERM and is recorded as cancelled, never as a failure
✔ replaying a cancel never re-consumes the approval nor re-enters the kill path
ℹ tests 30  ℹ pass 30  ℹ fail 0
```

## 未覆盖项与诚实边界声明

- **真实 CLI 取消（未覆盖，属授权批）**：本切片**不启动任何真实 Codex/OpenCode/Agent CLI**。取消通道的端到端仅在 store + 合成 ACP agent 上验证；真实 CLI 收到 `session/cancel` 后的收尾行为、以及真实 SIGTERM 语义属**单独授权批**。
- **生产未重启**：本批**未重启任何生产服务**（gateway/launchd 未动）。运行态是否已加载新代码属部署动作，本批不做。
- **跨进程在途注册表不覆盖重启后在途**：注册表是**进程内** `Map`。control-plane 重启会丢失它——这正是既有兜底 `store.recoverOnStartup()` **一律把 `running` 标为 `blocked`** 的设计前提（本批**未改** `store.mjs`）。因此「重启后在途会话的取消」不被本通道覆盖，仍走 recover→blocked 的既有路径；跨进程取消需另起切片。
- **未新增专用 plan 端点/工具/子命令（按定稿合同枚举）**：合同对三入口只点名「cancel」一项，故本批**只加取消入口**，未加对应的 `native/cancel-plan` HTTP 路由、MCP 计划工具或 CLI `native cancel-plan`（cezar 侧有 `cezar cancel-plan`）。`nativeCancelPlan` 已**导出**：调用方可以 `parametersDigest({ executionId, target })`（`target` 即 execution 的 `engineRef.id`，可从 task 详情的 executions 读得）自行构造审批，或以程序方式调用。若需与 cezar 完全对称的计划入口，需在后续切片补。
- **同进程并发重复取消**：`handle.cancel()` **幂等**（重复调用只回 `replay:true`、不再发信号），顺序重放由「已终态幂等返回」覆盖（用例 7/10）。本批**不做跨进程并发压测**（注册表为进程内，跨进程本就找不到 handle）。
- **审批摘要不含 account/profile（沿用既有）**：`nativeCancelPlan` 的 digest 只覆盖 `{executionId, target}`，即 native cancel 的审批范围只绑定「哪个 execution + 哪个 engine ref id」。
- **`cancelGraceMs` 为内部 seam**：默认恒取 `NATIVE_CANCEL_GRACE_MS = 2000`（用例 1 断言该常量），仅测试注入更短值以加速 SIGTERM 用例；不经 HTTP/MCP/CLI 暴露，不在 `nativeRemoteInput` 白名单内。
- **不关闭项**：本包**不**关闭 P4 其余缺口（真实会话零成功、tool-call 全拒未接 broker、裸 spawn 无 OS 约束等），也不声称生产接线安全。

## 要求审计方做什么

- 按合同逐条复核本批 diff/hash/负例：① `inFlightNativeExecutions` 是否在 `spawn` 前注册、`finally` 摘除，`cancel()` 是否「先 ACP `session/cancel` 再 2s SIGTERM」且幂等；② `nativeCancelPlan` 的 action/target/digest 是否与合同一致；③ `cancelNativeExecution` 顺序是否 `getExecution → engine 校验 → approvalId → 终态幂等返回 → 非可取消拒 → consumeApproval(+requireOperator) → 在途 cancel/不在途诚实 outcome → updateExecutionStatus(cancelled)`；④ 在途被取消时 `executeNativeSessionPrompt` 是否**如实**走 cancelled（`stopReason:'cancelled'` 或 `NATIVE_ACP_CANCELLED`→`cancelled`），**不谎报完成**；⑤ `request-authority.mjs` 是否**只**动了 chief 正则一处（`native\/(plan|prompt|cancel)`，其余逐字未动）；⑥ 三入口（gateway/MCP/CLI）是否与所述一致，MCP 新工具的 `inputSchema` 是否对齐既有 native 工具；⑦ `package.json`/`store.mjs`/`dispatcher.mjs`/`contracts.mjs` 是否确未改（比对上表冻结 sha256）。
- 已知不足/需决定：真实 CLI 取消属授权批；是否需要与 cezar 对称的 native `cancel-plan` 计划入口；跨进程取消是否需要更强证据。
- 本包为 **r1 首切片**：无「未解决 Finding」；未覆盖项见上一节，均为**后续批或部署动作**，非本切片合同要求关闭的子项。
