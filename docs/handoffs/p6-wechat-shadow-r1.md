# 执行交接包：P6 shadow 投影层（wechat 桥侧，四类 store 之一）（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包是 P6 shadow 投影层的**第四类、也是最后一类 store**：继 [p6-shadow-projection-r1.md](p6-shadow-projection-r1.md)（D67：control-plane + goals，Node 版）与 [p6-memory-shadow-r1.md](p6-memory-shadow-r1.md)（D68：memory 库，Python 版）之后，把同一**报告形状与 digest 口径**逐字段对齐到 **wechat 桥侧的三个文件型 store**（`incoming-receipts/`、`reply-outbox/`、`submission-registry/`）。迁移故事"快照 → 转换 → **shadow** → canary/drain"的彩排步在此覆盖到桥侧：把"转换后的副本"与"原始来源"两个桥状态根跑同一组只读投影并比对。**本包只交付投影层模块 + 合成夹具测试，不触生产路径、不做真实 shadow run、不接真实微信。**

## 批次身份与状态

- batchId / revision：p6-wechat-shadow / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；本批由该会话 subagent（deepseek-flash，官方 V4.1 Flash）实现，主 Agent 定设计合同
- 分支 / cwd：`feat/0.3.0-progress` / `/Users/markus/ai-agent-cockpit`
- 上游语境：快照编排器产出"一致副本" → 转换器产出"版本化转换后的副本" → 本模块把两个**桥状态根**跑同一组只读投影并比对（P6 第④步 shadow 投影层的 wechat 桥侧分支）
- 本批目标：交付 `vendor/wechat-acp/src/storage/shadow-projection.ts`（桥侧 shadow 投影层）+ `vendor/wechat-acp/tests/shadow-projection.test.ts`（tmp 合成夹具）
- 明确不做：真实生产桥状态 shadow run（属部署批）、桥状态快照适配器（属编排器生产批）、canary/drain 编排、回退冻结点、命名批次 2、向量库投影、生产目录读写

**铁律遵守**：全部夹具为自建 tmp 合成桥状态根（`os.tmpdir()/wechat-shadow-*`，内含三个合成子目录）；**未读写任何生产/launchd/真实用户文件**（`~/.wechat-acp/` 与 `~/.local/state/personal-ai-os/` 等一律未触碰）；**未接真实微信、未发真实消息**；无网络/模型外呼；**未执行任何 git 命令（含只读）**；未改 `docs/audits/**`、`docs/plans/**`、根 `package.json`、`vendor/wechat-acp/package.json`；未新增依赖（模块仅 `node:crypto` + `node:fs`）；vendor 测试用自带 runner（`node --import tsx/esm --test 'tests/**/*.ts'`），测试文件放 `tests/**/*.ts` 下被自动收进（已确认：新用例确实被计入）。

## 固定来源（完整 sha256）

| 文件 | 行数 | sha256（完整） | 状态 |
| --- | --- | --- | --- |
| `vendor/wechat-acp/src/storage/shadow-projection.ts` | 563 | `9e0c2acdd9e829881dcbbf3b1dc11d9b624f06b07cc2f55f7c5e84befa1e3e38` | 新增 |
| `vendor/wechat-acp/tests/shadow-projection.test.ts` | 479 | `c8ddeca8e31abce569392d2981707ea56c7bdf533ee8bb2810a710895169d355` | 新增 |

参照但**未修改**的既有资产：`control-plane/shadow-projection.mjs`（D67 Node 版：报告形状 / `stable()`→`digestOf()` 规范化口径 / match 语义 / fail-closed / `detail` 有界截断 / `reportDigest` 除 `generatedAt` 外全报告，本模块的 `stable()`/`bounded()`/`reason()` 逐行镜像其 71-100 行）、`services/memory/shadow.py`（D68 Python 版：跨语言对齐条款与探针做法）、`vendor/wechat-acp/src/storage/message-inbox.ts`（`MESSAGE_INBOX_STATUSES`、`ExecutionCheckpoint['phase']`、记录形状与 `incoming-receipts/` 布局、`_validateRecord` 校验、`_listIds` 只认 `.json`）、`src/storage/reply-outbox.ts`（`ReplyRecord` 形状、状态/kind 枚举、`parseRecord` 校验、`reply-outbox/` 布局）、`src/storage/submission-registry.ts`（`SubmissionRegistration` 形状、`state==='registered'`、`parseRegistration` 校验、`submission-registry/` 布局）、`src/bridge.ts:158-162`（三个 store 的目录布局= `config.storage.dir/{incoming-receipts,reply-outbox,submission-registry}`）。

两个 `package.json` **均未改动**：根 `package.json` sha256 `f91339985e7b0a6c1c36f82c4d3ec131faf965f3102ab93ca296e18607c5590e`（78 行，与 D67/D68 交接一致）；`vendor/wechat-acp/package.json` sha256 `1bdcfcf44c6fdc11716bdbce9fc16d13ceffec19ff7897b017efe5620121f32d`（61 行）。测试经 `tests/**/*.ts` 文件名匹配**自动进 vendor 联合套件**，无需新增脚本。

## 设计合同逐条落地

### 1. `runShadowProjection({ legacyDir, convertedDir, now?, projections? }) -> Promise<report>`

- **两个桥状态根以只读扫描**：`legacyDir`/`convertedDir` 各为一个"状态根"，内含三个子目录（`incoming-receipts/`、`reply-outbox/`、`submission-registry/`）。模块**只调** `fs.stat`/`fs.readdir`/`fs.readFile`——**绝不**写、改名、chmod、unlink，也**不生成任何侧车文件**。生产桥根 `~/.wechat-acp/` 由调用方决定，本模块不经手。`legacyDir`/`convertedDir` 期望由快照编排器的桥状态快照适配器（另行生产批）产出。
- **内置投影集（6 条）**：见下"投影口径表"。每条投影只读 `status`/`execution.phase`/`userId`（含 inbox `message.from_user_id`）/`registeredAt` 与 id 集合——**绝不**读 `question`/消息体/`context_token`/回复正文，故报告天然不含桥侧敏感正文。
- **报告形状逐字段对齐 Node/Python 版**：`{ version, kind:'wechat-bridge', projections:[{name,status,legacyDigest,convertedDigest,match,detail?}], allMatch, reportDigest, generatedAt }`；`version` 与另两版同为 `"shadow-projection-v1"`（同口径，`kind` 区分三类报告，供同一工具链识别）；投影 `status ∈ {'ok','failed'}`；digest 为 `sha256:<hex>`，即"规范化（键递归排序）序列化后的 sha256"；`match = (legacyDigest === convertedDigest)`。`match=false`（且 `status:'ok'`）时 `detail` 给出两侧各自的规范化摘要（有界截断至 2000 字符，超出附 `…(truncated N chars)`）。**绝不把 mismatch 写成 match**。
- **digest 规范化口径**：`stable()` 复刻 Node `stable()`（键递归排序、数组保序、标量 `JSON.stringify`）——跨实现等价由探针实证（见下"与 Node/Python 版的口径对照"）。
- **`reportDigest` 除 `generatedAt` 外全报告**：即 `sha256(stable({version,kind,projections,allMatch}))`；两次运行同输入（同两侧根、同 `now`）必同 `reportDigest`；`generatedAt` 是唯一非确定字段，被显式排除。`generatedAt` 用 JS `Date.toISOString()`（`YYYY-MM-DDTHH:MM:SS.sssZ`）。测试用独立复算断言 `reportDigest` 恰等于全报告（除 `generatedAt`）的 sha256。
- **fail-closed（整体拒分支）**：根目录缺失/非目录 → `missing-root`；类别子目录缺失/不可读/非目录 → `missing-collection`；记录文件非合法 JSON、schema 不符、文件名与记录 id 不一致、不可读 → `corrupt-record`；`legacyDir`/`convertedDir` 非非空字符串 → `invalid-path`；`now` 非函数、`projections` 为空或含非函数 → `invalid-config`。以上**均在任何投影运行之前**抛出（加载两侧全量并校验后才起投影）。
- **单条投影抛错不拖垮整批**：该条如实落 `status:'failed'`、`match:false`、`legacyDigest/convertedDigest:null`、`detail:{side,error}`（error 截 300 字符），其余投影照常运行，`allMatch=false`。**mismatch 永不误报 match**。
- **确定性**：同输入两跑报告逐字节相等、`reportDigest` 相同；`now` 注入（callable 返回毫秒）。
- **可注入投影**：`projections` 为**函数数组**时**替换**内置集（为生产批留口）；函数名取 `displayName ?? name ?? projection-<i>`；签名 `(state, ctx) => value`，`state` 为已校验的 `ShadowSideState`（`{inbox,outbox,registry}`），`ctx = { now }`。

**正交说明（需审计裁决）**：`projections=` 是合同签名之外的一个可选关键字，用于（a）支撑"投影抛错隔离"负例、（b）为部署批留真实投影替换缝——与 D67/D68 的 `projections` 缝语义一致（非空函数数组**替换**内置集）。

## 投影口径表（wechat 桥侧，6 条）

| 投影名 | 语义 | 读取 | 备注 |
| --- | --- | --- | --- |
| `inboxStatusHistogram` | inbox 收件状态直方图 | `incoming-receipts/*.json` 的 `status` | 覆盖 `MESSAGE_INBOX_STATUSES` 全部 11 态（含新态 `background`）；缺 `status` 不出现（记录 schema 强制 status 必在枚举内） |
| `inboxExecutionPhaseHistogram` | 执行 phase 分布 | inbox 记录 `execution.phase` | 5 态（`preparing/sent-unconfirmed/dispatched/tool_activity/result_ready`，含新态 `sent-unconfirmed`）；无 `execution` 的记录记 `(absent)` 桶 |
| `outboxStatusHistogram` | 待发件状态直方图 | `reply-outbox/*.json` 的 `status` | 实际枚举 5 态：`pending/sending/sent/blocked/cancelled`（合同文字写 "delivered"，实际终态枚举名为 **`sent`**——以实际枚举为准） |
| `perUserCounts` | 每 userId 的"收件/待发"计数 | inbox `message.from_user_id` + outbox `userId` | 输出 `{ <userId>: {received, outbound} }`；缺失记 `(absent)` 桶 |
| `submissionRegisteredAtBounds` | registry `registeredAt` 有界统计 | `submission-registry/*.json` 的 `registeredAt` | `{count,min,max}`；空 registry → `{0,null,null}`。因每条登记均校验 `registeredAt` 有限，**`count` 即 registry 计数** |
| `receiptIdCrossConsistency` | inbox vs registry 交叉一致性 | inbox 记录 `id` 集合 vs registry `receiptId` 集合 | `{inboxOnly:[...], registryOnly:[...]}`（均排序）；两集合皆空 ⇔ 两侧 id 集合相等 |

> **口径决策（需审计裁决）**：合同列了"submission-registry **计数**"与"`registeredAt` **有界统计**"两项，本模块**合并为一条** `submissionRegisteredAtBounds`（其 `count` 字段即 registry 计数）。理由：**计数**与**交叉一致性**都以 registry 的 id 集合为基底，任何"增/删登记"都会同时改动计数与交叉一致性，无法构造"仅影响计数"的隔离偏离；把计数并入有界统计后，六条投影**各自**都能被一处独立偏离精确命中（见下"逐投影隔离"）。若审计要求拆分计数为独立投影，将牺牲计数投影的独立可隔离性，需一并裁决。

## 与 Node/Python 版的口径对照

| 维度 | Node 版（control-plane/goals） | Python 版（memory） | 本 wechat 桥版 | 一致性 |
| --- | --- | --- | --- | --- |
| 报告字段 | `{version,kind,projections,allMatch,reportDigest,generatedAt}` | 同 | 同 | ✅ 逐字段对齐 |
| `version` | `"shadow-projection-v1"` | 同字符串 | 同字符串 | ✅ 同口径，`kind` 区分 |
| `kind` | `control-plane`/`goals` | `memory` | `wechat-bridge` | ✅ |
| 投影字段 | `{name,status,legacyDigest,convertedDigest,match,detail?}` | 同 | 同 | ✅ |
| digest | `sha256(stable(v))`，`stable` 键递归排序 | 复刻 `stable` | 逐行镜像 Node `stable()` | ✅ 跨实现实证一致 |
| `reportDigest` | 除 `generatedAt` 外全报告 | 同 | 同（并有独立复算断言） | ✅ |
| `detail`（ok+mismatch） | `{legacy,converted}` 有界 2000 + `…(truncated N chars)` | 同 | 同 | ✅ |
| `detail`（failed） | `{side,error}`，error 截 300 | 同 | 同 | ✅ |
| `allMatch` | `非空 且 全 ok 且全 match` | 同 | 同 | ✅ |
| 输入 | 两个**已解析状态对象**（零文件 IO） | 两个 **sqlite 路径**（只读开库） | 两个**桥状态根目录**（只读扫目录树） | ⚠️ 有意差异：桥侧状态是文件树而非单库，故读盘是本模块职责 |
| fail-closed 码 | `unknown-kind/invalid-state/missing-collection/invalid-collection/invalid-config` | `missing-db/not-a-database/missing-turns/missing-columns/invalid-path/invalid-config` | `missing-root/missing-collection/corrupt-record/invalid-path/invalid-config` | ⚠️ 语义等价、码名适配目录树形态 |
| 同步/异步 | 同步 | 同步 | **异步**（`fs/promises` 扫目录；返回 Promise） | ⚠️ 有意差异：目录扫描用异步 IO（与 vendor 包既有 async 存储惯例一致） |

**跨语言/跨实现 digest 实证**：独立探针 `/tmp/p6-wechat-shadow-probe.mjs` 把 8 个代表值（整数直方图 `{received:2,background:1}`、保序数组 `['a','b','c']`、含整值的 `{count:3,min:500,max:3000}`、`(absent)` 桶 `{'(absent)':1}`、`0`、`[]`、空界 `{count:0,min:null,max:null}`、交叉一致性值 `{inboxOnly:['00ff'],registryOnly:[]}`）分别喂给：
- **本 TS 模块**（经其公开的 injected-projection 缝：`runShadowProjection({...,projections:[()=>v]}).projections[0].legacyDigest`），与
- **真实 `control-plane/shadow-projection.mjs`**（`runShadowProjection({...,kind:'control-plane',projections:[()=>v]}).projections[0].legacyDigest`）

两侧 sha256 **逐一全等**（`cross-implementation-digest.allEqual=true`，16 个哈希成对相等，原始输出见下）。即"同值 ⇒ 同 digest"在**TS 桥侧模块**与 **Node 规范实现**之间成立（Python 版在 D68 已单独实证同口径）。除 TS↔Node 真机对照外，测试文件另有**自包含**回归护栏：把同一批代表值与本模块 digest 逐一对齐到**内联复刻的 Node `stable()`**（逐行抄自 `shadow-projection.mjs:71-80`）。

## 负例/正例原始结果

### (a) 单元套件 `tests/shadow-projection.test.ts`（27 例全过）

```text
✔ two identical bridge state roots: every projection matches
✔ reportDigest covers the whole report except generatedAt
✔ two runs on the same input produce the same reportDigest (determinism)
✔ reportDigest excludes generatedAt: changing only the clock keeps the digest
✔ projection values are order-independent (shuffled file names still match)
✔ a divergence in inboxStatusHistogram flags exactly that projection
✔ a divergence in inboxExecutionPhaseHistogram flags exactly that projection
✔ a divergence in outboxStatusHistogram flags exactly that projection
✔ a divergence in perUserCounts flags exactly that projection
✔ a divergence in submissionRegisteredAtBounds flags exactly that projection
✔ a divergence in receiptIdCrossConsistency flags exactly that projection
✔ a mismatch is never reported as a match, and detail is truthful
✔ cross-consistency truthfully surfaces an inbox receipt with no registration
✔ an optional field on a converted record does not by itself cause a mismatch
✔ a missing state root is refused
✔ a missing category directory is refused
✔ a corrupt JSON record fails closed
✔ a schema-mismatched record fails closed
✔ a record whose id does not match its file name fails closed
✔ a corrupt registry record fails closed
✔ invalid configuration fails closed
✔ the mirrored enums match the real store enums (drift guard)
✔ an injected projection set replaces the built-ins
✔ a projection that throws is reported failed and does not abort the batch
✔ neither root is mutated and no sidecar file is created
✔ the module digest equals the Node stable() digest on representative values
✔ the same root digests identically regardless of the injected clock
ℹ tests 27  pass 27  fail 0
```

- **逐投影隔离**：对 6 条投影各构造一处**仅影响本投影**的偏离，断言 `mismatches === [该项]`、`allMatch=false`、`detail.legacy !== detail.converted`，其余投影保持 match：(1) inbox 状态 `received→queued`（仅影响状态直方图）；(2) execution phase `result_ready→dispatched`（仅影响 phase 分布）；(3) outbox 状态 `sent→blocked`（仅影响待发直方图）；(4) inbox `from_user_id: user-b→user-c`（仅影响 perUserCounts）；(5) registry `registeredAt: 3000→500`（仅影响有界统计，count 不变）；(6) 重命名一条 inbox id（`ID4→ID5`，status/发件人不变）→ 仅影响交叉一致性。**证明"不误报"。**
- **mismatch 不写成 match**：inbox 状态偏离时 `detail.legacy` 含 `received`、`detail.converted` 含 `queued`，如实呈现。
- **交叉一致性如实**：converted 根收到一条 `ID5` 但从未登记 → `receiptIdCrossConsistency.match=false`，`detail.converted` 含 `ID5`、`detail.legacy` 不含，如实暴露"inbox 有 receipt 而 registry 无登记"。
- **语义而非逐字节**：outbox 文件写入顺序颠倒、converted 记录增补可选字段（`errorKind`）→ `allMatch=true`，不误报。
- **确定性与 generatedAt 排除**：同输入两跑 `reportDigest` 相等且报告逐字节相等；仅改时钟（`()=>1000` vs `()=>2000`）时 `generatedAt` 不同而 `reportDigest` 相等；独立复算证明 `reportDigest` 恰覆盖全报告（除 `generatedAt`）。
- **fail-closed**：缺根 → `missing-root`；缺 `submission-registry/` 子目录 → `missing-collection`；坏 JSON / 未知 status / 文件名与 id 不一致 / registry state 非 `registered` → `corrupt-record`；`now` 非函数、`projections:[]`、含非函数 → `invalid-config`；根参非字符串 → `invalid-path`。
- **投影抛错不拖垮整批**：注入 `[ok, boom]` → `boom` 落 `status:'failed'`、`match:false`、`digest:null`、`detail.error='kaboom'`，同批 `ok`（`inboxCount`）仍 match，`allMatch=false`。
- **只读**：一次投影后两个根的三目录全量快照（文件名 + 内容 sha256）逐字节不变，且无新文件（无侧车）。
- **枚举漂移护栏**：本模块镜像的 `INBOX_STATUSES` 与真实导出的 `MESSAGE_INBOX_STATUSES` 深等，且含 `background`；`EXECUTION_PHASES` 含 `sent-unconfirmed`；`OUTBOX_STATUSES` 等于实际 5 态。

### (b) 独立探针 `/tmp/p6-wechat-shadow-probe.mjs`（只读；无生产读写/网络/模型/git）原始输出

```json
{"realModels": false, "productionTouched": false, "networkCalls": 0, "gitCommands": 0, "observations": [
 {"probe":"happy","allMatch":true,"projections":6,
  "reportDigest":"sha256:718e7e68967fd65eee1ebf3c6190db285b39dd67abc52d435bc60b5ed1b9ecb9",
  "generatedAt":"2023-11-14T22:13:20.000Z"},
 {"probe":"determinism","reportDigestEqual":true,"equalReport":true},
 {"probe":"generatedAt-excluded","generatedAtDiffer":true,"reportDigestEqual":true},
 {"probe":"divergence-inboxStatus","mismatches":["inboxStatusHistogram"]},
 {"probe":"divergence-cross-consistency","mismatches":["receiptIdCrossConsistency"]},
 {"probe":"divergence-registry-bounds","mismatches":["submissionRegisteredAtBounds"]},
 {"probe":"failclosed-missing-root","code":"missing-root"},
 {"probe":"failclosed-missing-collection","code":"missing-collection"},
 {"probe":"failclosed-corrupt-json","code":"corrupt-record"},
 {"probe":"failclosed-invalid-config","code":"invalid-config"},
 {"probe":"throwing-projection","allMatch":false,"failed":"boom","status":"failed","match":false,"error":"kaboom"},
 {"probe":"cross-implementation-digest","allEqual":true,
  "ts":  ["sha256:3376299ce28bbbc5a2638ff04b38aa8a74cb433b5489bdea212b7bb19447a39b",
          "sha256:fa1844c2988ad15ab7b49e0ece09684500fad94df916859fb9a43ff85f5bb477",
          "sha256:cbabd85bbf1cf3a2e96c1480d89a3b2b82e23afd48eab18fadc3c32f2ed89cda",
          "sha256:fa7b95980c6bf9910080ae7b5ca17526d5c3b3815931e6a311a6ac27a492beaa",
          "sha256:5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
          "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
          "sha256:f88803a1fd729c61f4879daf6ab2d24651abb4a8704b84015bf7a5ed3baa335b",
          "sha256:c723804383410f2ee18e2e19d8b2222f246383279bbe4b00a93f5ceb938f1af0"],
  "node":["sha256:3376299ce28bbbc5a2638ff04b38aa8a74cb433b5489bdea212b7bb19447a39b",
          "sha256:fa1844c2988ad15ab7b49e0ece09684500fad94df916859fb9a43ff85f5bb477",
          "sha256:cbabd85bbf1cf3a2e96c1480d89a3b2b82e23afd48eab18fadc3c32f2ed89cda",
          "sha256:fa7b95980c6bf9910080ae7b5ca17526d5c3b3815931e6a311a6ac27a492beaa",
          "sha256:5feceb66ffc86f38d952786c6d696c79c2dbc239dd4e91b46729d73a27fb57e9",
          "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
          "sha256:f88803a1fd729c61f4879daf6ab2d24651abb4a8704b84015bf7a5ed3baa335b",
          "sha256:c723804383410f2ee18e2e19d8b2222f246383279bbe4b00a93f5ceb938f1af0"]}]}
```

## 验证（命令 / 通过计数，全绿）

| 命令 | 结果 |
| --- | --- |
| `node --import tsx/esm --test tests/shadow-projection.test.ts`（cwd=vendor/wechat-acp） | **27/27 pass**（新增） |
| `node --import tsx/esm --test 'tests/**/*.ts'`（cwd=vendor/wechat-acp，vendor 整包） | **400 tests：399 pass / 1 skipped / 0 fail**（基线 373：372 pass / 1 skipped / 0 fail，不回归 + 27 新用例） |
| `npm --prefix vendor/wechat-acp run build`（`tsc`，strict） | **exit 0，零错误** |
| `npm run test:runtime-policy` | **39/39 pass**（含 vendor build） |
| `npm run audit:secrets` | **PASS：0 undispositioned**（1750 文件扫描，55 二进制跳过，6 条已裁定） |
| `node --import tsx/esm /tmp/p6-wechat-shadow-probe.mjs` | exit 0；正例 allMatch、4 类拒绝码、抛错隔离、跨实现 digest 全等 |

## 偏差与诚实边界（未覆盖项）

- **真实桥状态 shadow 属部署批**：本模块只对调用方显式传入的两个**桥状态根目录**生效，**未对接、未投影任何真实 `~/.wechat-acp/`**。真实 shadow run 须在"部署批"进行，且需 **Markus 批准 + 一致性快照前置**（本模块不构成该等授权）。
- **桥状态快照适配器属编排器生产批**：桥侧状态是"三个文件型 store 目录树"，与 `snapshot-orchestrator` 现有的 sqlite/JSON 适配器形态不同；把生产桥状态冻结成"一致副本根"的适配器**不在本批**——本批只交付投影层（给两个根即出可复验报告）。
- **未与 D64/D65 联合验证**：D67 用 `convertState` 做了"真实转换→投影 allMatch"的端到端；桥侧没有等价的"版本化转换器"（本批范围内不存在桥状态转换器），故本批只做"两份同构合成根 → allMatch"与逐投影偏离，**未串联**任何真实转换路径。
- **只覆盖三个 store 的三个目录**：桥根下的其它持久物（`state.json`、`conversation-memory.json`、`inject/`、`daemon.pid`、`wechat-acp.log`、`recovery-lease`）**均未投影**；路径不属本合同范围。
- **向量库投影仍未做**：与 D68 一致的遗留项，需另列设计。
- **fail-closed 走"整体拒"分支**：合同允许"对应投影 failed **或**整体拒"；本模块对**加载期**的结构/记录问题采用**整体拒**（`missing-root`/`missing-collection`/`corrupt-record`，任何投影运行前抛出），与 D67/D68"先 fail-closed 加载、再投影"一致；"对应投影 failed/隔离"分支由**注入抛错投影**覆盖。若审计要求"坏记录只令某条投影 failed 而整体继续"，需改为惰性/按类别隔离读取——**请裁决**。
- **计数并入有界统计**：见"投影口径表"脚注（`submissionRegisteredAtBounds.count` 即 registry 计数）。为可隔离性合并；**请裁决**。
- **`projections=` 增益参数**：合同签名之外的注入缝（对齐 D67/D68），已在"正交说明"标注待裁决。
- **`version` 字段与另两版共用字符串**：`"shadow-projection-v1"`，`kind` 区分。未新增独立 wechat 版本号（保持跨实现同口径）。
- **异步 API**：本模块 `runShadowProjection` 返回 Promise（`fs/promises` 扫目录），异于 Node/Python 版的同步 API——属形态适配，报告形状不受影响。
- **枚举镜像为本地副本**：`INBOX_STATUSES`/`EXECUTION_PHASES`/`OUTBOX_STATUSES`/`OUTBOX_KINDS`/`SUBMISSION_STATE` 在本模块**本地镜像**（vendor 既有惯例：`message-inbox.ts` 与 `submission-registry.ts` 各自复制 `canonicalize` 而非共享）。其中 `MESSAGE_INBOX_STATUSES` 被 store 导出，测试用深等做**漂移护栏**；其余为 store 私有常量，只能逐字镜像（无自动护栏）。
- **合同文字与实际枚举的差异**：合同写 outbox 状态含 "delivered"，实际 `ReplyRecord.status` 终态枚举名为 **`sent`**；本模块按**实际枚举**实现（`sent`），并在口径表标注。
- **`audit:secrets` 未覆盖未 track 的新文件**：该脚本以 `git ls-files` 取文件清单，而本批两文件在交付时**未 track**（本批按铁律未执行任何 git 命令），故未被该次扫描计入；两文件不含任何凭据样式字面量（sha256 见"固定来源"），commit 后即纳入扫描。
- **跨实现 digest 等价只证代表值域**（同 D68 边界）：整数/整值浮点/字符串/数组/嵌套对象/空/null 的样本；未证 `userId` 含**代理对（astral）/emoji** 时两实现的键排序差异（本包夹具用 ASCII 键，未触发）。
- **未提供独立报告复验函数**（对标 `verifyConservation`）：合同未强制；如需"从落盘报告复算 `reportDigest`"的可执行断言，可后续补。

## 要求审计方做什么

- 复核 **6 条投影口径表**是否恰当覆盖三个桥侧 store 的"可观察语义"，特别是"计数并入 `registeredAt` 有界统计"这一**合并决策**（见口径表脚注）。
- 裁决上述**"整体拒 vs 逐投影 failed"** 的 fail-closed 落地分支是否符合合同意图。
- 复核 **fail-closed 码语义**（目录树形态适配 `missing-root/missing-collection/corrupt-record/invalid-path/invalid-config`）与 **`detail` 有界截断**（2000 + `…(truncated N chars)`；error 300）是否如实。
- 复核 **`reportDigest` 确定性**（排除 `generatedAt`；测试含独立复算）与**跨实现 digest 口径**（探针已用**真实** `control-plane/shadow-projection.mjs` 实证 8 组代表值全等）。
- 复核 **`projections=` 增益参数**、**异步 API**、**`version` 共用字符串**三处增益是否可接受；复核**本地枚举镜像 + 漂移护栏**策略。
- 本包非 Grant/Approval；不授权生产桥状态读写、真实 shadow run、迁移、部署或物理删除。
