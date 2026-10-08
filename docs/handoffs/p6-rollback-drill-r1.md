# 执行交接包：P6 迁移-回退联合演练（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包回应 P5/P6 就绪地图中"全系统一致性停写快照编排（零）""副本转换两次一致——仅记忆有"两条缺口（[p5-p6-readiness-r1.md](p5-p6-readiness-r1.md):24）的**联合验证**：把快照编排器（[p6-snapshot-orchestrator-r1.md](p6-snapshot-orchestrator-r1.md)）与版本化状态转换器（[p6-state-converter-r1.md](p6-state-converter-r1.md)）串成一条链，用一次端到端演练证明"正向转换 + 反向回退"双守守恒。按审计裁决"私有副本合成 converter、故障/回退测试可先做"放行范围施工。**本包只交付一个合成夹具演练测试 + 一个演练内最小回退函数原型，不触生产路径、不做真实快照/转换/回退。**

## 批次身份与状态

- batchId / revision：p6-rollback-drill / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；本批由该会话 subagent（deepseek-flash，官方 V4.1 Flash）实现，主 Agent 定设计合同
- 分支 / cwd：`feat/0.3.0-progress` / `/Users/markus/ai-agent-cockpit`
- 上游语境：本批是 P6 第②（快照）、③（转换）两步的**联合验收**，并**预演**第⑤步"回退冻结点"的反向路径——不新增生产能力，只把两个已交付模块的守恒在一条链上同时证成
- 本批目标：交付 `tests/migration-rollback-drill.test.mjs`（联合演练 + 回退原型 + 结构化演练报告）
- 明确不做：真实生产快照/转换/回退（属部署批）、真实 mem0/wechat 生产适配器、回退冻结点的生产编排、shadow 投影 / canary / drain、命名批次 2、生产目录读写

**铁律遵守**：全部夹具为自建 `os.tmpdir()/migration-drill-*` 合成树；**未读写任何生产/launchd/真实用户文件**（`~/.local/state/personal-ai-os/`、`~/.local/state/ai-agent-cockpit/`、`~/.wechat-acp/` 等一律未触碰）；无网络/模型/微信外呼；**未执行任何 git 命令（含只读）**；未改 `docs/audits/**`；`package.json` **仅新增一行**；未新增依赖。运行时仅依赖 `node:crypto`/`node:fs`/`node:path`/`node:sqlite` + 既有 `contracts.mjs`/`goal-store.mjs`（Node v24.15.0）。

## 固定来源（完整 sha256）

本批**消费**的上游固定来源（未修改，哈希与各自交接包一致）：

| 文件 | 行数 | sha256（完整） | 状态 |
| --- | --- | --- | --- |
| `control-plane/snapshot-orchestrator.mjs`（D64） | 598 | `9008c017711cb99ddc81b320d94cd78344318ab301e2e41877fcce94cf226a3d` | 只读消费，未改 |
| `control-plane/state-converter.mjs`（D65） | 837 | `bd445cb46a3f2258636c10fde6fd00889c80d8f6171be84b705242c911b9cb55` | 只读消费，未改 |
| `tests/snapshot-orchestrator.test.mjs` | 419 | `5f1e481c4e7d8a4bd7fe458848b5be34374c22450491a1cf78a3ebd500b22f39` | 只读复用夹具范式 |
| `tests/state-converter.test.mjs` | 467 | `15e1ad95f0e546394d89c3146c79832d923541fddff3106bb9e085e2fdef1399` | 只读复用夹具范式 |

本批**新增/改动**的文件：

| 文件 | 行数 | sha256（完整） | 状态 |
| --- | --- | --- | --- |
| `tests/migration-rollback-drill.test.mjs` | 715 | `011525da71d4ef09e5582cdcab5aab9e7ae74f21db2bf0c7ffb0cae637b7b469` | 新增 |
| `package.json` | 77 | `f9460a4de3d6ecf1e78dd54ed56b852f25376a0cfdcef9acfba99178bc9b5209` | 仅新增一行 `"test:migration-drill"`（76→77 行） |

参照但**未修改**的既有资产：`control-plane/contracts.mjs`（记录校验器）、`control-plane/store.mjs`（`{version,tasks,executions,evidence,approvals,idempotency,locks,events}` 形状与 tmp+rename+fsync 原子写惯例）、`control-plane/goal-store.mjs`（goals 形状与 `validateGoalSpec`/`goalSpecDigest`）、`services/memory/migration.py`（converter 范式）。**无新增依赖。**

## 设计合同逐条落地

### 演练链（每步断言证据，`node:test`）

1. **seed**：合成三类 store——一个 WAL 模式、带两张表（`turns`×2 行、`sessions`×1 行）的 sqlite 库；一份 0.2.2 形状的 `control-plane.json`（7 条记录，四契约集合 + 三辅助集合各 1）；一份 `goals.json`（goals/requests/events 各 1）。对**每个文件**记录 sha256 基线；对 sqlite 额外记录**内容级基线**（逐表 dump，见第 5 步）。
2. **快照**：`createSnapshotOrchestrator({ rootDir, allowRoot, now })` 注册 `memory`(sqlite)/`controlplane`(filedir)/`goals`(filedir) 三 store → `run({ runId: 'drill-run' })`。断言 `result.status === 'success'`、`manifest.status === 'success'`、`network_calls === 0`；**逐 store 复算证据**：组合摘要重算 == manifest 记录、逐文件 sha256/字节数 == 磁盘实际（哈希可复验）。**说明**：编排器的"终止成功"状态字面量是 `success`（无独立 `completed`）；设计合同散文里的"status completed"即对应它，已在断言处注明。
3. **转换**：对**快照副本**（`<run>/controlplane/control-plane.json`、`<run>/goals/goals.json`）分别跑 `convertState({ kind })` 两种 kind：断言 `written === true`、`plan.conservation.ok`、`rejected === 0`、`sourceRecords === targetRecords`、逐集合 `sourceCount === targetCount`、`manifest.twoDryRunsIdentical === true`、`verifyConversion({ targetDir }).ok`。
4. **故障注入**：把**工作区**三份 store 文件覆写为垃圾字节（sqlite 库同时移除 `-wal`/`-shm` 边车，模拟截断/丢失的库），断言内容已偏离基线——模拟迁移事故。
5. **回退**：调用演练内 `restoreStores()` 从快照目录恢复到工作位置。断言：JSON 两份 store **逐字节等于第 1 步基线**（sha256 相等）；sqlite store **内容级等于基线**——用 `dumpSqlite()`（`sqlite_master` 逐表 + 逐行稳定序列化 + 排序）逐表行比对，**不比对文件哈希**，因为快照经 `journal_mode=DELETE` 归一，文件字节会变（演练报告已如实记录"基线文件 sha ≠ 恢复文件 sha，但内容相等"，正是该设计目的的证伪性证据）。
6. **负例**：见下节。
7. **双方向守恒**：演练报告 `conservation` 段同时给出**正向**（源→转换，逐 kind 逐集合 `sourceCount`/`targetCount` 相等 + `conservation` 汇总）与**反向**（快照→恢复，sqlite 逐表 `baselineRows`/`restoredRows` 相等 + JSON 逐文件 `byteEqual`），并汇总 `bidirectional` 布尔。

### 回退实现（未来生产回退编排器的雏形）

演练内的 `restoreStores({ runDir, targets })` 是一个**最小但 fail-closed** 的回退原型，接口即为将来生产回退编排器应保持的契约（已在源码注释中固化为接口说明）：

- **两阶段、覆盖全 run**：阶段 1 只读校验**每一个** store 的证据；阶段 2 才写回。**任一不符即在写第一个字节前中止**（fail-closed），半可信的快照无法把活跃 store 恢复成半截。
- **以快照 manifest 为准**：逐文件 `sha256` + 字节数与磁盘实际重算比对，逐 store 组合摘要重导——**篡改的 manifest 或漂移的快照一律拒绝**，绝不轻信。
- **绝不静默删**：工作目标里存在、快照里没有的文件（含 sqlite 的陈旧 `-wal`/`-shm` 边车）作为 `extraFiles` **如实上报并保留原位**，交人处置。
- **原子写**：tmp + fsync + rename + 目录 fsync，与 `store.mjs`/`state-converter.mjs` 的原子写惯例一致。
- 目标映射：`sqlite` 的 `targets[name].path` 是**文件路径**（恢复快照单文件到该路径）；`filedir` 是**目录路径**（按相对路径逐文件写回）。
- 额外守卫：`manifest.status !== 'success'` → 拒绝恢复（`snapshot-not-successful`）；未知 store 无回退目标 → `no-rollback-target`；kind 不匹配 → `target-kind-mismatch`。

### 演练报告（未来回退冻结点证据的雏形）

每步的计数/哈希/判定汇总成结构化 JSON，测试内**写入 tmp（`<base>/drill-report.json`）并 `console.log` 一行** `DRILL_REPORT {…}`。报告含 `drill`/`version`/`clock`/`network_calls:0`/`steps.{seed,snapshot,conversion,faultInjection,rollback,conservation}`/`negatives[]`。

## 演练链各步原始结果

`npm run test:migration-drill`（`node --test`）原始输出（5 例全过）：

```text
✔ positive drill: snapshot -> convert -> fault -> rollback conserves the source in both directions
✔ negative: a tampered snapshot manifest is detected and the rollback is refused
✔ negative: a snapshot missing a recorded file is detected and the rollback is refused
✔ negative: an untracked new file in the rollback target is reported, never silently deleted
✔ drill report: both directions conserve the source and the report is written
ℹ tests 5  pass 5  fail 0
```

演练报告 `DRILL_REPORT` 关键行（**某一次运行的原始值**；`goals.json` 内容含 tmp 工作路径、sqlite 字节含 WAL，故其 sha 随每次运行变化，下值仅为该次证据）：

```json
{"drill":"wave5-migration-rollback-drill","version":1,"clock":1700000000000,"network_calls":0,
 "steps":{
  "seed":{"stores":[
    {"name":"memory","kind":"sqlite","sha256":"2cd8f376…618f","tables":{"sessions":1,"turns":2}},
    {"name":"controlplane","kind":"filedir","sha256":"34747773…f0fe"},
    {"name":"goals","kind":"filedir","sha256":"77cf4d3a…e95e"}]},
  "snapshot":{"status":"success","runId":"drill-run","hashesReverified":true,"stores":[
    {"name":"memory","kind":"sqlite","status":"ok","sha256":"508f9e66…3df3","bytes":20480,"files":["snapshot.sqlite"]},
    {"name":"controlplane","kind":"filedir","status":"ok","sha256":"2a786237…b256","bytes":2227,"files":["control-plane.json"]},
    {"name":"goals","kind":"filedir","status":"ok","sha256":"b4c1264e…bfa5","bytes":1642,"files":["goals.json"]}]},
  "conversion":{
    "control-plane":{"written":true,"conservation":{"ok":true,"sourceRecords":7,"targetRecords":7,"kept":7,"migrated":0,"rejected":0},"twoDryRunsIdentical":true,"verified":true,
      "collections":[tasks 1/1, executions 1/1, evidence 1/1, approvals 1/1, idempotency 1/1, locks 1/1, events 1/1]},
    "goals":{"written":true,"conservation":{"ok":true,"sourceRecords":3,"targetRecords":3,"kept":3,"migrated":0,"rejected":0},"twoDryRunsIdentical":true,"verified":true,
      "collections":[goals 1/1, requests 1/1, events 1/1]}},
  "faultInjection":{"corrupted":["memory","controlplane","goals"]},
  "rollback":{"ok":true,"runId":"drill-run","stores":[{"name":"memory","restoredFiles":1,"extraFiles":[]},{"name":"controlplane","restoredFiles":1,"extraFiles":[]},{"name":"goals","restoredFiles":1,"extraFiles":[]}],
    "jsonByteIdentical":{"controlplane":true,"goals":true},"sqliteContentIdentical":true,
    "sqliteBytes":{"baseline":"2cd8f376…618f","restored":"685f450c…3d66","bytesIdentical":false}},
  "conservation":{"forward":{"control-plane":{"ok":true},"goals":{"ok":true}},
    "reverse":{"memory":{"tables":[{"name":"sessions","baselineRows":1,"restoredRows":1},{"name":"turns","baselineRows":2,"restoredRows":2}],"contentEqual":true},
      "controlplane":{"snapshotFiles":1,"restoredFiles":1,"byteEqual":true},"goals":{"snapshotFiles":1,"restoredFiles":1,"byteEqual":true}},
    "bidirectional":true}},
 "negatives":[
  {"probe":"tampered-manifest","code":"snapshot-hash-mismatch","refused":true,"targetUnchanged":true},
  {"probe":"snapshot-file-missing","code":"snapshot-file-missing","refused":true,"targetUnchanged":true},
  {"probe":"untracked-target-file","reported":true,"fileKept":true,"trackedFileRestored":true}]}
```

**双方向守恒证据（摘要）**：正向 control-plane `7=7`（rejected 0）、goals `3=3`（rejected 0）；反向 sqlite `sessions 1=1`、`turns 2=2` 且内容相等，JSON 两份逐字节相等 → `bidirectional: true`。

## 负例（均覆盖"拒绝路径零变化 / 不静默删"）

- **篡改快照 manifest**：改写 `manifest.json` 中 `controlplane` store 记录的文件 `sha256` → 回退时重算磁盘 sha ≠ manifest 记录 → 拒绝（`snapshot-hash-mismatch`），目标文件**逐字节不变**（拒绝发生在任何写回之前）。
- **快照缺文件**：删除快照内 `goals/goals.json` → 有记录无实际 → 拒绝（`snapshot-file-missing`），目标文件不变。
- **回退目标有未盘点新文件**：工作 `goals` 目录出现快照未登记的外来文件 `stray.txt`（同时 `goals.json` 被事故破坏）→ 回退**成功**（`ok:true`）但把 `stray.txt` 记入 `extraFiles` 并**原样保留**（未删除），被追踪的 `goals.json` 仍被正确恢复。**不静默删**如实落地。

（另有仅断言在源码、未单独成例的守卫：`snapshot-not-successful`/`no-rollback-target`/`target-kind-mismatch`。）

## 验证（命令 / 通过计数，全绿）

| 命令 | 结果 |
| --- | --- |
| `npm run test:migration-drill` | **5/5 pass** |
| `npm run test:snapshot-orchestrator` | **13/13 pass** |
| `npm run test:state-converter` | **18/18 pass** |
| `npm run test:runtime-policy` | **39/39 pass**（含 `vendor/wechat-acp` build） |
| `npm run audit:secrets` | **PASS：0 undispositioned**（1742 文件扫描，7 处均为既有 disposition） |

## 偏差与诚实边界（未覆盖项）

- **真实生产快照 / 转换 / 回退属部署批，须 Markus 批准**：本批只在 `os.tmpdir()` 合成树上演练；**未对任何真实 control-plane / goals / mem0 / wechat 状态做快照、转换或回退**。真实执行须在部署批进行，且需 **Markus 明确批准 + 一致性快照前置 + 独立回退冻结点**（本测试不构成该等授权）。
- **真实 mem0 / wechat 生产适配器未做**：演练只用快照编排器内置的 `sqlite`/`filedir` 两种适配器，**未对接 mem0 backup API、wechat 实例**；生产批须注入各自 adapter。
- **回退冻结点编排未做**：`restoreStores()` 只是**单次回退函数原型**（源=一个 run 目录、目标=显式映射），**无**"冻结哪些 store、按何种拓扑/顺序回退、回退前停写、回退后校验/解冻、回退点版本命名与保留策略"等编排；这些是 P6 第⑤步生产编排，属后续批次。
- **无 24h 压测 / 长期稳定性**：未做 24 小时或周期性演练；本批是一次性夹具演练。（就绪地图中 24h 稳定性属独立门槛。）
- **演练报告是"一次运行"证据，非冻结点**：`drill-report.json` 含 tmp 路径与随运行变化的哈希（WAL 字节、含路径的 goals.json），**不可跨运行比对**；它是未来"回退冻结点证据"的**结构雏形**（给出应记录哪些域），尚非可外部复现的冻结凭证。
- **两阶段回退的原子性边界**：阶段 2 为逐文件原子写，但**跨多文件的整体原子性未提供**（无事务/无中间快照可回滚到写入前）；若阶段 2 中途进程崩溃，可能留下"部分 store 已恢复、部分未恢复"。生产编排器需补 run 级原子性或重入式恢复（本批如实标注，未实现）。
- **未做跨设备/跨文件系统 rename 边界测试**：tmp 内 staging 与目标同盘。
- **`manifest.status` 字面量差异**：设计合同散文写"status completed"，编排器实现的状态字面量为 `success`；本批以 `success` 断言并在此显式说明，未改动上游模块（遵循"不碰生产/上游"边界）。
- 真实模型/原文外呼/生产读写/原生会话/微信外发：**均未发生**；无新增依赖、无后台任务、无 launchd 变更；未执行任何 git 命令。

## 要求审计方做什么

- 复核**联合链的守恒语义**：正向（`convertState` 的 `plan.conservation` + 逐集合计数）与反向（`restoreStores` 的内容级比对）是否足以支撑"双守守恒"结论；尤其复核 sqlite **内容级相等**（逐表 dump）对"backup 归一化改变文件字节"这一事实的处理是否诚实、充分。
- 复核**回退原型的 fail-closed 强度**：两阶段（先全量校验、后写回）、manifest 为准（篡改/缺失即拒）、"未盘点文件如实上报不静默删"、原子写是否满足作为生产回退编排器雏形的边界要求；以及"跨多文件整体原子性未提供"这一诚实标注是否需在部署批前补足。
- 复核**负例覆盖**是否覆盖"拒绝路径零变化"与"不静默删"两项硬约束。
- 本包非 Grant/Approval；不授权生产快照、转换、回退、迁移、部署或物理删除。
