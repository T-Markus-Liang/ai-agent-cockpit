# 执行交接包：P6 shadow 投影层（control-plane + goals）（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包回应 P5/P6 就绪地图中"④ shadow 投影层（零）"这一缺口（[p5-p6-readiness-r1.md](p5-p6-readiness-r1.md):24），是迁移故事"快照 → 转换 → **shadow** → canary/drain"的**演练证据层**：把转换后的副本与**原始来源**跑同一组只读投影，输出可复验的对比报告——canary 之前的彩排。上游消费本批之前的两件资产：快照编排器（[p6-snapshot-orchestrator-r1.md](p6-snapshot-orchestrator-r1.md)，第②步）与版本化转换器（[p6-state-converter-r1.md](p6-state-converter-r1.md)，第③步，D65）。**本包只交付投影层模块 + 合成夹具测试，不触生产路径、不做真实 shadow run。**

## 批次身份与状态

- batchId / revision：p6-shadow-projection / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；本批由该会话 subagent（deepseek-flash，官方 V4.1 Flash）实现，主 Agent 定设计合同
- 分支 / cwd：`feat/0.3.0-progress` / `/Users/markus/ai-agent-cockpit`
- 上游语境：快照编排器产出"一致副本"，转换器产出"版本化转换后的副本"，本模块把"转换后的副本"与"原始来源"跑同一组只读投影并比对——P6 第④步"shadow 投影层"
- 本批目标：交付 `control-plane/shadow-projection.mjs`（shadow 投影层）+ `tests/shadow-projection.test.mjs`（tmp 合成夹具）
- 明确不做：真实生产 shadow run（属部署批）、canary/drain 编排、回退冻结点、命名批次 2、memory/wechat 的投影集、生产目录读写

**铁律遵守**：全部夹具为自建内存合成对象或 `os.tmpdir()/shadow-proj-*` 合成树；**未读写任何生产/launchd/真实用户文件**（`~/.local/state/personal-ai-os/`、`~/.local/state/ai-agent-cockpit/`、`~/.wechat-acp/` 等一律未触碰）；无网络/模型/微信外呼；**未执行任何 git 命令（含只读）**；未改 `docs/audits/**`；`package.json` **仅新增一行**；未新增依赖。运行时仅依赖 `node:crypto`（模块本身**零文件 IO**）。

## 固定来源（完整 sha256）

| 文件 | 行数 | sha256（完整） | 状态 |
| --- | --- | --- | --- |
| `control-plane/shadow-projection.mjs` | 430 | `2d12cf63f4d5bf266ea36722c7a7fb7da1296db21f4c31553cbbfbb1345a0432` | 新增 |
| `tests/shadow-projection.test.mjs` | 502 | `f48b5933a522ec1d8f30cb9a960c4491b6942eb83ddf8470ec47d794175ccac9` | 新增 |
| `package.json` | 78 | `f91339985e7b0a6c1c36f82c4d3ec131faf965f3102ab93ca296e18607c5590e` | 仅新增一行 `"test:shadow-projection"`（77→78 行） |

参照但**未修改**的既有资产：`control-plane/state-converter.mjs`（D65：转换器 + `stable()`/`fingerprint()` 规范化摘要范式）、`control-plane/snapshot-orchestrator.mjs`（D64：快照编排，`node:crypto` sha256 证据范式）、`control-plane/contracts.mjs`（六种集合形状与状态枚举）、`control-plane/goal-store.mjs`（goal 记录字段与 `GOAL_STATUSES` 状态机）、`docs/handoffs/p6-state-converter-r1.md`（本包镜像其结构与证据风格）。

## 设计合同逐条落地

### 1. `runShadowProjection({ legacyState, convertedState, kind, now?, projections? })`，`kind ∈ {'control-plane','goals'}`

- **纯函数、零文件 IO**：`legacyState`/`convertedState` 为**解析后的状态对象**；文件的读取由调用方/测试负责。模块仅 `import { createHash } from "node:crypto"`，不读环境、不外呼、不触任何生产路径。
- **内置投影集**（每 kind 一组，覆盖"可观察语义"而非逐字节）：见下"投影口径表"。control-plane 9 条、goals 5 条。
- **投影输出形状**：`{ name, status, legacyDigest, convertedDigest, match, detail? }`。digest 为 `sha256:<hex>`，即"规范化（键递归排序）序列化后的 sha256"（复用 state-converter 的 `stable()` 口径）。`match = (legacyDigest === convertedDigest)`。`match=false`（且 `status:'ok'`）时 `detail` 给出两侧各自的规范化摘要（有界截断至 2000 字符，超出附 `…(truncated N chars)`）。**绝不把 mismatch 写成 match**：`match` 严格等于两侧 digest 是否相等。
- **返回**：`{ version, kind, projections, allMatch, reportDigest, generatedAt }`。`allMatch = 非空 且 每条 status==='ok' 且 match===true`。`reportDigest` 为**全报告（除 `generatedAt`）**的 sha256——两次运行同输入（同两侧状态、同 `now`）必同 `reportDigest`；`generatedAt` 是唯一的非确定字段，被显式排除在 digest 之外。
- **fail-closed**：未知 kind → `unknown-kind`；状态不是对象（`null`/数组/标量）→ `invalid-state`；集合缺失/形状错 → `missing-collection`/`invalid-collection`；`now` 非函数、`projections` 非法（空数组/含非函数）→ `invalid-config`。全部于**任何投影运行之前**抛出。
- **可注入投影**：`projections` 为**函数数组**时**替换**内置集（为生产批留口）；函数名取 `displayName ?? name ?? projection-<i>`；签名 `(state, ctx) => value`，`ctx = { now }`。
- **单条投影抛错不拖垮整批**：该条如实落 `status:'failed'`、`match:false`、`legacyDigest/convertedDigest:null`、`detail:{side,error}`，其余投影照常运行，`allMatch=false`。

### 2. 语义容许差（口径选择，已在交接包写明）

- 投影**只读语义字段**；converted 侧合法增补的可选字段（如 `chief`/`sourceRequestId`/`role`/`verdict`/`expiresAt`/数组脚手架）不进入任何投影 → 不影响 `match`。
- 投影均为**顺序无关聚合**（计数 / 直方图 / 去重排序集合 / 数值聚合），故 map 键序变化、转换器对 map 键排序的副作用都不误报。
- 口径以"**两侧都可计算**"为准：`recoveryCount` 缺失记 0；`spec.limits` 缺失不计入合计；`nextWakeAt` 非数值不计数。两侧使用同一口径。
- **集合缺失口径**（关键裁决）：`converted` 侧任一集合缺失 → fail-closed（转换器输出恒含全部脚手架，这是可断言的不变量）；goals 两侧的 `goals/requests/events` 任一缺失 → fail-closed（goal-store 要求三者）；**control-plane 的 legacy 侧缺集合**是 0.2.2 的合法形态（转换器会补空脚手架），故**归一为空**而非拒绝——对齐 `state-converter` 的 `addedCollections` 语义。

## 投影口径表

**control-plane（9 条）**

| 投影名 | 语义 | 读取字段 | 备注 |
| --- | --- | --- | --- |
| `collectionCounts` | 七集合记录计数 | tasks/executions/evidence/approvals/locks/idempotency/events 的条数 | 记录级丢失/新增的最直接探针 |
| `taskStatusHistogram` | task 状态直方图 | `tasks[].status` | 缺失状态记 `(absent)` |
| `executionStatusHistogram` | execution 状态直方图 | `executions[].status` | 八态 |
| `approvalDecisions` | 审批 decision 分布 | `approvals[].decision` | pending/approved/rejected/expired |
| `approvalDigests` | 审批 digest 集合 | `approvals[].parametersDigest` 去重排序 | 忽略审批记录的顺序与 id |
| `idempotencyKeys` | 幂等键集合 | `idempotency` 的键（排序） | 键重命名可见 |
| `lockActivity` | lock 活跃性集合 | `locks` 键 + `expiresAt` vs 注入 `now` | 输出 `{total, active, expired}`（均排序） |
| `evidenceKinds` | evidence kind 分布 | `evidence[].kind` | 六种 kind |
| `evidenceOutcomes` | evidence exitCode/verdict 聚合 | `evidence[].exitCode` / `verdict` | `{exitCodeCount, exitCodeSum, nonZeroExitCount, verdicts{passed,failed,absent}}` |

**goals（5 条）**

| 投影名 | 语义 | 读取字段 | 备注 |
| --- | --- | --- | --- |
| `collectionCounts` | 三集合记录计数 | goals/requests/events 的条数 | 记录级丢失探针 |
| `goalStatusHistogram` | goal 状态直方图 | `goals[].status` | 七态 |
| `limitsTotals` | 预算合计 | `Σ goals[].spec.limits.maxTokens` 与 `maxIterations` | 缺失 limits 不计入 |
| `nextWakeBounds` | nextWakeAt 有界统计 | `goals[].nextWakeAt` | `{count, min, max}`；无则 `{0,null,null}` |
| `recoveryCounts` | recoveryCount 分布 | `goals[].recoveryCount`（缺省按 0） | 跨语言/桥侧投影集后续 |

> `goals` 的 `collectionCounts` 属**合同枚举之外的增益**（合同为 goals 列了 4 条），理由：没有计数就无法发现"整条记录丢失"，与 control-plane 口径一致。已在此显式标注供审计裁决。

## 负例/正例原始结果

`npm run test:shadow-projection`（`node --test`）原始输出（32 例全过）：

```text
✔ identical control-plane states on both sides: every projection matches
✔ identical goals states on both sides: every projection matches
✔ two runs on the same input produce the same reportDigest (determinism)
✔ reportDigest excludes generatedAt: changing only the clock keeps the digest
✔ control-plane: a divergence in collectionCounts flags exactly that projection
✔ control-plane: a divergence in taskStatusHistogram flags exactly that projection
✔ control-plane: a divergence in executionStatusHistogram flags exactly that projection
✔ control-plane: a divergence in approvalDecisions flags exactly that projection
✔ control-plane: a divergence in approvalDigests flags exactly that projection
✔ control-plane: a divergence in idempotencyKeys flags exactly that projection
✔ control-plane: a divergence in lockActivity flags exactly that projection
✔ control-plane: a divergence in evidenceKinds flags exactly that projection
✔ control-plane: a divergence in evidenceOutcomes flags exactly that projection
✔ goals: a divergence in collectionCounts flags exactly that projection
✔ goals: a divergence in goalStatusHistogram flags exactly that projection
✔ goals: a divergence in limitsTotals flags exactly that projection
✔ goals: a divergence in nextWakeBounds flags exactly that projection
✔ goals: a divergence in recoveryCounts flags exactly that projection
✔ a mismatch is never reported as a match, and detail is truthful
✔ reordering a map does not by itself cause a mismatch (semantic, not byte-wise)
✔ an optional field added on the converted side does not change any projection
✔ an unknown kind is refused
✔ a state that is not an object is refused
✔ a collection missing from the CONVERTED side fails closed
✔ a goals collection missing from either side fails closed
✔ a collection with the wrong shape fails closed
✔ an optionally-absent collection on the LEGACY control-plane side is tolerated
✔ invalid projection configuration fails closed
✔ an injected projection set replaces the built-ins
✔ a projection that throws is reported failed and does not abort the batch
✔ D65 integration: a real control-plane conversion projects to an all-match report
✔ D65 integration: a real goals conversion projects to an all-match report
ℹ tests 32  pass 32  fail 0
```

独立探针 `/tmp/p6-shadow-projection-probe.mjs`（只读、无文件系统/网络/模型访问）原始输出（截选，完整见运行记录）：

```json
{"realModels": false, "productionTouched": false, "filesystemTouched": false, "observations": [
 {"probe":"happy-cp","allMatch":true,"projections":9,"reportDigest":"sha256:a7dcfb5325258eaeedd3fa3f0177295d7f09c79af6f1918786a0bfbf095d58aa"},
 {"probe":"happy-goals","allMatch":true,"projections":5,"reportDigest":"sha256:0fbae1867af2492341f9ff5efc22b34c98546e9e6645f10bd67d82e3c43f4b70"},
 {"probe":"determinism","reportDigestEqualToSecond":true,"deepEqual":true},
 {"probe":"generatedAt-excluded","generatedAtDiffer":true,"reportDigestEqual":true},
 {"probe":"divergence-taskStatus","mismatches":["taskStatusHistogram"]},
 {"probe":"divergence-lockActivity","mismatches":["lockActivity"]},
 {"probe":"divergence-collectionCounts","mismatches":["collectionCounts"]},
 {"probe":"divergence-limitsTotals","mismatches":["limitsTotals"]},
 {"probe":"legacy-tolerance","allMatch":true},
 {"probe":"unknown-kind","code":"unknown-kind"},
 {"probe":"invalid-state","code":"invalid-state"},
 {"probe":"missing-collection-converted","code":"missing-collection"},
 {"probe":"invalid-collection-shape","code":"invalid-collection"},
 {"probe":"missing-collection-goals-legacy","code":"missing-collection"},
 {"probe":"now-not-function","code":"invalid-config"},
 {"probe":"empty-projections","code":"invalid-config"},
 {"probe":"throwing-projection","status":"failed","match":false,"allMatch":false,"error":"kaboom"}]}
```

负例清单（均覆盖"投影只标本项、不误报"与"fail-closed"）：

- **逐投影偏离（隔离）**：对 control-plane 的 9 条、goals 的 5 条各构造一处**仅影响本投影**的偏离（如 task 状态 `draft→planned`、lock `expiresAt` 由未来改过去、删除一个 event 只改计数、goal `maxTokens` 变化等），断言 `mismatches === [该项]`、`detail.legacy !== detail.converted`、`allMatch=false`，其余投影保持 match —— 证明"不误报"。
- **mismatch 不写成 match**：task 状态偏离时 `taskStatusHistogram.detail.legacy` 含 `draft`、`.converted` 含 `planned`，如实呈现。
- **语义而非逐字节**：map 键序反转、converted 侧增补可选字段（`chief`/`role`）→ `allMatch=true`，不误报。
- **确定性与 generatedAt 排除**：同输入两跑 `reportDigest` 相等且报告逐字节相等；仅改时钟（`now:()=>1` vs `()=>2`）时 `generatedAt` 不同而 `reportDigest` 相等。
- **fail-closed**：未知 kind → `unknown-kind`；状态非对象（null/[]/字符串/数字，两侧）→ `invalid-state`；converted 缺集合 → `missing-collection`；goals 两侧缺 events → `missing-collection`；集合形状错（`tasks:[]`）→ `invalid-collection`；`projections:[]`、含非函数、`now` 非函数 → `invalid-config`。
- **legacy 容许差**：control-plane legacy 缺 `locks`/`idempotency`（converted 补空）→ `allMatch=true`。
- **投影抛错不拖垮整批**：注入 `boom` → 该条 `status:'failed'`、`match:false`、`detail.error='kaboom'`，同批 `ok` 投影仍 match，`allMatch=false`。
- **D65 联合验证**：合成 fixture 经 `convertState` 真实转换（control-plane 缺 `locks`/`idempotency`，`addedCollections` 记为 `["idempotency","locks"]`）后读回目标文件，跑投影 → `allMatch=true`；goals 同理。

## 验证（命令 / 通过计数，全绿）

| 命令 | 结果 |
| --- | --- |
| `npm run test:shadow-projection` | **32/32 pass** |
| `npm run test:state-converter` | **18/18 pass** |
| `npm run test:runtime-policy` | **39/39 pass**（含 `vendor/wechat-acp` build） |
| `npm run audit:secrets` | **PASS：0 undispositioned**（1744 文件扫描） |
| `node /tmp/p6-shadow-projection-probe.mjs` | exit 0；正例 allMatch，8 类拒绝码与"隔离偏离"如实 |

## 偏差与诚实边界（未覆盖项）

- **真实生产 shadow run 属部署批**：本模块只对调用方显式传入的两份**已解析状态**生效，**未对接、未投影任何真实 control-plane/goals 状态库**。真实 shadow run 须在"部署批"进行，且需 **Markus 批准 + 一致性快照前置**（本模块不构成该等授权）。
- **memory / wechat 的投影集未做**：本模块仅覆盖两类 JSON 状态（control-plane、goals）。记忆库（SQLite/向量库）与微信实例的投影集涉及跨语言（Python）与桥侧状态，需另行设计并与 `snapshot-orchestrator` 的 sqilte 适配器衔接，属后续批次。
- **canary/drain 编排、回退冻结点、命名批次 2 均未做**：属 P6 第④步后半与第⑤⑥步，本批仅交付第④步的"投影层"。
- **端到端"快照→转换→shadow"自动串联未做**：本模块是纯消费者；与快照编排器/转换器的自动编排属后续（本批只保证"给两份状态即出可复验报告"）。
- **与 D65 的衔接仅用合成 fixture**：`convertState` 只对自建 tmp 合成文件运行；未对真实状态文件，未跨设备/跨文件系统。
- **`lockActivity` 的时钟语义**：依赖注入 `now`（默认 `Date.now`）。要求 `reportDigest` 字节稳定的调用方应**固定 `now`**；否则两次调用间若有锁到期，`reportDigest` 会变（属输入变化，非缺陷）。
- **`version` 字段是增益**：合同 return shape 未列 `version`，本模块写入 `shadow-projection-v1` 并纳入 `reportDigest` 覆盖，便于溯源。`goals` 的 `collectionCounts` 同属增益（见口径表脚注）。
- **未提供独立的报告复验函数**（对标 `verifyConversion`）：合同未强制；如需"从落盘报告复算 `reportDigest`"的可执行断言，可后续补 `verifyShadowReport`。
- 真实模型/原文外呼/生产读写/原生会话/微信外发：**均未发生**；无新增依赖、无后台任务、无 launchd 变更；未执行任何 git 命令。

## 要求审计方做什么

- 复核投影口径表是否恰当覆盖"可观察语义"且不越界为逐字节比对；两条**增益**（`version` 字段、goals 的 `collectionCounts`）是否可接受。
- 复核 **fail-closed 语义与 legacy 容许差的边界**：converted 缺集合拒绝、goals 两侧三集合必在、control-plane legacy 缺集合归一为空——此三分的口径是否可接受。
- 复核"**mismatch 绝不写成 match**"（含投影抛错时 `match=false`、digest 为 null）与 `detail` 的有界截断是否如实。
- 复核 **`reportDigest` 确定性**（排除 `generatedAt`；`lockActivity` 对注入时钟的依赖已声明）与规范化摘要（键递归排序）口径。
- 本包非 Grant/Approval；不授权生产 shadow run、生产状态读写、迁移、部署或物理删除。
