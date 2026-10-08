# 执行交接包：P6 版本化状态转换器（control-plane + goals）（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包回应 P5/P6 就绪地图中"③ 副本转换两次一致——仅记忆有"这一缺口（[p5-p6-readiness-r1.md](p5-p6-readiness-r1.md):24），把记忆 converter（`services/memory/migration.py`）的范式推广到 control-plane 与 goals 两类状态库，按审计裁决"私有副本合成 converter、故障/回退测试可先做"放行范围施工。**本包只交付转换器模块 + 合成夹具测试，不触生产路径、不做真实副本转换。**

## 批次身份与状态

- batchId / revision：p6-state-converter / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；本批由该会话 subagent（deepseek-flash，官方 V4.1 Flash）实现，主 Agent 定设计合同
- 分支 / cwd：`feat/0.3.0-progress` / `/Users/markus/ai-agent-cockpit`
- 上游语境：本批消费上一批快照编排器（[p6-snapshot-orchestrator-r1.md](p6-snapshot-orchestrator-r1.md)）所捕获的**同一批状态文件**；编排器负责"一致副本"，本模块负责"副本的版本化转换"，二者是 P6 第②、③步的两半
- 本批目标：交付 `control-plane/state-converter.mjs`（版本化状态转换器）+ `tests/state-converter.test.mjs`（tmp 合成夹具）
- 明确不做：真实生产副本的转换（属部署批）、shadow 投影层、canary/drain 编排、回退冻结点、命名批次 2、生产目录读写

**铁律遵守**：全部夹具为自建 `os.tmpdir()/state-conv-*` 合成树；**未读写任何生产/launchd/真实用户文件**（`~/.local/state/personal-ai-os/`、`~/.local/state/ai-agent-cockpit/`、`~/.wechat-acp/` 等一律未触碰）；无网络/模型/微信外呼；**未执行任何 git 命令**；未改 `docs/audits/**`；`package.json` **仅新增一行**；未新增依赖。转换器运行时仅依赖 `node:crypto`/`node:fs`/`node:path` + 既有 `contracts.mjs`/`goal-store.mjs`（Node v24.15.0）。

## 固定来源（完整 sha256）

| 文件 | 行数 | sha256（完整） | 状态 |
| --- | --- | --- | --- |
| `control-plane/state-converter.mjs` | 837 | `bd445cb46a3f2258636c10fde6fd00889c80d8f6171be84b705242c911b9cb55` | 新增 |
| `tests/state-converter.test.mjs` | 467 | `15e1ad95f0e546394d89c3146c79832d923541fddff3106bb9e085e2fdef1399` | 新增 |
| `package.json` | 76 | `e914ee0759625044f4bdbb99369a70947e98b7f9d4294c35bc8b96385d25330e` | 仅新增一行 `"test:state-converter"`（75→76 行） |

参照但**未修改**的既有资产：`control-plane/contracts.mjs`（记录校验器）、`control-plane/store.mjs`（control-plane 态形状 `{version, tasks, executions, evidence, approvals, idempotency, locks, events}` 与 `:183-196` tmp+rename+fsync 原子写惯例）、`control-plane/goal-store.mjs`（goals 态形状 `{version, goals, requests, events}` 与 goal 记录形状）、`services/memory/migration.py`（converter 范式）、`docs/handoffs/m01-migration-r3.md`（校验前置于写入）。

## 设计合同逐条落地

### 1. `convertState({ sourceFile, targetDir, kind, allowRoot, dryRun?, now? })`，`kind ∈ {'control-plane','goals'}`

- **校验先于一切写入**（M01 教训）：顺序为 ① 配置（`kind` 合法、`allowRoot`/`sourceFile`/`targetDir` 均为非空绝对路径、`now` 为函数、源 basename ≠ `manifest.json`）→ ② `allowRoot` 存在且为目录 → ③ 目标守恒判定（`existsSync(targetDir)` 即拒 `target-exists`；用"最近存在祖先 realpath + 补回缺失尾段"求目标的真实落点，判其是否在 `realpath(allowRoot)` 之下，否则 `target-outside-allow-root`）→ ④ 源（`lstat`：缺失/非普通文件/自身 symlink/祖先链含非豁免 symlink 分别拒 `source-missing`/`source-not-regular`/`source-symlink`）→ ⑤ 读源并算 sha256 → ⑥ `JSON.parse`（失败即 `invalid-json`）→ ⑦ 顶层形状（版本不符 `unsupported-version`，集合形状错 `invalid-shape`）→ ⑧ 逐记录转换（两遍）→ ⑨ 守恒断言 → ⑩ 只有到这一步才 `mkdir` 目标并写。**任一拒绝路径零元数据变化**（目标目录不创建）。
- **逐记录校验与处置**：control-plane 的四个契约集合分别过 `createTask`/`createExecution`/`createEvidence`/`createApproval`；`idempotency`/`locks`/`events` 三个辅助集合按记录形状结构校验。goals 的 `goals` 集合逐条按 goal-store 记录形状校验（`spec` 复用 store 自带的 `validateGoalSpec`，且 `specDigest` 必须能由 `spec` 复算——伪造/漂移的目标 fail-closed）；`requests`/`events` 结构校验。每条记录在 manifest 落 `kept`（原样）/`migrated`（列明增补字段 `addedFields`）/`rejected`（原因）。**任一记录 rejected → 整体转换失败、不写目标**（fail-closed，绝不静默丢数据）；错误对象携带 `error.plan`（含逐条 disposition 与原因）供审计取证。
- **守恒**：manifest 每集合含 `sourceCount`/`targetCount`/集合摘要 `sha256`（按身份排序的 `id\0recordDigest\n` 的 sha256）与逐条 `{id, digest, disposition, addedFields?}`；`conservation` 汇总 `kept+migrated+rejected == sourceRecords`。写盘前 `assertConservation` 再对源/目标做身份集合相等 + 逐字段"源字段不得被丢弃或改写（只可增补）"的独立比对。
- **两次 dry-run 一致**：`dryRun:true` 返回完整 `plan` 且**零写入**；真实转换内部把 plan 构建**两遍**并逐字节（`JSON.stringify`）比对，不一致即抛 `nondeterministic`；manifest 落 `twoDryRunsIdentical: true`（该声明由内置双跑证明，非空口）。
- **原子落盘**：目标状态文件与 `manifest.json` 均 tmp+`rename`（+文件与目录 fsync）；`manifest.json` 含 converter 版本、源 sha256、目标 sha256、逐条 disposition、两次 dry-run 一致性声明。目标状态文件写成与 `store.mjs#write` 相同的 `JSON.stringify(state, null, 2)`。
- **可选字段缺省不伪造**：校验器只**增补它无条件输出的字段**（`contractVersion`/`type` 戳记与 `constraints`/`acceptanceCriteria`/`executionIds` 等数组脚手架）；源记录中"缺失的新可选字段"（`chief`/`sourceRequestId`/`role`/`verdict`/`expiresAt`/`grant`/`lease`…）保持缺失 = 合法 `kept`，**绝不 migrated**。合并规则为 `{...canonical, ...source}` —— **源值恒胜**，校验器永远不能改写源字段的值。**版本戳记显式写入**：源 `contractVersion` 原值保留于输出，其观测值集合记入 `plan.sourceContractVersions`（如源为 `0` 则输出仍为 `0`，见验证用例）。

### 2. `verifyConversion({ targetDir })`（新增导出，兑现"manifest 可复验"）

只读打开目标目录：校验 manifest 的 `converterVersion`、目标文件 sha256 与实际字节一致、每集合计数与逐条 `digest` 由目标态复算一致、集合摘要一致。任何漂移即抛 `verify-failed`。这是把"manifest 可复验"从口号变成可执行断言的落地物（合同未强制导出，属增益项，已在未覆盖项标注）。

## 与 memory converter（migration.py）范式的对应关系

| converter 范式（migration.py） | 本模块对应 | 差异 |
| --- | --- | --- |
| `_source_provenance`：只读指纹化源 | 源只读 + 文件级 sha256 + 逐记录身份 digest | 源为 JSON 单文件，非 SQLite |
| `snapshot()`：WAL 一致快照，绝不裸 `cp` | **不做**——本模块消费上一批快照编排器的一致副本（单一职责） | 由 `snapshot-orchestrator.mjs` 承担 |
| `_validate_target_path`/`_check_target_alias`：写前拒绝、被拒零变化 | 配置/allowRoot/目标/源的全部校验先于任何 mkdir/写入 | 同精神；目标必须**新建**且落在显式 `allowRoot` 下 |
| `_load_manifest`/journal 仅存 digest/count/时间戳 | manifest 仅存 digest/count/disposition，**不落任何记录原文** | 同精神 |
| `_build_manifest` + `converterVersion` 漂移拒绝 | manifest 含 `converterVersion`，`verifyConversion` 拒绝版本漂移 | 同精神 |
| 逐行 `_convert_row` 的 `archived/pending/forgotten/skipped` 处置 | 逐记录 `kept/migrated/rejected` 处置 | 语义等价物（本批无 event 级重验证） |
| `verify_conservation`：字段级守恒、id 集合相等 | `assertConservation`：身份集合相等 + 源字段不得丢失/改写 | 同精神 |
| 两次 dry-run + 确定性 | 真实转换内置双跑；`dryRun` 双调逐字节一致（时间戳只来自注入 `now`） | 本批新增：双跑一致性写入 manifest 声明 |
| `_ALLOWED_MIGRATED_STATUS` 白名单 | 只允许"增补无条件字段"，不允许改写源值 | 更严：无值变更白名单，直接禁止改值 |

**一处诚实的机制发现（已固化为设计）**：`contracts.mjs` 的校验器**不拒绝未知键**——它们是"白名单投影器"，构造新对象并**丢弃**未知键（而非报错）。因此本模块不能依赖"未知键会报错"来兜底：输出采用 `{...canonical, ...source}` 让**源记录原样保留**未知/额外键（`kept` 才真的是"原样"），校验只用于判定记录是否合法。另：`createTask`/`createEvidence`/`createApproval` 在字段缺省时会用**真实墙钟** `new Date().toISOString()` 补 `createdAt`/`updatedAt`/`capturedAt`；为保证两次 dry-run 逐字节一致，本模块在调用校验器前**注入**由 `now` 派生的 `isoNow` 覆盖这些"缺省即 now"的字段，从而确定性可证。

## 负例/正例原始结果

`npm run test:state-converter`（`node --test`）原始输出（18 例全过）：

```text
✔ control-plane 0.2.2 shape: every record is kept verbatim and conservation holds
✔ goals state: every record is kept and conservation holds
✔ a record the validator must supplement is migrated, with the added fields listed
✔ the source contractVersion is preserved and its observed values recorded
✔ two dry-runs are byte-identical and write nothing
✔ the injected clock fixes the plan's timestamps
✔ corrupt JSON is refused and no target is created
✔ a wrong top-level shape / unsupported version is refused before any write
✔ a record that fails its validator rejects the whole conversion with a truthful reason
✔ a goal whose specDigest does not match its spec is rejected
✔ a duplicated identity is a conservation violation and is refused
✔ a record whose id does not match its map key is refused
✔ a symlinked source is refused without touching the tree
✔ a directory passed as the source is refused
✔ a missing source is refused
✔ a target outside the explicit allow root is refused with zero change
✔ an existing target directory is refused and left untouched
✔ invalid configuration (missing allowRoot / relative allowRoot / bad kind) fails closed
ℹ tests 18  pass 18  fail 0
```

独立探针 `/tmp/p6-state-converter-probe.mjs`（只读、仅 tmp）原始输出（每例均记录拒绝码与"目标目录是否被创建/是否逐项不变"）：

```json
{"realModels": false, "productionTouched": false, "observations": [
 {"probe":"happy","ok":true,"kept":2,"conservation":true,"verify":true,"targetSha256Match":true},
 {"probe":"dry-run","byteIdentical":true,"targetExists":false},
 {"probe":"invalid-json","code":"invalid-json","targetCreated":false},
 {"probe":"unsupported-version","code":"unsupported-version","targetCreated":false},
 {"probe":"invalid-shape","code":"invalid-shape","targetCreated":false},
 {"probe":"record-rejected","code":"record-rejected","targetCreated":false},
 {"probe":"duplicate-identity","code":"duplicate-identity","targetCreated":false},
 {"probe":"identity-key-mismatch","code":"identity-key-mismatch","targetCreated":false},
 {"probe":"source-missing","code":"source-missing","targetCreated":false},
 {"probe":"source-not-regular","code":"source-not-regular","targetCreated":false},
 {"probe":"source-symlink","code":"source-symlink","targetCreated":false},
 {"probe":"target-exists","code":"target-exists","entriesUnchanged":true},
 {"probe":"target-outside-allow-root","code":"target-outside-allow-root","targetCreated":false},
 {"probe":"invalid-config-missing-allowRoot","code":"invalid-config"}]}
```

负例清单（均覆盖"拒绝路径零元数据变化"）：

- **损坏 JSON**：`{oops` → `invalid-json`，目标目录未创建。
- **顶层形状错/版本不支持**：`version:2` → `unsupported-version`；`tasks:[]` → `invalid-shape`；目标目录均未创建。
- **记录校验失败**：Task `status:'not-a-status'` → `record-rejected`，`error.plan` 中该条 `disposition:'rejected'` 且 `reason` 含 `status`（ContractError 原文如实转述）；目标目录未创建。goals：goal `specDigest` 与 `spec` 不符 → `record-rejected`，`reason` 含 `specDigest`。
- **守恒负例（重复身份）**：control-plane `events` 数组两条记录同 `id` → `duplicate-identity`（身份集合 < 记录数，计数失衡），目标目录未创建。
- **身份键不符**：Task 记录 `id` ≠ 其 map 键 → `identity-key-mismatch`（store 恒以 `id` 作键，绝不允许漂移）。
- **源不可用**：缺失 → `source-missing`；传目录 → `source-not-regular`；文件软链 → `source-symlink`；拒后 `src` 目录项逐项不变、目标未创建。
- **目标越界/已存在**：目标在 `allowRoot` 外 → `target-outside-allow-root`；目标已存在（含 `keep.txt`）→ `target-exists`，该目录项与 `keep.txt` 字节逐项不变。
- **配置非法**：缺 `allowRoot`、相对 `allowRoot`、`kind:'carrier-pigeon'` → 均 `invalid-config`（`allowRoot` 必填且须绝对，见未覆盖项），零副作用。

## 验证（命令 / 通过计数，全绿）

| 命令 | 结果 |
| --- | --- |
| `npm run test:state-converter` | **18/18 pass** |
| `npm run test:runtime-policy` | **39/39 pass**（含 `vendor/wechat-acp` build） |
| `npm run audit:secrets` | **PASS：0 undispositioned**（1739 文件扫描，7 处均为既有 disposition） |
| `node /tmp/p6-state-converter-probe.mjs` | exit 0；正例守恒+可复验，12 条负例拒绝码与零变化如实 |

## 偏差与诚实边界（未覆盖项）

- **真实生产副本的转换属部署批**：本模块只对调用方显式传入的私有副本文件生效，**未对接、未转换任何真实 control-plane/goals 状态**。真实副本转换须在"部署批"进行，且需 **Markus 批准 + 一致性快照编排前置**（本模块不构成该等授权）。
- **shadow 投影层 / 白名单 canary + drain / 回退冻结点 / 命名批次 2 均未做**：这些是 P6 第④–⑥步，属后续批次；本批仅交付第③步"副本转换两次一致"。
- **`allowRoot` 必填写入（沿用上一批裁决）**：签名原文 `{ sourceFile, targetDir, kind, now? }` 缺独立允许根，而"目标须在调用方显式传入的允许根之下"要求它独立存在。本模块把 `allowRoot` 定为**必填**——缺失/非字符串/非绝对 → `invalid-config`（在**任何**文件系统访问之前，零副作用）；对齐 M01/RBS/snapshot-orchestrator 的 fail-closed 惯例。
- **`migrated` 的语义收窄（诚实说明）**：`migrated` 仅在"校验器必须增补其无条件输出字段"时出现（如旧记录缺 `type`/`contractVersion`/数组脚手架）；**goals 记录因 goal-store 无此类无条件增补字段，恒为 `kept` 或 `rejected`，不会出现 `migrated`**。本批用 control-plane 的一条 legacy-lite 记录固化 `migrated` 用例。
- **辅助集合（idempotency/locks/events）为结构校验**，非契约级：这四类契约记录（tasks/executions/evidence/approvals）才有 `contracts.mjs` 校验器；辅助集合只做字段存在性与类型检查（不深校验 `idempotency.result` 等不透明载荷）。
- **跨记录引用完整性未校验**：如 Task 的 `executionIds` 指向不存在的 Execution、Evidence 的 `executionId` 悬空——store 读取时亦不校验，本模块保持一致，不做引用图完整性检查。
- **`verifyConversion` 是增益导出**：合同未强制，但为兑现"manifest 可复验"而导出；其只校验**目标自洽**（目标字节 vs manifest），不比对源（源可能事后变动）。源↔目标的守恒在转换时由 `assertConservation` 保证。
- **未做跨设备/跨文件系统 rename 边界测试**：tmp 与目标同处 `os.tmpdir()`，同盘。
- 真实模型/原文外呼/生产读写/原生会话/微信外发：**均未发生**；无新增依赖、无后台任务、无 launchd 变更；未执行任何 git 命令。

## 要求审计方做什么

- 复核合同逐条落地，特别是：**"校验先于任何写入"的时序**（全部拒绝先于 mkdir/写入，零元数据变化）与**fail-closed 语义**（任一记录 rejected → 不写目标、不静默丢数据）。
- 复核 **`migrated` 语义**（只增补无条件字段、源值恒胜、可选字段不伪造、`contractVersion` 原值保留并记录）是否与记忆 converter 的"不加料"精神一致，以及上列 `migrated` 收窄是否可接受。
- 复核 **守恒**（身份集合相等 + 逐字段只增不改 + 计数平衡）与 **两次 dry-run 逐字节一致**（含对"缺省即 now 字段"注入 `isoNow` 的确定性处理）。
- 复核 `allowRoot` 必填与目标落点 realpath 判定的 fail-closed 强度。
- 本包非 Grant/Approval；不授权生产副本转换、生产状态读写、迁移、部署或物理删除。
