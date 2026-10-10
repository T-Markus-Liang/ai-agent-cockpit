# 执行交接包：V41 源码切片——native 启动时 GUI/外部占用检测的显式记录项（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包为 **V41**（[0.3.0-validation.md:51](../plans/0.3.0-validation.md)）落到 P4/B03 施工面上的**源码切片**：把 [p4-readiness-r1](./p4-readiness-r1.md) 步 7 尾部「GUI 占用检测列显式记录项」落地为 native 启动时的一次**外部占用观测 + 显式 Evidence 记录**。源码 + 纯合成测试，**不动生产、不启动任何真实 CLI、不读任何真实 CLI 目录、无外呼**。

## 批次身份与状态

- batchId / revision：p4-occupancy-probe / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Markus 的 Personal AI OS 会话 subagent（DeepSeek 官方 V4.1 Flash，执行方）；主 Agent 定稿设计合同、复跑验收
- branch `feat/0.3.0-progress`；cwd `/Users/markus/ai-agent-cockpit`
- 已读并确认协作协议：是。本批**写入且仅写入**：`control-plane/native-acp-executor.mjs`、`tests/native-acp-executor.test.mjs`、`tests/control-plane.test.mjs`、`docs/handoffs/p4-occupancy-probe-r1.md`（新文件）。**未触碰** `package.json`、`docs/audits/**`、`docs/plans/**`、`control-plane/contracts.mjs`、`control-plane/store.mjs`、`control-plane/session-index.mjs`、`control-plane/native-acp.mjs`、`control-plane/request-authority.mjs`、`gateway/control-plane.mjs`、`interfaces/mcp/server.mjs`、`scripts/control-plane.mjs`、`runtime/chief-tools.mjs`、任何生产服务/DB/launchd/真实用户文件/真实 CLI
- 对应：V41（[0.3.0-validation.md:51](../plans/0.3.0-validation.md)）；[p4-readiness-r1.md](./p4-readiness-r1.md) 步 7 尾部「GUI 占用检测列显式记录项」
- 本批目标：① `executeNativeSessionPrompt` 新增**可选**占用探测端口 `occupancyProbe({ source, nativeSessionId, cwd })`；② **缺省探针返回 `unknown`（带原因）——绝不默认 `clear`**（本机锁不冒充外部 App 锁）；③ 每次启动把探测结果落一条**独立幂等键** `<key>:occupancy` 的 Evidence（`kind:'log'`、`redacted`、summary 有界截断，含 state 与 detail）；④ 返回体带 `occupancy` 字段，`suspected` 时 outcome 文案如实提示（**不阻断、不静默**）；⑤ 探针抛错/返回无法识别状态 → 按 `unknown` 处理并如实记录错误类别，**不阻断启动**。明确不做：**真实 GUI/外部占用探测实现**、**阻断/等待策略**（产品裁决）、启动真实 Codex/OpenCode/任何真实 Agent CLI、生产重启、commit/push
- **未执行任何 git 命令**（含只读）；故未取 base HEAD 与改动前旧 blob sha。审计方如需对拍，可按 branch `feat/0.3.0-progress` 自行复核。

## r1 固定来源（完整 sha256）

| 文件 | r1 sha256（完整） | 说明 |
| --- | --- | --- |
| `control-plane/native-acp-executor.mjs` | `0ebe00c8b39b8a50a824b9dd47e1442dfe3016681487c81a90ee0f9efb80d7a8` | 新增 `occupancyProbe` 端口 + `OCCUPANCY_STATES`/`defaultOccupancyProbe`/`resolveOccupancy`/`occupancyEvidenceSummary`；`executeNativeSessionPrompt` 在 launch intent 之后、审批消费之前接线 |
| `tests/native-acp-executor.test.mjs` | `8900df9c07bd7fdfd859de42290ce7f25025941dcc38fc6bc3265d931fb851fe` | 新增 8 用例（47 → 55，纯合成）；占用符号入 import 表 |
| `tests/control-plane.test.mjs` | `863aca48ab2ece1e074e42c442748b5dd730841b01682e03e1538dca23c1b0f0` | 两个 native executor 用例的 **evidence 计数断言适配**（原 `length===1` → 按 `kind` 取 message + 断言占用记录存在；**用例数不变，仍 23**；见合同 4） |
| `docs/handoffs/p4-occupancy-probe-r1.md` | 本文件（新增） | — |
| `package.json` | `325074b22b2f9fc4127c3d6e034c55d7d5b4e4722fc92051e589c837e27f1436` | **未改**；与 D54/D55/D56 冻结值逐字相同，确认未漂移 |
| `control-plane/store.mjs` | `e255511ef936ac3acc58d6d5bf26b890b14cc895744207dc5fcd3e3023b3e688` | **未改**；与 D56 冻结值逐字相同（`addEvidence`/`#idempotent` 只读复用） |
| `control-plane/contracts.mjs` | `1619d002a4d1f9b8e7d139822a4d42743bae07da5209d9a628da7b5b64f06abc` | **未改**；与 sessionref-consistency 包所记一致（Evidence 七种 kind 与 redacted 惯例只读复用，未增删） |

- 无新依赖（`control-plane/native-acp-executor.mjs` 只用既有 `StoreError`；测试侧 `node:test`/`node:fs`/`node:os`/`node:path` 为内置）。

## 设计合同逐条落实

### 1. 占用探测端口（合同点 1）

- 新增可选端口：`occupancyProbe({ source, nativeSessionId, cwd }) → { state: 'clear'|'suspected'|'unknown', detail }`（**允许 async**）。`executeNativeSessionPrompt` 新增同名可选入参；未传（或非函数）时回退到**缺省探针**。
- **缺省探针 `defaultOccupancyProbe` 恒返回 `{ state:'unknown', detail: OCCUPANCY_PROBE_UNCONFIGURED }`**，其中 `OCCUPANCY_PROBE_UNCONFIGURED = '未配置外部占用探测'`。**绝不默认声称 `clear`**：控制面内的 `SESSION_LOCKED` / `SESSION_BUSY` 只认识**本 store 自己创建**的 execution，**不能**冒充外部 App / GUI 锁；没有证据就如实 `unknown`。
- `resolveOccupancy({ probe, source, nativeSessionId, cwd })` 是**绝不抛错**的归一化器：
  - 探针**抛错** → `{ state:'unknown', detail:\`外部占用探测失败（<code|name>）: <msg>\`, probeError:'<code|name>' }`（如实记录**错误类别**，取 `error.code ?? error.name ?? 'Error'`）；
  - 探针返回**无法识别的 state** → `{ state:'unknown', detail:…, probeError:'OCCUPANCY_PROBE_UNRECOGNIZED' }`（**fail-soft 到 unknown，绝不落到 clear**）；
  - 合法 state 原样通过；detail 缺失时按 state 填诚实默认（`clear`→'未检测到外部占用迹象'、`suspected`→'检测到可能的外部占用迹象'、`unknown`→未配置原因），**不臆造证据**。
- `OCCUPANCY_STATES = Object.freeze(['clear','suspected','unknown'])` 为唯一合法状态集。

### 2. 显式记录（合同点 2，V41「列显式记录项」）

- 每次 `executeNativeSessionPrompt` 启动时调一次探针，结果落**一条** Evidence：
  `store.addEvidence(executionId, { kind:'log', summary: occupancyEvidenceSummary(occupancy), source: \`${source}:acp\`, redacted:true }, { idempotencyKey: step('occupancy') })`。
- **独立幂等键** `step('occupancy')` = `<idempotencyKey ?? executionId>:occupancy`——与 `attach`/`running`/`approval`/`evidence`/`verifying`/`blocked` 各自独立，重放单步永不与他步碰撞。
- summary 由 `occupancyEvidenceSummary` 构造：**恒含 `state=<state>` 与 detail**，并**有界截断**到 `OCCUPANCY_SUMMARY_MAX = 300` 字符（超出以 `...` 收尾），与既有的 4000 字符 reply 摘要上限同一「有界」惯例。
- `redacted:true`、`kind:'log'`、`source:\`${source}:acp\``——沿用既有 reviewer-readonly Evidence 的惯例（`contracts.mjs` 的 Evidence 七种 kind 未动，`redacted` 默认 true 亦未动）。

### 3. 启动顺序（合同点 2/3 的「顺序」）

在 `executeNativeSessionPrompt` 内，探针 + 记录落在 **launch intent（attach + running）之后、`consumeApproval` 与 spawn 之前**：

```
(2)   attachExecutionRef(...)                    // 既有：持久启动意图
      updateExecutionStatus(running, …)          // 既有：落 running
(2b)  occupancy = resolveOccupancy({ probe: occupancyProbe, source, nativeSessionId, cwd })   // 本批新增
      addEvidence(…, { idempotencyKey: step('occupancy') })                                   // 本批新增
(3)   consumeApproval(...)                       // 既有
(4)   runNativeAcpPrompt(...)                    // 既有：spawn
```

- 满足合同「探针在 launch intent 记录之后、spawn 之前」：`running` 已落盘才观测占用；观测在审批消费与 spawn 之前。
- **探针本身失败不影响既有守恒路径**：`resolveOccupancy` 把一切异常/异形归一化为 `unknown`，**从不抛出**，故其上/其下的既有步骤（审批消费、spawn、失败转 `blocked`、cancel 通道、reviewer 只读）**原样不变**。`suspected` 亦**不阻断**（照常 spawn）。
- 观测记录本身经 `addEvidence` 写入；若该 store 写失败，与既有 `attach`/`running`/`consumeApproval` 的 store 写一样按既有失败路径处理（本批**不**把观测记录包装成「吞错」——避免静默吞掉真实 store 故障）。

### 4. 返回体与诚实文案（合同点 2）

- 启动路径的两个返回体（**取消** 与 **完成**）都新增 `occupancy` 字段（`{ state, detail[, probeError] }`）。
- `suspected` 时，终态 `outcome` 文案追加 **'；检测到可能的外部占用迹象（不阻断，仅记录）'**（完成路径的 `verifying` 与取消路径的 `cancelled` 各一处）——**不阻断、不静默**：状态如实出现在 outcome，是否据此阻断/等待**不在本批**（见未覆盖项）。
- **既有合成夹具的必要适配（诚实边界）**：`tests/control-plane.test.mjs` 两个 native executor 用例原先钉死 `evidence.length === 1`（只算 prompt 的 message 记录）。加入占用 log 后每执行新增 1 条 Evidence（占用 log + prompt message = 2）。这两处断言改为**按 `kind` 取所需记录**（`find(kind==='message')`）并**新增**一条「占用记录存在」断言——语义不变（仍验证 reply/status/拒答时的非空 message 被记录），**用例数不变（仍 23）**。其余既有断言（如 `runtime-tools`/`runtime-recovery`/`approval-authority` 的 `evidence.length === 0`）均为**未 spawn** 的路径，不受影响。

## 负例清单与原始结果

`npm run test:native-acp-executor`（**55 用例全绿**；本次新增 8）新增用例（原始结果：全部 pass）：

| # | 用例名 | 断言要点 | 结果 |
| --- | --- | --- | --- |
| 1 | the default occupancy probe answers unknown (never clear), and resolveOccupancy normalises the three states honestly | 缺省探针 == `{unknown, 未配置…}`；无探针/非函数探针 → unknown；clear/suspected/unknown 原样通过；detail 缺失填诚实默认；异形 state `maybe` → **unknown** + `OCCUPANCY_PROBE_UNRECOGNIZED`；summary 有界 ≤ 300 | ✔ |
| 2 | with no occupancy probe configured the launch records an honest unknown (never clear) | 缺省启动 → `verifying`；`result.occupancy.state==='unknown'`；恰 1 条占用记录；summary 含 `state=unknown` 与「未配置外部占用探测」；`kind==='log'`、`redacted===true`、`source==='fake:acp'` | ✔ |
| 3 | the occupancy probe receives the source, nativeSessionId and cwd of the launch | 探针收到 `{source:'fake', nativeSessionId:'native-1', cwd:'/tmp'}` | ✔ |
| 4 | a clear / suspected / unknown probe each lands its own occupancy Evidence record | 三态各落 1 条对应记录，summary 含 `state=<state>` 与各自 detail | ✔ |
| 5 | a probe that throws is recorded as unknown with the error class and never blocks the launch | 抛 `{code:'GUI_PROBE_DOWN'}` → `state==='unknown'`、`probeError==='GUI_PROBE_DOWN'`、detail 含类别与消息；**仍 spawn**（spy 事件含 spawn）；记录含错误类别 | ✔ |
| 6 | a suspected occupancy is recorded, does not block the spawn, and is surfaced in the outcome | `suspected` → `verifying`；**仍 spawn**；`outcome` 含「检测到可能的外部占用迹象」；记录含 `state=suspected` 与 detail | ✔ |
| 7 | the occupancy record is written under a dedicated idempotency key so a replay never duplicates it | 记录键 == `<key>:occupancy`；**同键同输入重放**（`addEvidence` 再调）→ `replay===true` 且记录数仍 1；整请求重放 → `EXECUTION_NOT_QUEUED`（二次 spawn/写不发生），记录数仍 1 | ✔ |
| 8 | the occupancy probe runs after the launch intent and before the approval is consumed | spy 事件序：`running` < 占用 addEvidence < `consumeApproval` < `spawn` | ✔ |

**同口径回归**：既有 47 个用例**全部原样通过**（本批未删改任何本文件既有用例，仅新增 8 条与 import 补项）。关键既有防线未被抢占：`EXECUTION_NOT_QUEUED`/`EXECUTION_SESSION_MISMATCH`/`SESSION_REF_*`/`APPROVAL_*`/`EXECUTION_SCOPE_CHANGED`/reviewer-readonly/cancel 全套仍绿。

- 负例均为**合成夹具**：假 ACP agent 为测试内写的 Node 小脚本，经 `command/args` spawn；`cwd='/tmp'`；store 落在 `mkdtemp` 的临时 state 目录；sandbox 为 passthrough spy。**无外呼、无真实 CLI、无真实用户文件、未读任何真实 CLI home**。占用探针全部为测试内联 async 函数（clear/suspected/unknown/抛错/异形），**不触任何真实 GUI/进程状态**。

## 验证（全绿）

| 套件 | 命令（cwd=仓库根） | 结果 |
| --- | --- | --- |
| native-acp-executor（本批扩写） | `npm run test:native-acp-executor` | **55/55 pass，exit 0**（~4.9s） |
| control-plane（含 http + MCP 工具名 + native 回归） | `npm run test:control-plane` | **23/23 pass，exit 0** |
| runtime-policy（request-authority/approval-authority/acp-permission-broker/control-plane-lock） | `npm run test:runtime-policy` | **39/39 pass，exit 0** |
| goals（回归） | `npm run test:goals` | **74/74 pass，exit 0** |
| secret scan | `npm run audit:secrets` | **PASS：0 undispositioned credential-shaped hits** |

关键输出摘要（`npm run test:native-acp-executor`，新增 8 条）：

```
✔ the default occupancy probe answers unknown (never clear), and resolveOccupancy normalises the three states honestly
✔ with no occupancy probe configured the launch records an honest unknown (never clear)
✔ the occupancy probe receives the source, nativeSessionId and cwd of the launch
✔ a clear / suspected / unknown probe each lands its own occupancy Evidence record
✔ a probe that throws is recorded as unknown with the error class and never blocks the launch
✔ a suspected occupancy is recorded, does not block the spawn, and is surfaced in the outcome
✔ the occupancy record is written under a dedicated idempotency key so a replay never duplicates it
✔ the occupancy probe runs after the launch intent and before the approval is consumed
ℹ tests 55  ℹ pass 55  ℹ fail 0
```

> 计数说明：基线为 sessionref-consistency 批后的 **47**（实测）。本批 +8 → **55**。既有 47 条一条未删、一条未改语义。

## 未覆盖项与诚实边界声明

- **真实 GUI / 外部占用探测实现（未覆盖，属真实 CLI 批）**：本批只提供**端口与记录**，缺省探针**恒 `unknown`**。真正的探测（例如查 GUI App 是否打开某 session、外部进程是否占用同一 cwd、系统级文件锁）**需要触碰真实 GUI/进程/用户目录**，属**独立授权批**，本批不做、不读任何真实 GUI/CLI 状态。
- **阻断 / 等待策略（未覆盖，待产品裁决）**：合同明确「是否阻断属产品决定」。本批对 `suspected` **只记录、不阻断**（照常 spawn）。若产品决定 `suspected` 应 **等待**（如重试到 clear）或应**阻断**（拒绝启动），需另起切片改 `executeNativeSessionPrompt` 的启动门（会改变既有守恒路径与多处失败终态断言）。
- **「同一 native session 或 cwd 并发」跨进程冲突验收（未覆盖，属 T06）**：本批不产生真实并发（单进程合成夹具）。跨进程 native 冲突的端到端验收（两真实 Worker 合成恢复/并发）属 **T06**；本批只保证「占用观测被显式记录」这一半程。
- **占用不进入审批摘要与 execution guard**：`occupancy` 是**观测记录**，不进 `nativePromptPlan.parameters`（进而 digest），也**不**进 `consumeApproval` 的 `executionGuard` 比对——它不构成准入条件。若将来让占用成为准入/hold 条件，需另立切片改计划与 guard 合同。
- **探针契约的宿主边界**：`occupancyProbe` 由调用方注入，本批**不**从任何生产入口（HTTP/MCP/CLI/chief-tools）解析或透传该端口；网关/MCP/CLI 调用点**均未改**（未传 → 缺省 `unknown`）。真实来源接线属后续批。
- **生产未重启**：本批**未重启任何生产服务**（gateway/launchd 未动）；`gateway/control-plane.mjs`、`interfaces/mcp/server.mjs`、`scripts/control-plane.mjs`、`runtime/chief-tools.mjs` 调用点**均未改**（executor 内部新增观测对其透明）。网关运行态是否已加载新代码属部署动作，本批不做。
- **不关闭项**：本包**不**关闭 V41 的「检测冲突或等待」的**执行/阻断半程**（仅完成「显式记录」半程），也**不**关闭 P4 其余缺口（真实会话零成功、tool-call 全拒未接 broker、裸 spawn 无 OS 约束、session 索引一致性接线的「存在性/新鲜度」半程、真实 GUI 占用探测）等，也不声称生产接线安全。

## 要求审计方做什么

- 按合同逐条复核本批 diff/hash/负例：① `defaultOccupancyProbe` 是否**恒 `unknown` 且绝不 `clear`**（本机锁不冒充外部 App 锁）；② `resolveOccupancy` 是否**从不抛错**、且抛错/异形 state **一律落到 `unknown`**（并记录错误类别）——即「broken probe 既不能伪装 clear、也不能阻断启动」；③ 占用记录是否为**独立键** `<key>:occupancy`、`kind:'log'`、`redacted:true`、summary **含 state+detail 且有界**；④ 接线顺序是否为 **launch intent（running）→ 占用记录 → consumeApproval → spawn**（用例 8），且探针失败/`suspected` **照常 spawn**（用例 5/6）；⑤ `suspected` 是否在 outcome 文案中**如实出现且不阻断**；⑥ 2 处 `control-plane.test.mjs` 断言适配是否**仅**为容纳新增的占用记录、语义不变（按 `kind` 取 message）；⑦ 未改文件（`package.json`/`store.mjs`/`contracts.mjs`）是否比对上表冻结 sha256 未漂移。
- 已知不足/需决定：`suspected` 是否应**等待**或**阻断**（产品裁决）；真实 GUI/外部占用探测实现的落点与授权批；占用是否应进入审批摘要/guard（当前有意排除）；真实跨进程并发冲突验收（T06）的立项。
- 本包为 **r1 首切片**：无「未解决 Finding」；未覆盖项见上一节，均为**后续批或部署动作/产品裁决**，非本切片合同要求关闭的子项。
