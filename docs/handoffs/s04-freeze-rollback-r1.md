# 执行交接包：S04b 跨 store 冻结协调与受控回退（r1，§6-5/6/6-7 施工）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包按[整改执行方案 S04](../plans/0.3.0-remediation-2026-10-09.md)第 84-86 行（§6 第 5、6、7 条）施工：**注入式停写 + 共同冻结点 + 保护新数据的受控回退**。施工期间 `control-plane/snapshot-orchestrator.mjs` 处于审计中（r2 已交付），本批**只 import 并消费其公开 API**（`createSnapshotOrchestrator` / `registerStore` / `run` / `inspectRun` / `recoverRun` 及 `MANIFEST_NAME` / `JOURNAL_NAME` 常量），**未修改该文件一行**；`state-converter.mjs` 与 `migration-rollback-drill.test.mjs` 只读复用其校验哲学，同样未动。**本包不触生产路径、不做真实转换、不执行任何 git 命令。**

## 批次身份与状态

- batchId / revision：s04-freeze-rollback / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）的 subagent（deepseek-flash，官方 V4.1 Flash）实现与自测
- 分支 / cwd：`feat/0.3.0-progress` / `/Users/markus/ai-agent-cockpit`
- 基线：HEAD `c0125a8d4719783aad1e1acef8a0af45346f43cf`（本批未执行任何 git 命令，含只读）
- 本批新增文件（仅此三件）：
  - `control-plane/freeze-coordinator.mjs`（冻结协调器 + 受控回退）
  - `tests/freeze-coordinator.test.mjs`（全合成测试）
  - 本交接文档
- 明确不做：生产四类真实 store 适配器（部署批）、真实转换端到端、跨 store 原子提交（见边界）、生产目录读写、网络/微信/模型外呼

## 固定来源（完整 sha256，交付时真实计算）

| 文件 | 行数 | sha256（完整） | 状态 |
| --- | --- | --- | --- |
| `control-plane/freeze-coordinator.mjs` | 1222 | `4ad4bc6317012d8dcf062018342e2f148ebc9342cabe58150fb0745d8c1bcc21` | 新增 |
| `tests/freeze-coordinator.test.mjs` | 1161 | `0c0d6f94221102e8010af99586fbcec2b23fd7b62d8cc0983536b46fce45d754` | 新增 |

直接依赖（**本批一律未修改**）：`control-plane/snapshot-orchestrator.mjs`（r2 交付件，hash 见其交接包 `e07023b0…2a002a`）——本模块仅消费其公开导出。运行时依赖仍仅 `node:crypto` / `node:fs` / `node:path`（Node v24.15.0），**未新增任何依赖**。

## 逐项条款应答（§6 第 5、6、7 条）

### 第 5 条：注入式 transport 真实适配器、固定 lock 顺序停写、共同 freeze watermark

- **适配器协议**（模块头注释声明，与 orchestrator 三方法适配器同一形态）：每个 store 注入 `{ stopAdmission(), resumeAdmission(), drain({timeoutMs, now}), watermark(), snapshotAdapter(), restoreFrozen(target, {protectAfter}) }`。`snapshotAdapter()` 返回的 `{quiesce, snapshotTo, resume}` 直接喂给 orchestrator 的 `registerStore`，测试断言 orchestrator 真实调用了它们且 ctx 携带确定性 `operationId = <runId>:<store>:<quiesce|snapshot|resume>` 与注入 owner/fence。
- **固定 lock 顺序 = 注册顺序**（头注释声明）：`freezeAndSnapshot` 严格按序执行 ① 全量只读预检（配置/名称/适配器形状/协调目录与 run 目录新鲜度，任一拒绝则零停准入、零写入）→ ② 逐 store `stopAdmission()`（任一失败：已停的**逆序恢复准入**，抛 `freeze-partial` 带 `stopped/resumed/resumeErrors/failed` 明细，**零冻结记录落盘**）→ ③ 逐 store `drain()` 带 `perStoreTimeoutMs` → ④ 全部 drain 成功才取各 store `watermark()` 构成**共同 freeze watermark** `{perStore, takenAt}`，原子写入 `rootDir/.freeze-coordination/<runId>/freeze-record.json`（tmp+fsync+rename+fsync dir，0600，协调目录 0700）→ ⑤ 以同一 `owner`/`fenceTtlMs`/注入时钟建 orchestrator 并 `run()`，结果**如实**返回（success/failed/needs-review 不洗白）。
- **单库 backup ≠ 跨 store 同一冻结点**：协调器提供的同一性证据是"全部门禁停止 + in-flight 清零后才取水印"的共同 watermark 记录，而非各 store 快照时刻的偶合；头注释明确**不声称跨 store 原子提交**（逐 store 原子，协调器保证固定顺序与水印一致性）。
- **drain 超时**：记录该 store `freeze-timeout`，持久化协调记录并返回 `{status:'needs-review', frozen:[...], pending:[...]}`；已停准入的 store **保持停**（镜像 orchestrator 的 unknown 语义，绝不盲目 resume），唯一恢复入口是显式 `resumeFrozen()`（owner + coordination fence 双重授权；orchestrator 层存在 journal 时再经 `recoverRun` 原 owner/fence/确定性 operationId 恢复）。

### 第 6 条：restore 原型收敛为受控生产路径

- **两阶段哲学**（镜像 drill）：`planRollback` 全量只读预检——协调记录与 manifest 双方 success 互证、逐 store 快照 evidence 从字节重算（`snapshot-file-missing/unexpected/hash-mismatch/size-mismatch/digest-mismatch`，全部被收集而非遇首个即停）、全部目标与 live store 登记核对；任一不过 → `{allowed:false, reasons:[...]}`，**零写入**。
- **watermark 漂移双拒**：`current < frozen` → `watermark-regressed`（回退/丢失迹象，拒绝覆盖）；`current > frozen` → `new-data-since-freeze`（切换后有新数据，拒绝覆盖）并返回 `newDataSinceFreeze` 摘要（**只列计数与水印，不搬数据**；增量保全属部署职责，plan 仅报告）。不可比形状（非 number/string 且不相等）→ `watermark-incomparable`，fail-closed。
- **保护新数据**：`executeRollback` 先 plan，`!allowed` 即抛 `rollback-refused`（零写入）；逐 store 强制 `protectAfter = 冻结 watermark` 调 `restoreFrozen`；**恢复后不变量**：每 store watermark 必须 ≥ 恢复前值，违反抛 `rollback-invariant` 并如实携带逐 store 明细（含已完成 restore 的真话）；store restore 抛错 → `rollback-store-failed` 带 completed/failed/pending 明细并中止剩余。
- **回退仅切未来路由**：协调器导出面**无任何 replay 入口**（头注释 + 测试断言），未知旧 execution 不重放、不重新执行用户任务；**旧备份永不可覆盖新回执/记忆**——plan 拒新数据在先，restoreFrozen 契约保护在后，不变量兜底在最后。

### 第 7 条：合成 store / 可注入 transport 验证矩阵（11 用例全绿）

| 要求 | 测试用例（tests/freeze-coordinator.test.mjs） |
| --- | --- |
| 双 dry-run | "double dry-run…"：同输入两次 freezeAndSnapshot（不同 runId、同注入时钟/owner），manifest evidence sha256 全等；freeze-record 归一化后 deep-equal 且**digest 相等**（digest 只覆盖确定性内容：schema/版本/名称/kind/冻结水印，不含 runId/owner/fence/时间戳） |
| 四类 store 守恒 | "four store kinds conserve…"：合成 **sqlite WAL**（在线 backup + integrity_check 快照）+ **json 文件** + **目录事件** + **纯内存** store 全链 冻结→快照→转换（mock stub，真实链归 drill）→受控回退；前后计数、身份集合、内容 deep-equal 守恒；水印中性的故障注入（同 seq 坏 payload）下回退放行并复原 |
| 停写超时 | "drain timeout…"：needs-review、frozen/pending 划分、orchestrator 未启动、两 store `resumeAdmission=0`；错 owner → `recovery-not-authorized`、过期 fence → `fence-expired`（均零触碰）；正确 owner `resumeFrozen` 闭环且**逆序**恢复准入 |
| 部分失败 | "partial stopAdmission failure…"：第二 store 失败 → 第一 store 恢复准入（`resumeAdmission=1`）、`freeze-partial` 明细正确、`readdirSync(rootDir) === []`（零冻结记录、零 run 目录） |
| 恢复重开 | "resumeFrozen reopens a hand-written pre-snapshot scene…"（协调层崩溃场景，仅恢复登记且匹配的 store，ghost store 被忽略且零触碰）+ "resumeFrozen recovers an orchestrator needs-review run…"（quiesce-unknown 场景经 recoverRun 语义恢复，确定性 operationId 重放，错 owner 拒绝） |
| 回退中断/拒绝 | "planRollback refuses watermark regression and post-freeze data…"：先 regression 拒、修复后 post-freeze 数据拒、`newDataSinceFreeze` 摘要精确（frozen/current/direction）、executeRollback 抛 `rollback-refused` 且 store 字节不变、restoreFrozen 零调用；增量处置后 plan 转绿（守卫精确性）；"a tampered snapshot manifest…"：manifest 篡改 → `snapshot-hash-mismatch` 只读侦测、拒绝零写入 |
| 切换后有新数据 | 同上（new-data-since-freeze 分支） |
| 恢复后不变量违反 | "executeRollback reports a post-restore watermark invariant violation…"：违约 store 被报 `rollback-invariant`（moved-backwards），已完成的 restore 如实列出，绝不洗白 |
| 逐文件 rename 不宣称原子 | 模块头注释 BOUNDARIES 明示；orchestrator 消费用例断言 lock 顺序（quiesceOrder=注册序、resumeOrder=逆序）与确定性 ctx，而非任何跨 store 事务承诺 |
| 配置守卫 fail-closed | "config guards fail closed…"：缺协议方法 → `invalid-store`、重名 → `duplicate-store`、runId 逃逸 → `invalid-run-id`、root 出界 → `root-outside-allow-root`、未知 run → `freeze-record-missing`、未登记 store → `not-in-snapshot`；全部发生在任何 stopAdmission 之前 |

## 验证（原始命令与退出码）

| 命令 | 结果 |
| --- | --- |
| `node --test --test-reporter=dot tests/freeze-coordinator.test.mjs` | **11 pass / 0 fail，exit 0** |
| `node --test --test-reporter=dot tests/snapshot-orchestrator.test.mjs tests/migration-rollback-drill.test.mjs tests/state-converter.test.mjs` | **50 pass / 0 fail，exit 0**（快照/演练/转换套件零回归；orchestrator 套件 27 项原样通过） |
| `node --test --test-reporter=spec tests/freeze-coordinator.test.mjs` | 复核 11/11，exit 0 |

基线声明：HEAD `c0125a8`；未执行任何 git 命令；未读写生产/launchd 状态（全部夹具为自建 `os.tmpdir()/freeze-coord-*` 合成树）；未外呼、未重启服务、未改 `docs/audits/**`。

## 偏差与诚实边界（未覆盖项）

- **生产四类真实 store 适配器属部署批**：本批全部 store 为合成实现（sqlite 用真实 WAL + 在线 backup，json/目录/内存为手写适配器）；mem0/微信等真实 store 的注入式停写接线未发生，同 p6-r2 边界。
- **跨 store 原子性不声称**：头注释明示逐 store 原子 + 固定顺序 + 水印一致性；测试亦无跨 store 事务断言。
- **state-converter 未改动故未做转换端到端**：守恒链中"转换"为 mock stub（仅证明协调器交出可核验快照文件）；真实 snapshot→convert 链路由 migration-rollback-drill（55 项消费方套件零回归）覆盖。
- **非 macOS 未验证**：全部验证在 macOS（Darwin，Node v24.15.0）；rename 语义/目录 fsync 未在 Linux/Windows 复测。
- **watermark 序约束**：number 数值序、string 码点序（定宽复合串适用）；其余形状仅支持相等比较，不可比即 `watermark-incomparable` 拒绝——复合水印需由适配器编码为定宽串/数值。
- **resumeFrozen 的场景判定**：以 orchestrator journal 存在性为准决定走不走 recoverRun（协调层崩溃 → 只恢复准入；运行中断 → recoverRun 语义）；记录与 journal 的 runId 必须互证，否则 `freeze-record-inconsistent`。
- **畸形/截断 freeze-record.json**：`freeze-record-invalid`（本模块原子写产出，畸形仅可能来自外部篡改/截断）。
- **orchestrator run() 非 success 时准入保持 stopped**（其 resume 只撤 quiesce，不撤 admission），须 resumeFrozen 闭环——已在 needs-review 用例中断言。
- **SIGKILL 探针**：本批未做真实子进程探针（r2 已有 orchestrator 级探针；协调记录与其同原子写哲学，崩溃场景以手写半截记录 + journal 场景模拟覆盖）。

## 要求审计方做什么

- 复核 §6-5/6/6-7 逐项应答与上表"要求 → 用例"映射，特别是：停写超时后**保持停准入、绝不盲目 resume**的语义；`freeze-partial` 的逆序恢复准入与零落盘断言；`rollback-refused`/`rollback-invariant` 的零写入与如实报告。
- 裁决以下设计点：
  1. **watermark-regressed 一律拒绝覆盖**（即使回退理论上能救回数据）是否符合"检测 watermark 漂移即拒绝覆盖"的合同口径，regressed 场景是否应另设人工通道；
  2. **双 fence 模型**：协调层 fence 与 orchestrator journal fence 同源 TTL、独立 token，resumeFrozen 两层各自校验——授权边界是否认可；
  3. **职责切分**：`newDataSinceFreeze` 只出摘要不搬数据、增量保全归部署方——是否在部署批前需要协调器侧保全工件；
  4. **协调记录命名空间**：`rootDir/.freeze-coordination/<runId>/freeze-record.json` 与 orchestrator run 目录并存的布局是否接受。
- 本包非 Grant/Approval；不授权生产停写、快照、回退、迁移或部署。
