# 执行交接包：D56 遗留——sessionRefId 与 nativeSessionId/source 的结构绑定校验（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包为 **D56 遗留**（[p4-plan-scope-sessionref-r1](./p4-plan-scope-sessionref-r1.md)「未覆盖项 · session 索引一致性接线」）的**诚实可落地部分**：把 `executeNativeSessionPrompt` 收到的 `sessionRefId` **结构化绑定**到请求的 `source`/`nativeSessionId`——防止「拿着 A 会话的 ref 指 B 会话」的混淆/误配。源码 + 纯合成测试，**不动生产、不启动任何真实 CLI、不读任何真实 CLI 目录、无外呼**。

## 批次身份与状态

- batchId / revision：p4-sessionref-consistency / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Markus 的 Personal AI OS 会话 subagent（DeepSeek 官方 V4.1 Flash，执行方）；主 Agent 定稿设计合同、复跑验收
- branch `feat/0.3.0-progress`；cwd `/Users/markus/ai-agent-cockpit`
- 已读并确认协作协议：是。本批**写入且仅写入**：`control-plane/native-acp-executor.mjs`、`tests/native-acp-executor.test.mjs`、`tests/control-plane.test.mjs`、`docs/handoffs/p4-sessionref-consistency-r1.md`（新文件）。**未触碰** `package.json`、`docs/audits/**`、`docs/plans/**`、`control-plane/contracts.mjs`、`control-plane/store.mjs`、`control-plane/session-index.mjs`、`control-plane/request-authority.mjs`、`gateway/control-plane.mjs`、`interfaces/mcp/server.mjs`、`scripts/control-plane.mjs`、`runtime/chief-tools.mjs`、任何生产服务/DB/launchd/真实用户文件/真实 CLI
- 对应：P4/B03 缺口 7（[p4-readiness-r1.md:36](./p4-readiness-r1.md)）在 D56 之后的**遗留**「session 索引一致性接线」；承接 [p4-plan-scope-sessionref-r1](./p4-plan-scope-sessionref-r1.md)（sessionRefId 进入 plan/approval scope），保持其既定语义
- 本批目标：① 新增可导出纯函数 `assertSessionRefMatches(sessionRefId, { source, nativeSessionId })`，把 ref 解析为 `session:<provider>:<native>`；② 畸形（非三段 / 前缀错 / 空段）→ **400 `SESSION_REF_MALFORMED`，零副作用**；provider 段 ≠ source 或尾部 ≠ nativeSessionId → **409 `SESSION_REF_MISMATCH`**；③ 在 `executeNativeSessionPrompt` 与 `cancelNativeExecution` 两条热路径上，于**任何效果/计费/审批消耗之前**接线。明确不做：**启动真实 Codex/OpenCode/任何真实 Agent CLI**、**在 prompt 热路径扫 CLI 目录证存在性/新鲜度**（属部署批）、GUI 占用检测（V41）、生产重启、commit/push
- **未执行任何 git 命令**（含只读）；故未取 base HEAD 与改动前旧 blob sha。审计方如需对拍，可按 branch `feat/0.3.0-progress` 自行复核。

## r1 固定来源（完整 sha256）

| 文件 | r1 sha256（完整） | 说明 |
| --- | --- | --- |
| `control-plane/native-acp-executor.mjs` | `f85c642d43384ff829aaf1755d350604a1449df8151491826c63c492d8091cc6` | 新增 `assertSessionRefMatches`；`executeNativeSessionPrompt`（plan 之后、审批之前）与 `cancelNativeExecution`（consumeApproval 之前）两处接线 |
| `tests/native-acp-executor.test.mjs` | `088a3b4ba9e7d41931e10f3c44992452c138415a0f331402113ddc88a0b3ba55` | 新增 7 用例 + 1 处既有夹具适配（40 → 47，纯合成）；`assertSessionRefMatches` 入 import 表 |
| `tests/control-plane.test.mjs` | `3c53a2f101ef366118f6cae8b616cd874a1dfbf287f954ec0475f215ac06448d` | 两个 native executor 用例的 `source` 与其 `sessionRefId` provider 对齐（**用例数不变，仍 23**；见合同 6） |
| `docs/handoffs/p4-sessionref-consistency-r1.md` | 本文件（新增） | — |
| `package.json` | `325074b22b2f9fc4127c3d6e034c55d7d5b4e4722fc92051e589c837e27f1436` | **未改**；与 D54/D55/D56 冻结值逐字相同，确认未漂移 |
| `control-plane/store.mjs` | `e255511ef936ac3acc58d6d5bf26b890b14cc895744207dc5fcd3e3023b3e688` | **未改**；与 D56 冻结值逐字相同（`SESSION_LOCKED`/`SESSION_BUSY` 及 guard 段均未动） |
| `gateway/control-plane.mjs` | `34c362d8a5975d72f44a9c3e0c67089f2c2d512adf4c8122f3ad1b0148af4e61` | **未改**；与 D56 冻结值逐字相同 |
| `control-plane/session-index.mjs` | `ea4ba6709adadcc038e7be330f6dc7d74dfcaf42423402f231d571fe32f200f2` | **未改**；只读复用其 id 约定（见合同 1） |
| `control-plane/contracts.mjs` | `1619d002a4d1f9b8e7d139822a4d42743bae07da5209d9a628da7b5b64f06abc` | **未改**；注意此值与 D56 包所记 `dc449036…` **不同**——差异来自 D56 之后的 Wave3 第 8 步（reviewer read-only，加入 `EXECUTION_ROLES`/`role`），非本批所致（本批未写此文件） |

- 无新依赖（`control-plane/native-acp-executor.mjs` 只用既有 `StoreError`；测试侧 `node:test`/`node:fs`/`node:os`/`node:path` 为内置）。

## 设计合同逐条落实

### 1. `assertSessionRefMatches`：ref 解析与结构绑定

- 约定来源：`control-plane/session-index.mjs` 六个 provider（codex/opencode/kimi/devin/workbuddy/claude，`:150`/`:178`/`:213`/`:245`/`:280`/`:338`）**统一**以 `id: \`session:${source}:${nativeId}\`` 铸造 SessionRef id；`source` 即 provider 段。本批据此定义唯一合法形状 `session:<provider>:<nativeSessionId>`。
- 解析：仅以 `session:` 前缀后的**第一个** `:` 作 provider/native 分隔——因此含 `:` 的 native id（如 `thread:2`）被逐字保留，不被误切成多段。
- 两类拒绝（按严重度分流，便于调用方据码区分）：
  - **畸形**（非字符串 / 不以 `session:` 开头 / 无 provider 分隔 / provider 段空 / native 段空）→ `StoreError('SESSION_REF_MALFORMED', …, 400)`；
  - **不匹配**（well-formed 但 provider ≠ source 或 native ≠ nativeSessionId）→ `StoreError('SESSION_REF_MISMATCH', …, 409)`。
- 匹配为**逐字相等**（`===`）：`native-1` **绝不**匹配 `native-10`（防「前段相同、后缀不同」的近似混淆）。
- 成功返回 `{ source, nativeSessionId }`（已核对的绑定），便于钉契约式断言。
- 错误码风格：`SESSION_REF_MALFORMED` / `SESSION_REF_MISMATCH` 与既有 `SESSION_REF_REQUIRED`(400)、`SESSION_BUSY`/`SESSION_LOCKED`(409) 同属 `SESSION_*` 系列。

### 2. 校验位置裁决（合同点 2）：**plan 计算之后、任何效果/计费/审批消耗之前**

**明确确认选择**：在 `executeNativeSessionPrompt` 中，`assertSessionRefMatches` 置于

```
if (!sessionRefId) throw SESSION_REF_REQUIRED(400)          // 既有
if (execution.sessionRefId !== sessionRefId) throw EXECUTION_SESSION_MISMATCH(409)   // 既有
const plan = nativePromptPlan({…})                          // 纯函数、零副作用
assertSessionRefMatches(sessionRefId, { source, nativeSessionId })   // 本批新增
if (!approvalId) throw APPROVAL_REQUIRED(403)               // 既有
… 之后才是 attachExecutionRef / updateExecutionStatus / consumeApproval / spawn
```

- 满足「sessionRefId 必填/execution 一致性检查**之后**」与「**任何效果/计费/审批消耗之前**」：其上方无任何 store 写、无 spawn；其下方的每个 store 写（attach/running/consume/evidence/状态迁移）与 spawn 都在其后。
- **选「plan 之后」而非「紧贴一致性检查」的理由**：`nativePromptPlan` 是**纯函数**（只构造对象 + `parametersDigest`，零副作用），不算「效果」；放其后可让 plan 既有的「缺 `source`/`nativeSessionId` → 400 `NATIVE_PROMPT_PLAN_INVALID`」**仍先触发**，从而只在两者**确已存在**时才判定 provider/native 关系——避免把我方「字段缺失（400）」误报成「ref 与字段不符（409）」。两种摆放都在「任何效果之前」；本批按合同点 2 显式选择并在此确认。

### 3. `executeNativeSessionPrompt` 接线

- 仅新增一行调用（见上）。对**一致**的 ref 行为不变（既有通过路径全部保留）；对**畸形** ref 抛 400、对**不匹配** ref 抛 409，均在写任何 launch intent / 消费审批**之前**，故**零副作用**（execution 保持 `queued`、`engineRef` 仍 `undefined`、审批 `usedAt` 仍 `undefined`）。
- 不改动 `nativePromptPlan` 本身：它仍是**纯生产者**（HTTP `/native/plan`、MCP `plan_native_prompt`、CLI `native plan`、`runtime/chief-tools.mjs` 的计划工具都只经它产出 plan，不产生效果）。结构绑定只在**执行热路径**（execute/cancel）强制，即效果发生之处；若误配 ref 进了 plan，其 digest 会固化误配值，执行侧仍会以 409 拦截（见未覆盖项）。

### 4. cancel 路径接线（依 D55 输入形状）

- **D55 cancel 输入形状**：`cancelNativeExecution({ store, executionId, approvalId, idempotencyKey, requireOperator })`——**不含** `sessionRefId` 入参；cancel 的 `sessionRefId` **派生自** `execution.sessionRefId`，并传入 `nativeCancelPlan({ executionId, engineRef, sessionRefId })`。
- 因此「cancel 路径同样校验」落地为：把**派生**的 `sessionRefId` 绑定到 `execution.engineRef` 的**自身** `source`/`nativeSessionId`（native 启动必写这两字段，与 `id: \`${source}:${nativeSessionId}\`` 同源）；对 D55 之前可能缺字段的旧 ref，回退为按 `engineRef.id` 的 `<source>:<native>` 拆分，使旧 ref 仍能正确绑定。
- 位置：在 `EXECUTION_NOT_CANCELLABLE` 判定之后、`nativeCancelPlan`/`consumeApproval` **之前**——故畸形/不匹配的取消**不消费审批**（零副作用），且**不**影响「终态 execution 的诚实 replay 早返回」语义（终态分支在更早处返回，不做校验）。
- `nativeCancelPlan` 自身**不变**：它对 `sessionRefId` 仍只做「非空字符串」必填（缺失 → `NATIVE_CANCEL_PLAN_INVALID` 400）；三段结构绑定由 `cancelNativeExecution` 在 plan 之前完成（`nativeCancelPlan` 入参不含 source/native，无法独立完成该绑定）。

### 5. 热路径**不**扫 CLI 目录的裁决理由

主 Agent 已否决在 prompt 热路径扫描 CLI 目录来证明「会话存在/新鲜」：

1. **延迟**：每次 prompt 都跑 `sqlite3`/文件扫描（session-index 六 provider）会给热路径引入不可控的启动延迟；
2. **隐私**：热路径会触及 `~/.codex`、`~/.claude/projects`、`~/.local/share/*` 等真实用户目录与 CLI home，扩大生产读取面；
3. **测试不可合成**：真实 CLI home 无法在离线/合成测试中复现，会迫使测试触碰真实用户文件或打桩，违背本仓库「合成夹具 only」的测试纪律；
4. **职责错位**：存在性/新鲜度属**部署批**（可在 session 注册/索引侧写入 store 后由控制面查证），不应塞进单次 prompt 的同步路径。

故本批只做**结构绑定**（shape only）：证「ref 是为本 (source, nativeSessionId) 铸造的」，**不**证「该会话此刻仍存在且最新」。此边界已写入「未覆盖项」。

### 6. 既有合成夹具的必要适配（诚实边界）

新不变量要求 `sessionRefId.provider === source` 且 `sessionRefId.tail === nativeSessionId`，据此**三处既有合成夹具**在不变更语义的前提下做了最小适配：

- `tests/native-acp-executor.test.mjs`（「an approval bound to one session cannot authorize a prompt on another session」）：原用 `sessionRefId='session:fake:A'` 配 `nativeSessionId='native-1'`（尾部 `A` ≠ `native-1`，在新不变量下会被 409）。改为 `session:fake:native-1` / 对照会话 `session:fake:native-2`——**两个会话均结构合法**，差异**只在会话**，故仍由**审批摘要**（`APPROVAL_SCOPE_MISMATCH`）解释拒绝，未被新校验抢先。用例意图不变。
- `tests/control-plane.test.mjs` 两个 native executor 用例：原 `source: 'fake'` 而其 `sessionRefId` 为 `session:codex:native-1` / `session:workbuddy:native-refusal`（provider ≠ source）。这两个用例本就带 `workerId: 'codex:native'` / `'workbuddy:native'`，故把 `source` 改为与其 ref provider、workerId **一致的** provider（`'codex'` / `'workbuddy'`）——使 `source`/`sessionRefId`/`workerId` 三者自洽，符合不变量语义。**命令仍由 `command: process.execPath` 覆盖**，`runNativeAcpPrompt` 不查 `nativeAcpCommand(source)`，故执行行为逐字不变。**用例数不变（仍 23）**。

> 说明：这两处 `source` 与 ref provider 不一致是**合成数据自身的潜在不一致**（正是本不变量要禁止的形态），非生产代码问题；生产入口（HTTP/MCP/CLI/chief-tools）的 `source` 即真实 provider，与本不变量天然一致，无需改动。

## 负例清单与原始结果

`npm run test:native-acp-executor`（**47 用例全绿**；本次新增 7）新增用例（原始结果：全部 pass）：

| # | 用例名 | 断言要点 | 结果 |
| --- | --- | --- | --- |
| 1 | assertSessionRefMatches binds a ref to the exact source/nativeSessionId, splitting malformed (400) from mismatched (409) | 一致 → 返回 `{source,nativeSessionId}`；含 `:` 的 native 逐字保留；10 种畸形（`undefined`/`null`/`42`/`''`/无前缀/两段/空 provider/空 native/大小写前缀）→ `SESSION_REF_MALFORMED`(400)；provider 不符、（含前缀的）尾不符 `native-1`↔`native-10` → `SESSION_REF_MISMATCH`(409) | ✔ |
| 2 | executeNativeSessionPrompt refuses a malformed sessionRefId as a 400 with zero store writes | 畸形 ref → 400；**spy store `events` 长度 0**（无 attach/running/consume/evidence）；execution 仍 `queued`、`engineRef===undefined`、审批 `usedAt===undefined` | ✔ |
| 3 | executeNativeSessionPrompt refuses a sessionRefId whose provider is not the request source | `session:opencode:native-1`（provider≠source）→ 409；spy store 无写入；`queued`；审批未消费 | ✔ |
| 4 | executeNativeSessionPrompt refuses a sessionRefId whose native segment is a near-miss of the requested one | `session:fake:native-10` vs `native-1`（前段相同后缀不同）→ 409；spy store 无写入 | ✔ |
| 5 | executeNativeSessionPrompt accepts a sessionRefId that structurally describes the requested session | 一致 ref → 通过并进入 `verifying`；engineRef.sessionRefId 为一致值 | ✔ |
| 6 | cancelNativeExecution refuses a stored session that does not match its engine ref, before consuming the approval | 取消已按该会话审批；仅 ref 绑定（`session:fake:other` vs engine `fake:native-1`）不符 → 409；execution 仍 `running`；审批未消费 | ✔ |
| 7 | cancelNativeExecution refuses a malformed stored sessionRefId as a 400 before any effect | 存储 ref `garbage` → 400 `SESSION_REF_MALFORMED`；execution 仍 `running`；审批未消费 | ✔ |

**同口径回归**：既有 40 个用例（原 36 + Wave3 第 8 步 reviewer read-only 的 4 个）除上表「合同 6」所述 1 处夹具适配外**全部原样通过**——包括 `executeNativeSessionPrompt refuses a sessionRefId that differs from the execution binding`（仍 `EXECUTION_SESSION_MISMATCH`）、`an approval bound to one session cannot authorize a prompt on another session`（仍 `APPROVAL_SCOPE_MISMATCH`）、`a cancel approval bound to one session cannot cancel another session`（仍 `APPROVAL_SCOPE_MISMATCH`）——证明新校验**未抢在**既有 sessionRefId/审批 session 防线之前误报。

- 负例均为**合成夹具**：假 ACP agent 为测试内写的 Node 小脚本，经 `command/args` spawn；`cwd='/tmp'`；store 落在 `mkdtemp` 的临时 state 目录；sandbox 为 passthrough spy。**无外呼、无真实 CLI、无真实用户文件、未读任何真实 CLI home**。

## 验证（全绿）

| 套件 | 命令（cwd=仓库根） | 结果 |
| --- | --- | --- |
| native-acp-executor（本批扩写） | `npm run test:native-acp-executor` | **47/47 pass，exit 0**（~3.6s） |
| control-plane（含 http + MCP 工具名 + native 回归） | `npm run test:control-plane` | **23/23 pass，exit 0** |
| runtime-policy（request-authority/approval-authority/acp-permission-broker/control-plane-lock） | `npm run test:runtime-policy` | **39/39 pass，exit 0** |
| goals（回归） | `npm run test:goals` | **74/74 pass，exit 0** |
| secret scan | `npm run audit:secrets` | **PASS：0 undispositioned credential-shaped hits** |
| runtime-tools（chief-tools 相邻回归） | `node --test tests/runtime-tools.test.mjs` | **19/19 pass，exit 0** |

关键输出摘要（`npm run test:native-acp-executor`，新增 7 条）：

```
✔ assertSessionRefMatches binds a ref to the exact source/nativeSessionId, splitting malformed (400) from mismatched (409)
✔ executeNativeSessionPrompt refuses a malformed sessionRefId as a 400 with zero store writes
✔ executeNativeSessionPrompt refuses a sessionRefId whose provider is not the request source
✔ executeNativeSessionPrompt refuses a sessionRefId whose native segment is a near-miss of the requested one
✔ executeNativeSessionPrompt accepts a sessionRefId that structurally describes the requested session
✔ cancelNativeExecution refuses a stored session that does not match its engine ref, before consuming the approval
✔ cancelNativeExecution refuses a stored sessionRefId as a 400 before any effect
ℹ tests 47  ℹ pass 47  ℹ fail 0
```

> 计数说明：任务简报记「现 36 例」，那是 Wave3 第 7 步（D56）的计数；本文件在 Wave3 第 8 步（reviewer read-only）后已增至 **40**（36 + 4）。本批 +7 → **47**。基线 40 为实测（未删改任何用例，仅新增 7 与 1 处夹具值适配）。

## 未覆盖项与诚实边界声明

- **结构绑定 ≠ 存在性/新鲜度（未覆盖，属部署批）**：本批只证「ref 是为本 `(source, nativeSessionId)` 铸造的**形状**」，**不**证「该会话此刻仍存在、未归档、未被外部改写、cwd 仍一致」。任何「ref 指向一条已删除/陈旧会话」的情形**本批不拦截**。存在性/新鲜度需在**部署批**落地（把会话注册/索引写入 store 后由控制面查证，或另起受控批），且**不得**进 prompt 同步热路径（理由见合同 5）。
- **`cwd` 不参与结构绑定**：`sessionRefId` 不含 cwd 段，故本批**不**校验「ref 的会话 cwd 与请求 `cwd` 一致」；cwd 的绑定由既有 `nativePromptPlan`（进摘要）与 store `executionGuard`（engineRef↔guard 逐项比对）承担。
- **未覆盖读取真实 CLI 索引**：本批**不读** `control-plane/session-index.mjs` 的输出，也**不**触任何真实 CLI home（`~/.codex`、`~/.claude` 等）；`session-index.mjs` 仅作「id 约定」的**只读**依据（合同 1）。真实索引 ↔ store 的接线是部署批/后续切片。
- **计划入口不做结构绑定（有意为之）**：`nativePromptPlan` 及经它的 HTTP `/native/plan`、MCP `plan_native_prompt`、CLI `native plan`、chief-tools 计划工具**仍不**校验 ref 结构（它们是纯生产者，不产生效果）。若误配 ref 进了 plan，其 digest 固化误配值，但**执行热路径会以 409 拦截**，效果不会发生。如需在计划阶段即拒，需另起切片（会波及 `runtime/chief-tools.mjs` 及其测试，因其现有合成计划数据的 `sessionRefId` 尾段与 `nativeSessionId` 不等——例如 `session:codex:synthetic` 对 `synthetic-native`）。
- **cancel 旧 ref 的回退拆分**：`engineRef` 缺 `source`/`nativeSessionId` 的**极旧** ref 依赖按 `id` 的 `<source>:<native>` 拆分；若 `id` 本身无 `:` 且无字段，将 fail-closed 为 `SESSION_REF_MISMATCH`(409)。D54/D55 之后的 native 启动均写全字段，此回退仅作兜底。
- **生产未重启**：本批**未重启任何生产服务**（gateway/launchd 未动）；`gateway/control-plane.mjs`、`interfaces/mcp/server.mjs`、`scripts/control-plane.mjs`、`runtime/chief-tools.mjs` 调用点**均未改**（executor 内部新增校验对其透明：一致输入行为不变，不一致输入将新获 409/400）。网关运行态是否已加载新代码属部署动作，本批不做。
- **不关闭项**：本包**不**关闭 P4 其余缺口（真实会话零成功、tool-call 全拒未接 broker、裸 spawn 无 OS 约束、V41 GUI 占用、**session 索引一致性接线的「存在性/新鲜度」半程**）等，也不声称生产接线安全。

## 要求审计方做什么

- 按合同逐条复核本批 diff/hash/负例：① `assertSessionRefMatches` 的解析（仅首个 `:` 分隔）与两类码（畸形 400 `SESSION_REF_MALFORMED` / 不符 409 `SESSION_REF_MISMATCH`）是否如述，且匹配为**逐字**（`native-1` ≠ `native-10`）；② `executeNativeSessionPrompt` 的接线是否在「必填/一致性检查之后、plan（纯函数）之后、**任何 store 写/审批消耗/spawn 之前**」，且畸形/不符两路均**零副作用**；③ `cancelNativeExecution` 是否在 `consumeApproval` **之前**、终态 replay 早返回**之后**接线，且 `nativeCancelPlan` 未被改动；④ 1 处 native 夹具适配与 2 处 control-plane 夹具适配是否**仅**为满足不变量、语义不变（尤其 control-plane 的 `source` 改动不改变执行行为，因 `command` 覆盖）；⑤ 未改文件（`package.json`/`store.mjs`/`gateway/control-plane.mjs`/`session-index.mjs`）是否比对上表冻结 sha256 未漂移；⑥ `contracts.mjs` 的现 sha 与 D56 包所记不同的原因是否确认为「D56 之后 reviewer read-only 批」而非本批（本批未写该文件）。
- 已知不足/需决定：**存在性/新鲜度**半程的落点（store 会话集合 vs 受控查快照）与何时立项；是否把结构绑定也前移到计划入口（会波及 chief-tools 及其测试）；`nativeCancelPlan` 是否需并入 `assertSessionRefMatches` 的「解析」部分（当前由 `cancelNativeExecution` 承担）。
- 本包为 **r1 切片**：无「未解决 Finding」；未覆盖项见上一节，均为**后续批或部署动作**，非本切片合同要求关闭的子项（存在性/新鲜度为主 Agent 明确划归部署批的边界）。
