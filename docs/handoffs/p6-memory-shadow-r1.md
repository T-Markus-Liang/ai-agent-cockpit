# 执行交接包：P6 shadow 投影层（memory 侧，私有副本迁移链）（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包是 D67 的 memory 侧后续项：把 [p6-shadow-projection-r1.md](p6-shadow-projection-r1.md)（control-plane + goals 的 Node 版）的**报告形状与 digest 口径**逐字段对齐到 Python，为迁移链里**数据最关键的记忆库**（`ingest.sqlite` 的 `turns` 表）补上"转换后的副本 vs 原始来源"的只读投影对比。上游消费 M01 的版本化私有副本转换器（[m01-migration-r3.md](m01-migration-r3.md)，`services/memory/migration.py`，`convert()`/`snapshot()`/守恒纪律）。**本包只交付投影层模块 + 合成夹具测试，不触生产路径、不做真实 shadow run。**

## 批次身份与状态

- batchId / revision：p6-memory-shadow / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；本批由该会话 subagent（deepseek-flash，官方 V4.1 Flash）实现，主 Agent 定设计合同
- 分支 / cwd：`feat/0.3.0-progress` / `/Users/markus/ai-agent-cockpit`
- 上游语境：快照编排器产出"一致副本" → 转换器产出"版本化转换后的副本" → 本模块把"转换后的副本"与"原始来源"跑同一组只读投影并比对（P6 第④步 shadow 投影层的 memory 分支）
- 本批目标：交付 `services/memory/shadow.py`（memory shadow 投影层）+ `tests/memory_shadow_test.py`（tmp 合成夹具）
- 明确不做：真实生产记忆库 shadow run（属部署批）、canary/drain 编排、回退冻结点、命名批次 2、wechat 桥侧投影、向量库投影、生产目录读写

**铁律遵守**：全部夹具为自建 tmp 合成 SQLite（`tempfile.mkdtemp(prefix="memory-shadow-")`）；**未读写任何生产/launchd/真实用户文件**（`~/.local/state/personal-ai-os/`、`~/.wechat-acp/` 等一律未触碰）；无网络/模型/微信外呼；**未执行任何 git 命令（含只读）**；未改 `docs/audits/**`、`docs/plans/**`、`package.json`；未新增依赖（模块仅用标准库 `sqlite3`/`hashlib`/`json`，投影层本身只读）。

## 固定来源（完整 sha256）

| 文件 | 行数 | sha256（完整） | 状态 |
| --- | --- | --- | --- |
| `services/memory/shadow.py` | 447 | `abf2d3bb01cf582365da2e8667863d87cb0ce07b5bcd7884a7d6dad651d6b19f` | 新增 |
| `tests/memory_shadow_test.py` | 536 | `67be097b0fbf4629b0ef6b8a014d9c084e8554fbdd4875616381a667c14dfabd` | 新增 |

参照但**未修改**的既有资产：`control-plane/shadow-projection.mjs`（D67 Node 版：报告形状 / `stable()`→`digestOf()` 规范化口径 / match 语义 / fail-closed / `detail` 有界截断 / `reportDigest` 除 `generatedAt` 外全报告）、`services/memory/migration.py`（`72b…` 见 m01-r3 交接：`turns` 表 schema、`_migrate` 加入的六列、`snapshot()`/`convert()`/`verify_conservation()` 守恒惯例）、`services/memory/migration_preflight.py`（`_open_readonly` 只读开库范式；本模块**不**复用其路径安全校验，按合同自带 `mode=ro&immutable=1` 开库）、`services/memory/service.py`（`_migrate` 列集合 `plan/validation_status/extraction_version/quality/stored_ids/forgotten`）、`tests/memory_migration_test.py`（合成库夹具模式）、`docs/handoffs/p6-shadow-projection-r1.md`（本包镜像其结构与证据风格）。`package.json` **未改动**（sha256 `f91339985e7b0a6c1c36f82c4d3ec131faf965f3102ab93ca296e18607c5590e`，与 D67 交接一致）；测试经 `memory_*test.py` 文件名匹配**自动进联合套件**，无需新增脚本。

## 设计合同逐条落地

### 1. `run_shadow_projection(legacy_db, converted_db, *, now=None, projections=None) -> dict`

- **两个 sqlite 路径都以只读打开**：URI `file://<abs>?mode=ro&immutable=1`；`mode=ro` 拒绝任何写入，`immutable=1` 声明文件不可变（冻结副本或其未被触碰的原始来源），跳过加锁且**不产生 `-wal`/`-shm`/`-journal` 侧车**。源库永不写、永不 chmod、永不备份。全程一次性把行读入内存后立即关连接。
- **内置投影集（`turns` 表语义，7 条）**：见下"投影口径表"。
- **报告形状逐字段对齐 Node 版**：`{ version, kind:'memory', projections:[{name,status,legacyDigest,convertedDigest,match,detail?}], allMatch, reportDigest, generatedAt }`；`version` 与 Node 同为 `"shadow-projection-v1"`（同口径，`kind` 区分两类报告，供同一工具链识别）。投影输出 `status ∈ {'ok','failed'}`；digest 为 `sha256:<hex>`，即"规范化（键递归排序）序列化后的 sha256"；`match = (legacyDigest == convertedDigest)`。**唯一增益参数**：可选 `projections=`（见合同"正交说明"）——Node 版有此注入缝，本版对齐以支撑"投影抛错隔离"测试与部署批的真实投影替换。
- **digest 规范化口径**：`_stable()` 复刻 Node `stable()`——对象键递归排序，数组保序（投影本身顺序无关），标量用 JSON 文本；`_scalar()` 处理 JS 无 int/float 之分（整值浮点 `1.0`→`"1"`）、`NaN/±Inf→null`、字符串 `ensure_ascii=False`。跨语言等价由独立探针实证（见下"与 Node 版口径对照"）。
- **`reportDigest` 除 `generatedAt` 外全报告**：即 `sha256(stable({version,kind,projections,allMatch}))`；两次运行同输入（同两侧库、同 `now`）必同 `reportDigest`；`generatedAt` 是唯一非确定字段，被显式排除。`generatedAt` 形如 JS `toISOString`（`YYYY-MM-DDTHH:MM:SS.sssZ`）。
- **fail-closed**：文件缺失 → `missing-db`；非 sqlite/不可读 → `not-a-database`；缺 `turns` 表 → `missing-turns`；`turns` 缺基线列（`event_id/payload/digest/status/created_at`）→ `missing-columns`；路径非法 → `invalid-path`；`now` 非有限毫秒数、`projections` 为空或含非可调用 → `invalid-config`。以上**均在任何投影运行之前**抛出。
- **单条投影抛错不拖垮整批**：该条如实落 `status:'failed'`、`match:false`、`legacyDigest/convertedDigest:null`、`detail:{side,error}`（error 截 300 字符），其余投影照常运行，`allMatch=false`。**mismatch 永不误报 match**。
- **确定性**：同输入两跑报告逐字节相等、`reportDigest` 相同；`now` 注入（callable 返回毫秒，或直接给毫秒数）。

**正交说明（需审计裁决）**：`projections=` 是合同签名 `run_shadow_projection(legacy_db, converted_db, *, now=None)`**之外**的一个可选关键字，用于（a）支撑"投影抛错隔离"负例、（b）为部署批留真实投影替换缝——与 Node 版 `projections` 缝语义一致（非空可调用列表**替换**内置集，名字取 `displayName ?? __name__ ?? projection-<i>`）。若审计要求严格贴合合同签名，可移除，改由 `unittest.mock.patch` 注入抛错。

## 投影口径表（memory / turns 表，7 条）

| 投影名 | 语义 | 读取 | 备注 |
| --- | --- | --- | --- |
| `statusHistogram` | status 直方图 | `turns.status` | **转换敏感**：`done` 用户行经转换→`pending`，会如实偏离（见下"联合验证"）。缺失记 `(absent)` |
| `validationStatusHistogram` | validation_status 分布 | `turns.validation_status` | 列缺失或 NULL 均记 `(absent)`（0.2.2 形源库与加列后仍 NULL 的副本都算 `(absent)`） |
| `forgottenCount` | 已遗忘计数 | `turns.forgotten`（列缺失按 0） | **转换敏感**：命中墓碑的行会被转换器额外遗忘 → 副本计数可 ≥ 源 |
| `extractionVersionHistogram` | extraction_version 分布 | `turns.extraction_version` | 列缺失或 NULL 均记 `(absent)` |
| `eventsPerUser` | 每 user_id 事件计数 | `payload` JSON 的 `user_id` | 坏行（非 JSON / 非对象）如实计入 `unparseable` 桶；有效对象无 `user_id` → `(absent)` 桶。payload 被守恒，故转换不变 |
| `createdAtBounds` | created_at 有界统计 | `turns.created_at` | `{count,min,max}`；仅计有限数值；无则 `{0,null,null}`。created_at 被守恒，故转换不变 |
| `digestSet` | digest 列集合相等性 | `turns.digest` 去重排序 | 忽略行序与 event_id；payload 守恒 ⇒ digest 守恒，故转换不变 |

> 前四条为"可观察状态"投影，后三条为"**守恒不变量**"投影（payload/digest/created_at 由 `verify_conservation` 保证不变）。这一区分是 memory 侧与 Node 侧最本质的口径差异——**见下节**。

## 与 Node 版的口径对照

| 维度 | Node 版（control-plane/goals） | 本 memory 版 | 一致性 |
| --- | --- | --- | --- |
| 报告字段 | `{version,kind,projections,allMatch,reportDigest,generatedAt}` | 同 | ✅ 逐字段对齐 |
| `version` | `"shadow-projection-v1"` | 同字符串 | ✅ 同口径 |
| 投影字段 | `{name,status,legacyDigest,convertedDigest,match,detail?}` | 同 | ✅ |
| digest | `sha256(stable(v))`，`stable` 键递归排序 | 复刻 `stable`（含整值浮点/NaN/字符串转义） | ✅ 跨语言实证一致 |
| `reportDigest` | 除 `generatedAt` 外全报告 | 同 | ✅ |
| `detail`（ok+mismatch） | `{legacy,converted}` 两侧规范化摘要，有界截断 2000 字符 + `…(truncated N chars)` | 同 | ✅ |
| `detail`（failed） | `{side,error}`，error 截 300 | 同 | ✅ |
| `allMatch` | `非空 且 全 ok 且全 match` | 同 | ✅ |
| 输入 | 两个**已解析的状态对象**（零文件 IO） | 两个**sqlite 路径**（只读开库，唯一 IO） | ⚠️ 有意差异：memory 是库文件而非 JSON，故读盘是本模块职责 |
| fail-closed 码 | `unknown-kind/invalid-state/missing-collection/invalid-collection/invalid-config` | `missing-db/not-a-database/missing-turns/missing-columns/invalid-path/invalid-config` | ⚠️ 语义等价、码名适配库形态 |
| 转换语义 | 转换器**加性**（补脚手架/可选字段）⇒ 投影不变 | 转换器**变换性**（改 status/validation/forgotten/extraction）⇒ 状态投影会如实偏离 | ⚠️ 见"联合验证与关键裁决" |

**跨语言 digest 实证**：独立探针把 7 个代表值（整数直方图、保序数组、含整值浮点的 `createdAtBounds`、`(absent)` 桶、`0`、`[]`、嵌套对象）分别喂给 Python `shadow._fingerprint` 与 Node 内联复刻的 `stable()`，**两侧 sha256 逐一相等**（见负例原始结果 `cross-language-stable.allEqual=true`）。即"同值 ⇒ 同 digest"在两种语言间成立。

## 负例/正例原始结果

### (a) 单元套件

`tests/memory_shadow_test.py` 23 例全过（正例 + 逐投影隔离 + fail-closed + 注入隔离 + 只读 + 联合验证）：

```text
HappyPathTests
  ✔ test_identical_databases_all_match
  ✔ test_same_input_same_reportDigest
  ✔ test_reportDigest_excludes_generated_at
  ✔ test_now_accepts_a_plain_number
  ✔ test_projection_values_are_order_independent
  ✔ test_created_at_bounds_shape
  ✔ test_created_at_bounds_empty
IsolationTests
  ✔ test_each_projection_flags_exactly_its_own_divergence   (7 subtests，每投影一处偏离)
  ✔ test_a_mismatch_is_never_reported_as_a_match_and_detail_is_truthful
EventsPerUserTests
  ✔ test_bad_payloads_are_counted_in_the_unparseable_bucket
  ✔ test_identical_dbs_with_bad_payloads_still_match
InjectionTests
  ✔ test_injected_projections_replace_the_builtins
  ✔ test_a_throwing_projection_is_isolated_and_never_a_match
InvalidConfigTests
  ✔ test_empty_projections_is_refused
  ✔ test_non_callable_projection_is_refused
  ✔ test_bad_now_is_refused
FailClosedTests
  ✔ test_missing_file_is_refused
  ✔ test_not_a_database_is_refused
  ✔ test_missing_turns_table_is_refused
  ✔ test_missing_baseline_columns_is_refused
ReadOnlyTests
  ✔ test_neither_database_is_mutated
ConverterIntegrationTests
  ✔ test_real_conversion_of_a_no_op_fixture_projects_all_match
  ✔ test_real_conversion_surfaces_the_intended_status_transformation
Ran 23 tests ... OK
```

- **逐投影隔离**：对 7 条投影各构造一处**仅影响本投影**的偏离（status `done→pending`；validation_status 置值；forgotten `0→1`；extraction_version 置值；payload `user_id` 改名而 digest 列固定；created_at 由 10→99；digest 列改值而 payload 固定），断言 `mismatches == [该项]`、`detail.legacy != detail.converted`、`allMatch=false`，其余投影保持 match —— 证明"不误报"。
- **mismatch 不写成 match**：status 偏离时 `detail.legacy` 含 `done`、`detail.converted` 含 `pending`，如实呈现。
- **坏行如实**：`unparseable` 桶（非 JSON、非对象）2 行 + `(absent)` 桶（有效对象无 user_id）1 行，三者同库仍 allMatch（两侧 payload 逐字节相同）。
- **fail-closed**：缺文件 → `missing-db`；非 sqlite → `not-a-database`；缺 `turns` 表 → `missing-turns`；`turns` 缺基线列 → `missing-columns`；`projections:[]`、含非可调用、`now` 非数 → `invalid-config`。
- **投影抛错不拖垮整批**：注入 `boom` → 该条 `status:'failed'`、`match:false`、`detail={side:'legacy',error:'kaboom'}`，同批 `row_count` 仍 match，`allMatch=false`。
- **只读**：一次投影后两侧库字节逐字节不变，且无 `-journal`/`-wal`/`-shm` 侧车生成。

### (b) 独立探针 `/tmp/p6-memory-shadow-probe.py`（只读、无文件系统外写/网络/模型/git）原始输出（节选）

```json
{"realModels": false, "productionTouched": false, "networkCalls": 0,
 "gitCommands": 0, "observations": [
 {"probe":"happy","allMatch":true,"projections":7,
  "reportDigest":"sha256:0ee428ec621e13359c322c07660439cafeaf18e845ed4b63d0bb4b4d9c2599f3",
  "generatedAt":"2023-11-14T22:13:20.000Z"},
 {"probe":"divergence-status","allMatch":false,"mismatches":["statusHistogram"]},
 {"probe":"determinism","reportDigestEqual":true,"equalReport":true},
 {"probe":"generatedAt-excluded","generatedAtDiffer":true,"reportDigestEqual":true},
 {"probe":"failclosed-missing-db","code":"missing-db"},
 {"probe":"failclosed-missing-turns","code":"missing-turns"},
 {"probe":"failclosed-not-a-database","code":"not-a-database"},
 {"probe":"throwing-projection","allMatch":false,"failed":["boom"],"error":"kaboom"},
 {"probe":"cross-language-stable","nodeOk":true,"allEqual":true,
  "node":  ["beeb152a…","f1d7b7b3…","a2864c3a…","3d0c207d…","5feceb66…","4f53cda1…","7f4b46eb…"],
  "python":["beeb152a…","f1d7b7b3…","a2864c3a…","3d0c207d…","5feceb66…","4f53cda1…","7f4b46eb…"]}]}
```

（`cross-language-stable` 的 7 对哈希完整相等，上文缩略显示。）

## 联合验证与关键裁决（需审计裁决）

M01 转换器是**变换性**转换器（`done` 用户行→`pending`、assistant 行→归档、命中墓碑→`forgotten`），与 Node 侧**加性**转换器不同。因此：

- **allMatch 夹具**：`test_real_conversion_of_a_no_op_fixture_projects_all_match` 用**分类无操作**的 0.2.2 形源库（非 done 的 user 行 + 未知 role 行）走**真实** `migration.convert()` 全路径（snapshot→manifest→加列→守恒），副本对源 allMatch。此夹具证明"给真实转换路径即可产出全绿彩排报告"。
- **变换如实呈现**：`test_real_conversion_surfaces_the_intended_status_transformation` 用 done 用户行 → 副本经转换变 `pending`，断言 **恰 `statusHistogram` 一条** match=false，而三条守恒不变量投影（`digestSet`/`eventsPerUser`/`createdAtBounds`）及 `validationStatusHistogram`/`extractionVersionHistogram`/`forgottenCount` 仍 match —— 证明投影层**如实暴露**转换器对状态的预期改动，而非误报或漏报。

**裁决请求**：memory 侧的"状态类"投影（status/validation/forgotten/extraction）本质是**转换敏感**的；对**真实 0.2.2 生产数据**（多为 `status='done'` 遗留回执）跑 shadow 时，`statusHistogram` 等**会**如实偏离。这是**正确行为**（转换确实改了状态），但意味着"真实生产记忆库 shadow allMatch"并**不**成立——只有守恒不变量投影会全 match。审计需确认：(1) 是否需要为生产 shadow 定义"预期变换白名单"（如 `done→{pending,done,forgotten}` 视为预期）；(2) 当前"如实偏离"的口径是否可作为 r1 交付口径。

## 验证（命令 / 通过计数，全绿）

| 命令 | 结果 |
| --- | --- |
| `.venv-memory/bin/python -m unittest discover -s tests -p 'memory_shadow_test.py' -v` | **23/23 OK**（新增） |
| `.venv-memory/bin/python -m unittest discover -s tests -p 'memory_*test.py'` | **305/305 OK**（282 原用例不回归 + 23 新用例） |
| `npm run audit:secrets` | **PASS：0 undispositioned**（1747 文件扫描；7 条已裁定） |
| `.venv-memory/bin/python /tmp/p6-memory-shadow-probe.py` | exit 0；正例 allMatch、4 类拒绝码、抛错隔离、跨语言 digest 全等 |

## 偏差与诚实边界（未覆盖项）

- **真实生产记忆库 shadow 属部署批**：本模块只对调用方显式传入的两条 sqlite 路径生效，**未对接、未投影任何真实 `~/.local/state/personal-ai-os/mem0/ingest.sqlite`**。真实 shadow run 须在"部署批"进行，且需 **Markus 批准 + 一致性快照前置**（本模块不构成该等授权）。
- **wechat 桥侧投影未做**：微信实例的桥侧状态投影涉及另一套库/形状，属后续批次。
- **向量库投影未做**：本模块只投影 `turns` 表（关系库）。向量库（mem0 的 `vectors` 目录）**不是** SQLite，其语义（列名、元数据、幂等键、删除一致性）需**另列**设计，不得硬套 `turns` 投影口径。
- **`statusHistogram` 等状态投影对真实数据会偏离**：见上"联合验证与关键裁决"；本包按"如实呈现"交付，预期变换白名单未定义（待裁决）。
- **`projections=` 增益参数**：合同签名之外的注入缝（对齐 Node），已在"正交说明"标注待裁决。
- **`version` 字段与 Node 共用字符串**：`"shadow-projection-v1"`，`kind` 区分。未新增独立 memory 版本号（保持跨语言同口径）。
- **`now` 的时区/格式**：`generatedAt` 用 UTC、毫秒 3 位 + `Z`，对齐 JS `toISOString`。要求 `reportDigest` 字节稳定的调用方应固定 `now`。
- **未提供独立的报告复验函数**（对标 `verifyConservation`）：合同未强制；如需"从落盘报告复算 `reportDigest`"的可执行断言，可后续补 `verify_shadow_report`。
- **跨语言 digest 等价**只证了投影值域（整数/浮点/字符串/数组/嵌套对象/空）的代表样本；未证 `user_id` 含**代理对（astral）字符**时 Python（码点序）与 JS（UTF-16 序）的键排序差异（本包夹具用 ASCII 键，未触发；如需支持 emoji user_id 需另行处理排序口径）。
- 真实模型/原文外呼/生产读写/原生会话/微信外发：**均未发生**；无新增依赖、无后台任务、无 launchd 变更；未执行任何 git 命令。

## 要求审计方做什么

- 复核 **7 条投影口径表**是否恰当覆盖 `turns` 表"可观察语义"，特别是"守恒不变量投影 vs 转换敏感投影"的划分是否恰当。
- 裁决上文**"联合验证与关键裁决"**：真实生产数据下状态投影如实偏离是否符合预期；是否需要"预期变换白名单"。
- 复核 **fail-closed 码语义**（库形态适配 `missing-db/not-a-database/missing-turns/missing-columns`）与 **`detail` 有界截断**（2000 字符 + `…(truncated N chars)`；error 300 字符）是否如实。
- 复核 **`reportDigest` 确定性**（排除 `generatedAt`）与**跨语言规范化口径**（探针已实证代表样本一致）。
- 复核 **`projections=` 增益参数**与 **`version` 共用字符串**两处增益是否可接受。
- 本包非 Grant/Approval；不授权生产记忆库读写、真实 shadow run、迁移、部署或物理删除。
