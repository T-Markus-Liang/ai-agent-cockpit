# 执行交接包：P6 一致性停写快照编排器（r2，SN-F001/002/003 返工）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包回应 [2026-10-09 最新复核](../audits/2026-10-09-latest-review.md)第 27-49 行对 r1 的 **CHANGES_REQUESTED** 裁决（三个 P1/Major Finding：SN-F001 暂停结果未知不可核对、SN-F002 名称/目标防护缺失、SN-F003 任意错误文本持久化），按[整改执行方案 S01](../plans/0.3.0-remediation-2026-10-09.md)第 35-58 行的最小解决方案施工。三个缺陷在同一包修复，未拆成多套编排器。**r1 交接包与 r1 失败证据保留原样、未覆盖**（见 [p6-snapshot-orchestrator-r1.md](p6-snapshot-orchestrator-r1.md) 与审计文档所附探针结果）。**本包只改编排器模块与其测试，不触生产路径、不做转换、不触任何消费方文件。**

## 批次身份与状态

- batchId / revision：p6-snapshot-orchestrator / **r2**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；本批由该会话 subagent（deepseek-flash，官方 V4.1 Flash）实现与补测，主 Agent 定设计合同并亲自复跑验证
- 分支 / cwd：`feat/0.3.0-progress` / `/Users/markus/ai-agent-cockpit`
- 基线：HEAD `c0125a8d4719783aad1e1acef8a0af45346f43cf`（审计文档所记 HEAD；本批未执行任何 git 命令）
- 本批目标：关闭 SN-F001/SN-F002/SN-F003，原反例转为明确回归断言，正常快照与恢复路径保持
- 明确不做：真实四类生产 store 适配器、生产 restore 编排、跨 store 原子提交、消费方（state-converter / shadow-projection / migration-rollback-drill）任何修改、`package.json` 变更、生产目录读写
- 铁律遵守：全部夹具为自建 `os.tmpdir()/snapshot-orch-*` 合成树（含 SIGKILL 探针的子进程）；**未读写任何生产/launchd/真实用户文件**；无网络/模型/微信外呼；未执行任何 git 命令（含只读）；未改 `docs/audits/**`；未重启任何服务

## 固定来源（完整 sha256）

| 文件 | 行数 | sha256（完整） | 状态 |
| --- | --- | --- | --- |
| `control-plane/snapshot-orchestrator.mjs` | 1006 | `e07023b04490b072c0926e797459c4f53e12c73052ddbc5be60f40f7712a002a` | 改（r1 598 行 → 1006 行） |
| `tests/snapshot-orchestrator.test.mjs` | 1104 | `afc75699ff7feecc7a6014c605676e7b163d8743159d5c84b3f93699ab3387df` | 改（r1 419 行 → 1104 行） |

对照（r1 / 审计复核时旧 hash，引自[审计文档](../audits/2026-10-09-latest-review.md)第 18 行，仅用于确认本批改动面）：`control-plane/snapshot-orchestrator.mjs` r1 为 `9008c017711cb99ddc81b320d94cd78344318ab301e2e41877fcce94cf226a3d`（598 行）。

直接依赖/消费方 `control-plane/state-converter.mjs`、`control-plane/shadow-projection.mjs`、`tests/migration-rollback-drill.test.mjs`、`tests/state-converter.test.mjs`、`tests/shadow-projection.test.mjs` **本批一律未修改**（其消费面仅为 `manifest.status === "success"`、`stores[].status/sha256/bytes/files` 等 evidence 字段，schema 1→2 演进保持了这些字段，见下"schema 演进"节；55 项消费方测试零回归为兼容证据）。本批未对这些未修改文件重新计算 hash，请审计方按其复核流程自行核对。运行时依赖仍仅 `node:fs`/`node:path`/`node:crypto`/`node:sqlite`（Node v24.15.0），**未新增任何依赖**。

## 逐项 Finding 应答

### SN-F002：目标路径必须属于本轮且不能覆盖（审计定位 r1 :385/:513/:306）

- **单段命名/保留名校验**：新增 `assertSafeSegment(value, code, what)`（L242-262）——非空字符串、长度 ≤ 255；拒绝 `.`/`..`；拒绝含 `/`、`\`、NUL；拒绝保留名集合 `RESERVED_SEGMENTS`（`manifest.json`、`manifest.json.tmp`、`journal.json`、`journal.json.tmp`，L147-152）；拒绝以 `.stage` 结尾。`registerStore` 以 `invalid-store` 校验 `store.name`（L547），`run()` 以 `invalid-run-id` 校验 `runId`（L664）。名称唯一性（`duplicate-store`）保持。
- **目标 containment 与写入前预检**：`runDir = join(realRoot, runId)`（realRoot 为构造期 realpath 过的根，L665）；`preflightTargets`（L625-642）在**任何 mkdir 之前**对每个 store 计算 `targetDir = join(runDir, store.name)` 与 `stage = targetDir + ".stage"`，断言 `isWithin(targetDir, runDir)`、`targetDir !== runDir`、`!existsSync(targetDir)`、`!existsSync(stage)`。拒绝前文件系统零变化（测试断言源/目标内容、inode、mode 不变）。
- **独占创建与禁止覆盖**：`mkdirSync(runDir, { mode: 0o700 })` **非递归**——EEXIST 即原子并发护栏（L673）；filedir 适配器 rename 前守卫：`entryExists(targetDir)` 则清理 stage 并抛 `target-exists`，**绝不覆盖已有目录**；失败路径保证 stage 被 `rm`（L459-477）。
- **单 writer/owner 合同声明**：头注释"SINGLE-WRITER / OWNER CONTRACT"节（L100-109）如实声明：runDir 本轮 0700 全新创建、编排器实例 single-flight（并发 run 抛 `snapshot-in-progress`）、名称唯一且过滤保留名 ⇒ 轮内无目标竞争；不满足者属 UNSUPPORTED，预检与 rename 守卫是友好错误而非通用并发控制——不把 exists 检查当原子保证。

### SN-F001：暂停结果未知必须可核对（审计定位 r1 :507）

- **intent 先持久化**：journal（`runDir/journal.json`，原子写 tmp+fsync+rename+fsync dir，L333-349）在 runDir 创建后立即写初始记录；**每个 quiesce 调用之前**先置 `intent` 写盘（L716-718），成功 `confirmed`、抛错 `unknown`（L723-731）；每个 resume 后写 `confirmed`/`failed`；run 结束写 `completed`/`aborted`。journal 只存状态与确定性 id，绝不存错误文本。SIGKILL 落在 journal 写与调用返回之间时留下的是可核对的 `intent`/`confirmed` 记录，不再是静默缺口。
- **按 store 记录状态、适配协议扩展**：journal `stores[]` 每项 `{ name, kind, quiesce, snapshot, resume }`，quiesce ∈ `not-attempted|intent|confirmed|unknown`。适配器三方法改收 `ctx = { runId, owner, fence, operationId }`（向后兼容，内置适配器忽略 ctx）；`operationId` 确定性：`<runId>:<store.name>:<quiesce|resume>`（L480-487），崩溃后恢复重放**同一逻辑操作 id**，幂等适配器可安全重放。
- **三态与 needs-review 阻断**：quiesce 抛错 ⇒ 记 `unknown` 并**中止整个 run**（不再 snapshot）；清理时对 quiesce ∈ (`confirmed`,`unknown`,`intent`) 的 store 逆序幂等 resume。run 三态：`success` / `failed`（resume 或 snapshot 或 manifest 写失败）/ `needs-review`（任一 quiesce `unknown`，即使后续 resume 成功——暂停窗口不可证，切换必须阻断）。manifest 每 store 携带三子状态 + 顶层 status（`ok`/`failed`/`not-run`，替代 r1 的 `skipped`）；`quiesceOrder`/`resumeOrder` 记录实际发出调用的 store（含 unknown）。
- **owner/fence 授权恢复**：构造选项新增 `owner`（默认 `randomUUID()`）与 `fenceTtlMs`（默认 3600000ms，非正有限数 → `invalid-config`）；run 开始生成 `fence = { token, issuedAt, expiresAt }` 入 journal。新增导出 `inspectRun({ rootDir, allowRoot, runId })`（**只读**核对：同样的 root/allowRoot 校验，返回 `{ runId, owner, state, stores, needsReview, resumable }`，journal 缺失抛 `journal-missing`）与 `recoverRun({ rootDir, allowRoot, runId, owner, stores, now? })`：`owner !== journal.owner` → `recovery-not-authorized`（**禁止对未知 owner 盲目 resume**）；注入时钟 `now() > fence.expiresAt` → `fence-expired` 且不 touch 任何 store；每个 resumable store 缺 adapter → `invalid-store`（全部校验先于任何 resume）；校验通过后用 journal 原 fence token + 确定性 operationId 逐个 resume，写回 journal，终态 `state="recovered"`，返回 `{ runId, resumed, failed }`。**绝不重跑 snapshot、绝不重新执行用户任务。**

### SN-F003：清单不得持久化任意错误文本（审计定位 r1 :163/:530/:546/:564）

- **错误消毒**：删除 r1 的 `describe()`（曾把任意错误的 name+message 截断 500 字写入 manifest）。新 `errorRecord(error, stage, store?)`（L272-277）**只读错误身份**：`SnapshotOrchestratorError` → 其固定 code；其它一切 → 固定 `adapter-failed`；stage ∈ `validate|quiesce|snapshot|resume|manifest-write` 白名单；`store` 为已过安全校验的逻辑名。**绝不读 name/message/stack/cause/`String(error)`**，不依赖正则遮罩或截断。
- **固定错误码贯穿**：`manifest.error`、`resumeErrors`、run() 返回 DTO 的 `error` 全部为 `{ code, stage, store? }`；manifest 写失败 → 固定 `{ code: "manifest-write-failed", stage: "manifest-write" }`。对外 throw 的 `SnapshotOrchestratorError` 保留人读 message，但 message 只含已校验 name/runId 与固定文字，不拼绝对路径（runDir 用 `basenameOf` 脱路径）。
- **schema 升版**：`SCHEMA_VERSION` 1 → **2**（头注释"MANIFEST / JOURNAL SCHEMA v2"节说明）；新增 `JOURNAL_VERSION = 1`。

## 旧反例 → 新回归断言映射

审计第 43-49 行的 review 回合原始观测（r1 失败证据，保留于审计文档）与 r2 回归断言的逐项对应：

| 审计探针（r1 观测） | r1 旧观测值 | r2 回归断言（测试文件内用例） |
| --- | --- | --- |
| quiesceAndError（fake adapter 先 paused=true 再抛错） | `storeStillPaused=true`、`resumeCalls=0`、manifest 标 `skipped`、run `failed` | run **`needs-review`**；journal 该 store `quiesce="unknown"`；**`resumeCalls=1`、`paused=false`**；manifest 三子状态 `unknown/not-run(confirmed-resume)` 如实（非 skipped/not-run 掩盖）；quiesce 无副作用抛错同样 unknown/needs-review（"quiesce that pauses then throws…"、"quiesce that throws before any side effect…"） |
| traversal（`store.name='../victim'`） | `acceptedTraversalName=true`、`victimReplaced=true`、`victimContainsCopiedData=true`、run 竟 `success` | `registerStore` **直接拒绝**（`invalid-store`），连同 `a/b`/`.`/`..`/`\`/NUL/4 保留名/`x.stage`/256 字符共 12 种坏名；run() 拒绝 12 种坏 runId；拒绝前后 victim 与 root 的内容、**inode（lstatSync().ino）、mode** 逐项不变（"registerStore refuses unsafe store names…"、"run() refuses an unsafe or reserved runId…"） |
| 轮内目标竞争（审计 S01 验收要求） | r1 无此护栏 | store A 的 snapshotTo 抢占 filedir B 的 targetDir ⇒ B `target-exists` 失败、planted 目录 inode/mode/空内容不变、`.stage` 被清理、run failed（"an in-run target collision fails closed…"） |
| manifestContainsSyntheticCredential | `true`（canary 明文持久化） | quiesce/snapshot/resume **三阶段**分别抛带 canary 的 Error（自定义 name、嵌套 cause、stack 均含 canary）+ **manifest-write 阶段**注入故障；每次递归扫 runDir 全部字节 + `JSON.stringify(返回 DTO)`，canary/自定义错误名/**EACCES/ENOTEMPTY/EEXIST/EISDIR/EPERM**/绝对路径**零命中**；错误记录只剩 `adapter-failed` + 正确 stage 或 `manifest-write-failed`（"adapter canary secrets never reach…"、"a failed manifest write is a fixed-code failure…"） |
| SN-F001 恢复链路（S01 验收：重开/恢复失败/stale fence/断链） | r1 无机制 | `inspectRun` 只读核对（needsReview/resumable/journal-missing）；`recoverRun` 正常路径（同 owner + 未过期时钟，fence token 与 journal 一致、**相同确定性 operationId 重放**、journal confirmed、state=recovered）；错误 owner → `recovery-not-authorized`（resume 未调、store 保持 paused）；注入时钟过期 → `fence-expired`；缺 adapter → `invalid-store`；run 内 resume 失败 → `failed` 且 journal `resume="failed"`（6 个 recover/inspect 用例） |
| 暂停后 SIGKILL（S01 验收） | r1 无机制 | 见下节方法学（"SIGKILL mid-run…"） |
| 正常 sqlite/filedir/custom adapter 路径保持 | — | r1 的 13 个用例全部保留（3 个按语义演进更新断言），happy path 的 WAL 在线 backup、evidence 自复算、逆序 resume、拒绝负例原样通过 |

## SIGKILL 探针方法学（真实子进程，非 fake）

"SIGKILL mid-run: the journal survives, inspectRun shows the gap, recoverRun closes it"用例：

1. 父进程 `spawn(process.execPath, ["--input-type=module", "-e", <脚本>, owner, rootDir, allowRoot, runId, file://URL])` 起**真实子进程**；脚本经 argv 拿参数（无环境、无网络），以绝对路径 `file://` import 仓库 orchestrator，注册 quiesce 正常、`snapshotTo() { await new Promise(() => {}) }` 的 adapter 后启动 run；脚本内置 `setInterval` 保持事件循环，排除 Node unsettled top-level await watchdog 自行退出的干扰（此干扰在开发中被抓出并修复，保证"被信号杀死"的断言不被自然退出伪造）。
2. 父进程轮询 `runDir/journal.json` 直至该 store `quiesce === "confirmed"`（15s 截止），随后 `child.kill("SIGKILL")`，断言 `exit.signal === "SIGKILL"`（子进程确实死于信号，非自行退出）。
3. 核对崩溃现场：journal `state="running"`、`quiesce="confirmed"`、`resume="not-attempted"`；`inspectRun` 报 `resumable=["hang"]`、`needsReview=[]`。
4. 同 owner `recoverRun` 闭环：resume 收到的 `fence` 与崩溃 journal 的 token 一致、`operationId` 为同一确定性 `<runId>:hang:resume`；journal 写回 `resume="confirmed"`、`state="recovered"`；`snapshotTo` 在恢复路径被调用即抛错（断言绝不重跑快照）。

## 验证（主 Agent 亲自复跑，原始退出码）

| 命令 | 结果 |
| --- | --- |
| `node --test --test-reporter=dot tests/snapshot-orchestrator.test.mjs` | **27 pass / 0 fail，exit 0**（13 旧用例语义演进更新 + 14 新增） |
| `node --test --test-reporter=dot tests/state-converter.test.mjs tests/migration-rollback-drill.test.mjs tests/shadow-projection.test.mjs` | **55 pass / 0 fail，exit 0**（消费方零回归） |
| `node --test --test-reporter=dot tests/native-sandbox.test.mjs tests/native-acp-executor.test.mjs tests/snapshot-orchestrator.test.mjs tests/state-converter.test.mjs tests/migration-rollback-drill.test.mjs` | **exit 0**（审计第 54-55 行所列 118 项基线套件；快照套件从 13 增至 27 后总数 132） |

基线声明：HEAD `c0125a8`；未改生产状态、未重启服务、未外呼、未执行任何 git 命令；r1 交接包与审计失败证据保留未覆盖。

**manifest schema 1→2 演进说明**：v2 为每个 store 增加 `quiesce`/`snapshot`/`resume` 三子状态；store 顶层 status 的 `skipped` 字面量改为 `not-run`；run 顶层 status 增加 `needs-review` 字面量；成功 store 的 evidence 字段（`files`/`sha256`/`bytes`/`elapsedMs`）**原样保留**。下游消费面（state-converter / migration-rollback-drill / shadow-projection）仅依赖 `manifest.status === "success"` 与 evidence 字段，55 项消费方测试零回归已证兼容；任何按字符串匹配 `skipped` 的外部读者需要随 v2 更新（本仓库内无此读者）。

## 偏差与诚实边界（未覆盖项）

- **损坏/畸形 journal.json**：`inspectRun`/`recoverRun` 对 JSON.parse 失败会抛原始 `SyntaxError` 而非带码的 `SnapshotOrchestratorError`（审计未要求，列为已知边界；journal 由本模块原子写产出，畸形仅可能来自外部篡改/截断）。
- **needs-review 终态的 journal.state 记为 `aborted`**：设计合同只允许 `running|aborted|completed|recovered` 四态，`needs-review` 是 run() 返回与 manifest 层的第三态，journal 层映射为 `aborted`（非 success 即非 completed）。供审计确认该映射是否符合预期。
- **跨 store 原子提交、生产 restore 编排不在本模块范围**（属 S04）：本模块是快照器+恢复器，不做跨 store freeze/watermark 或真实回退编排。
- **非 macOS 平台未验证**：全部验证在 macOS（Darwin，Node v24.15.0）上进行；rename 语义、目录 fsync、信号行为未在 Linux/Windows 复测。
- **测试文件头注释仍写 "Wave 5"**：文档性内容，为控制 diff 未动。
- 真实四类生产 store 适配器、停写顺序拓扑、真机/生产目录验证：**均未发生**，同 r1 边界。

## 要求审计方做什么

- 复核三个 Finding 的修复落点与上表"旧反例 → 新断言"映射，特别是：SN-F002 拒绝路径的零变化断言（内容/inode/mode）与单 writer 合同声明是否满足"不能把 exists 检查当原子保证"；SN-F001 的 intent-first 写盘时序、needs-review 阻断语义、owner/fence 授权边界（错误 owner 与过期 fence 均零触碰）；SN-F003 的 canary 零命中是否覆盖审计 S01 要求的四个注入面（三 adapter 阶段 + manifest-write 阶段）。
- 复核 SIGKILL 探针方法学是否构成"暂停后断链可核对可恢复"的有效证据（真实子进程 + 信号断言 + recoverRun 闭环）。
- 裁决两个已知边界（畸形 journal 的原始 SyntaxError；needs-review → journal `aborted` 映射）是否需要在后续批次关闭。
- 本包非 Grant/Approval；不授权生产快照、停写、迁移、部署或物理删除。
