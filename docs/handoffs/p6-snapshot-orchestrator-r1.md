# 执行交接包：P6 一致性停写快照编排器（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包回应 P5/P6 就绪地图中"全系统一致性停写快照编排（零）"这一最大缺口（[p5-p6-readiness-r1.md](p5-p6-readiness-r1.md):24），按审计裁决"私有副本合成 converter、故障/回退测试可先做"放行范围施工。**本包只交付编排器模块 + 合成夹具测试，不触生产路径、不做转换。**

## 批次身份与状态

- batchId / revision：p6-snapshot-orchestrator / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；本批由该会话 subagent（deepseek-flash，官方 V4.1 Flash）实现，主 Agent 定设计合同
- 分支 / cwd：`feat/0.3.0-progress` / `/Users/markus/ai-agent-cockpit`
- 本批目标：交付 `control-plane/snapshot-orchestrator.mjs`（通用一致性停写快照编排器）+ `tests/snapshot-orchestrator.test.mjs`（tmp 合成夹具）
- 明确不做：真实四类生产 store 适配器（mem0 backup API / wechat 实例）、任何真实停写/回退编排、shadow 投影、canary/drain、命名批次 2、生产目录读写
- 铁律遵守：全部夹具为自建 `os.tmpdir()/snapshot-orch-*` 合成树；**未读写任何生产/launchd/真实用户文件**（`~/.local/state/personal-ai-os/`、`~/.wechat-acp/` 等一律未触碰）；无网络/模型/微信外呼；未执行任何 git 命令；未改 `docs/audits/**`

## 固定来源（完整 sha256）

| 文件 | 行数 | sha256（完整） | 状态 |
| --- | --- | --- | --- |
| `control-plane/snapshot-orchestrator.mjs` | 598 | `9008c017711cb99ddc81b320d94cd78344318ab301e2e41877fcce94cf226a3d` | 新增 |
| `tests/snapshot-orchestrator.test.mjs` | 419 | `5f1e481c4e7d8a4bd7fe458848b5be34374c22450491a1cf78a3ebd500b22f39` | 新增 |
| `package.json` | 75 | `0621134979da84966474889bf641b4927aa009ca36b984cee7fdc34f19c634c0` | 仅新增一行 `"test:snapshot-orchestrator"`（74→75 行） |

参照但**未修改**的既有资产（本批仅阅读对齐风格）：`services/memory/migration.py`（converter 范式）、`runtime/route-binding-store.mjs`（provenance/poison）、`docs/handoffs/m01-migration-r3.md`（校验前置于写入惯例）。运行时依赖仅 `node:fs`/`node:path`/`node:crypto`/`node:sqlite`（Node v24.15.0），**未新增任何依赖**。

## 设计合同逐条落地

1. **`createSnapshotOrchestrator({ rootDir, allowRoot, now? })`**（`allowRoot` **必填**）
   - `registerStore({ name, kind, path, adapter })`：内置两种适配器——`sqlite`（SQLite **在线 backup API**，非 `cp`；`node:sqlite` 的 `backup()` 读到含未 checkpoint WAL 的一致事务快照）与 `filedir`（**原子目录复制**：复制到 `<target>.stage` 再 `rename`）；传入 `adapter` 即可注册任意自定义 kind（为生产批真实 mem0/wechat 适配器留口）。适配器接口严格三方法 `{ quiesce(), snapshotTo(target), resume() }`。
   - `run({ runId? })` 流程：**校验全部 store** → 依注册顺序 `quiesce()` 全部 → 逐 store 快照到 `rootDir/<runId>/<name>/` → 写 `manifest.json`（原子写 + fsync 文件与目录）→ `finally` 逆序对**已 quiesce** 的 store `resume()`。
   - manifest 字段：`schemaVersion`/`orchestratorVersion`/`runId`/`startedAt`/`finishedAt`/`status`/`stores[]`（每项 `name`/`kind`/`status`/`files[{path,sha256,bytes}]`/`sha256`(组合摘要)/`bytes`/`elapsedMs`）/`quiesceOrder`/`resumeOrder`/`resumeErrors`/`error`/`network_calls:0`。**不落任何 store 原始内容**（对齐 migration.py 的"仅 digest/count/时间戳"）。
   - 快照证据由**编排器自行复算**（递归遍历目标目录逐文件 sha256、组合摘要=排序后 `path\0sha256\n` 的 sha256、字节总数），不信任适配器自报。
2. **失败语义**：任一步失败 → 已 quiesce 的逆序 resume、manifest 落 `status:'failed'` + `error.reason`、返回 `{ status:'failed', ... }`——**部分快照永不以成功面目出现**；未尝试的 store 标 `status:'skipped'` 且不带证据。resume 自身失败记入 `resumeErrors` 并继续清理链（不抛断）；只要存在 resume 失败，整体 `status` 亦为 `failed`（如实、不乐观）。manifest 写入失败也降级为 `failed`。
3. **幂等/单飞**：同一实例同时只跑一个 run（`run()` 在首个 `await` 前同步置忙），并发 run 抛 `SnapshotOrchestratorError('snapshot-in-progress')`；默认 runId=`run-<clock()>-<seq>`，每次 run 新目录，**不覆盖旧快照**；显式 runId 若目录已存在则抛 `target-exists`。
4. **来源守卫**（沿用 M01/RBS 教训）：`allowRoot` **必填**（缺失/非字符串/非绝对路径 → 构造期 `invalid-config`，零副作用）；`rootDir` 必须 realpath 落在 `allowRoot` 之下（否则 `root-outside-allow-root`）；store path 必须存在（`store-missing`）、非 symlink 且祖先无 symlink 逃逸（`unsafe-store-path`）、类型匹配 kind（`store-type-mismatch`）；未知 kind 无 adapter → `unknown-kind`；目标 run 目录必须新建。**所有校验在任何 mkdir/chmod/写入之前**，拒绝路径零元数据变化。

## 与 converter（migration.py）范式的对应关系

| converter 范式 | 本编排器对应 | 差异 |
| --- | --- | --- |
| `_source_provenance`：读源只读并指纹化 | 逐文件 sha256 + 组合目录摘要，编排器自算 | 不做 event 级守恒（本批不转换） |
| `snapshot()`：WAL 一致快照（`sqlite3.backup`），绝不裸 `cp` | `sqlite` 适配器用 `node:sqlite` 在线 `backup()` | 语言/API 等价物；并额外把目标归一为 DELETE 模式单文件 |
| `_validate_target_path`/`_check_target_alias`：写前拒绝、被拒零变化 | `validateStores()` + run 目录新建守卫，全部先于写入 | 同精神 |
| `_load_manifest` 仅存 digest/count/时间戳 | manifest 仅存 name/kind/digest/bytes/耗时 | 同精神（不落原始内容） |
| 两次 dry-run + 守恒校验 | 本批**不做**（编排器非 converter） | 见未覆盖项 |
| RBS `assertStoreProvenance`/poison 语义 | run 内每一步失败→manifest 如实 failed、绝不谎报成功 | 未实现长期 poison 状态机（每 run 独立） |

**一处诚实的机制发现（已固化为设计）**：`node:sqlite` 的 `backup()` 产出的目标**继承源库的 WAL 日志模式**；随后以只读句柄打开它做 `integrity_check` 会即时生成 `-wal`/`-shm` 边车文件（复现见下），使"快照"不是一个自含文件。故适配器在备份后以可写句柄 `PRAGMA journal_mode=DELETE` 归一为单文件，再做 `integrity_check`，随后 `chmod 0600`。这本身也是对"裸 cp 一个 WAL 活动库"反模式的直接证伪。

## 负例/正例原始结果

`npm run test:snapshot-orchestrator`（`node --test`）原始输出（12 例全过）：

```text
✔ happy path: sqlite (WAL) + filedir snapshot to a fresh run dir with verifiable evidence
✔ quiesce runs in registration order; every quiesced store resumes in reverse
✔ a snapshot failure is never a success; quiesced stores still resume in reverse
✔ a resume failure is recorded and does not abort the cleanup chain; run is not a success
✔ refuses a symlinked store path (file and directory) without touching the tree
✔ refuses a rootDir outside the explicitly passed allow root
✔ requires an explicit absolute allowRoot, refused before any filesystem access
✔ refuses an existing run directory and leaves it byte- and entry-identical
✔ refuses an unknown store kind at registration
✔ refuses a store whose type does not match its kind, before any write
✔ refuses a missing store path without creating the run directory
✔ rejects a concurrent run and gives each run a fresh, non-overwriting id
✔ accepts an injected clock and records it in the run id and timestamps
ℹ tests 13  pass 13  fail 0
```

关键断言的原始失败→修复证据（WAL 快照机制）：

```text
修复前：
AssertionError: Expected values to be strictly deep-equal:
    [ 'snapshot.sqlite',
+     'snapshot.sqlite-shm',
+     'snapshot.sqlite-wal' ]   // 只读打开 WAL 快照产生的边车
修复后：files == [ 'snapshot.sqlite' ]（归一为 DELETE 单文件）
```

负例清单（均覆盖"拒绝路径零元数据变化"）：

- **symlink store 拒**：目录软链（filedir）与文件软链（sqlite）分别 `unsafe-store-path`；拒后 `rootDir` 目录项、真实目标目录项均逐项不变，run 目录未创建。
- **rootDir 越界拒**：`rootDir` 在 `allowRoot` 外 → **构造期**抛 `root-outside-allow-root`（纯只读 realpath 判定，无写入）；等于/位于 `allowRoot` 内则接受。
- **allowRoot 缺失/非法拒**：缺 `allowRoot`、非字符串（`42`）、空串、相对路径（`"relative/root"`）→ **构造期**抛 `invalid-config`，且为**首个**拒绝（不取 realpath、任何文件系统访问之前），零副作用。
- **目标已存在拒**：显式 `runId` 目录已存在且含 `keep.txt` → `target-exists`；拒后该目录项与 `keep.txt` 字节不变。
- **未知 kind 拒**：`kind:'carrier-pigeon'` 无 adapter → 注册期抛 `unknown-kind`；同 kind 带注入 adapter 则接受。
- **类型不匹配拒**：`sqlite` 指向目录、`filedir` 指向文件 → 各自 `store-type-mismatch`，`rootDir` 目录项不变。
- **store 缺失拒**：路径不存在 → `store-missing`，`rootDir` 保持为空（run 目录未创建）。
- **并发 run 拒**：慢 store 挂起首个 run 期间再调 `run()` → `snapshot-in-progress`；释放后首 run `success`，重跑得**新 runId**，两目录并存不覆盖。
- **失败注入**：第二个 store 快照抛 `boom-bad` → `status failed`，`quiesce` 全部三例后按 `snapshot:a, snapshot:bad` 中止，逆序 `resume:c,resume:bad,resume:a`；manifest 如实：a=`ok`、bad=`failed`、c=`skipped`（无证据）；`error.reason` 含 `boom-bad`。**resume 失败**：中间 store `resume` 抛错 → 链不中断（其后的 store 仍被 resume），`resumeErrors` 记 1 条，整体 `failed`，但三 store 快照均 `ok`。

## 验证（命令 / 通过计数，全绿）

| 命令 | 结果 |
| --- | --- |
| `npm run test:snapshot-orchestrator` | **13/13 pass**（1 例曾有 WAL 边车断言失败，已修复；r1 收紧新增 allowRoot 必填负例） |
| `npm run test:runtime-policy` | **39/39 pass**（含 `vendor/wechat-acp` build） |
| `npm run audit:secrets` | **PASS：0 undispositioned**（1736 文件扫描，7 处均为既有 disposition） |

## 偏差与诚实边界（未覆盖项）

- **`allowRoot` 必填写入（主 Agent 已裁决）**：设计合同原文的签名 `createSnapshotOrchestrator({ rootDir, now? })` 中缺独立允许根，而"rootDir 必须在调用方显式传入的允许根之下"要求它独立存在。主 Agent 裁决 `allowRoot` **必填**——缺省=rootDir 会让越界守卫平凡成立，违背显式声明边界的意图（对齐 M01/RBS fail-closed 惯例）。已落地：缺失/非字符串/非绝对路径 → 构造期 `invalid-config`、零副作用；测试与本文档已同步。**该条已关闭**。
- **真实四类生产 store 适配器未做**（属部署批）：mem0 需其 backup API、wechat 实例无统一快照、goals/control-plane 的原子写库——本批仅提供 `sqlite`/`filedir`/注入 adapter 三种机制与缝合点，**未对接任何真实 store**。
- **停写顺序编排未做**：就绪地图建议的顺序（keepawake→wechat-control→wechat-bridge 断入站→goals→memory→control-plane→kimi-shim→cezar）属**运行编排/部署**，本批的 `quiesce` 顺序仅按**注册顺序**，不含依赖拓扑、drain 窗口或 canary/回退冻结点。
- **无 converter 级守恒/两次 dry-run**：本批是快照器非转换器，不做 event 级守恒或 dry-run 双跑；"副本转换两次一致"仍仅记忆侧有。
- **无长期 poison 状态机**：RBS 的 poison-until-recover 语义未照搬（每 run 独立、失败如实落 manifest 即返回），符合本批合同但弱于 RBS。
- **真机验证**：未在真实生产目录、真实微信/mem0 实例、真机 UI 上验证；未做跨设备/跨文件系统 rename 边界测试（staging 与 target 同处 runDir，同盘）。
- 真实模型/原文外呼/生产读写/原生会话/微信外发：**均未发生**；无新增依赖、无后台任务、无 launchd 变更；未执行任何 git 命令。

## 要求审计方做什么

- 复核合同逐条落地，特别是：失败语义（部分快照不谎报、resume 失败降级为 failed）与"校验先于任何写入"的时序；`allowRoot` 必填（`invalid-config`，零副作用）的 fail-closed 语义。
- 复核 `sqlite` 适配器对 WAL 快照的归一处理（`journal_mode=DELETE` 单文件）是否符合"真正的 backup/序列化机制"要求。
- 本包非 Grant/Approval；不授权生产快照、停写、迁移、部署或物理删除。
