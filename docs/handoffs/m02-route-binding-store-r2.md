# 执行交接包：M02/I03c route-binding SQLite 持久化存储（r2，按审计 Finding 返工）

回应 [m02-route-binding-store-r1 审计](../audits/m02-route-binding-store-r1.md)（CHANGES_REQUESTED）。r1 交接与证据保留不覆盖；本文件为**新文件**，与同域的 [route-binding r2](m02-route-binding-r2.md) 同批返工。

## 批次身份与状态

- batchId / revision：m02-route-binding-store / **r2**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；branch `feat/0.3.0-progress`；cwd `/Users/markus/ai-agent-cockpit`；返工由该会话 subagent（deepseek-flash）实现，主 Agent 定返工契约、裁决偏差、亲自复跑
- 已读并确认协作协议：是。允许写入：`runtime/route-binding-store.mjs`、`tests/route-binding-store.test.mjs`、docs/handoffs/、docs/audits/evidence/。**未改** package.json；**未触碰** runtime/route-binding.mjs（本批仅由 store import）、contracts.mjs / pi-adapter.mjs、上一版交接、r1 证据；**未打开生产 DB、未 chmod 真实用户文件**
- 对应：M02 / I03c（第二切片）；验收矩阵 V03（写提交与入队之间注入失败 → 原子无半条状态的接口层）
- 本批目标：按 RBS-F001 实现 fail-closed poison 与 close 后全面拒绝；按 RBS-E001 在**任何 chmod/DDL 之前**做来源（provenance）校验。明确不做：legacy adapter 本体、真实路由接管、WAL、生产、commit/push

## 固定来源

- base HEAD：未在本批核验（本批**未执行任何 git 命令**）；工作树为 `feat/0.3.0-progress` 在途未提交内容
- 本批文件（SHA256，2026-10-08 冻结，**完整哈希**）：
  - `runtime/route-binding-store.mjs`（修改，289 → 426 行）`9d99dcb828a39f794a360c71c2f76d43321b873af8d666031e04769c56ad17a4`（r1 `1a5fc542…0b35c6`）
  - `tests/route-binding-store.test.mjs`（修改，10 → 18 用例）`4e83ad7a6b2a9827548c033f97ea6fd6e4a3f6c2ba4d04325e3880b7e3b157cd`（r1 `92e72416…9ae02a`）
  - `package.json`（**未改**）`b46f4bc95650da0b217ede96cc6b5733acab9ceb0ec5666c2a35c31da5818aaf`
- 直接依赖（同批返工，未在本文件改）：`runtime/route-binding.mjs 5148669a0baff140…168d4a`
- 全部 sourceRef（含 evidence 日志哈希）见 [source-ref.sha256](evidence/2026-10-08-rb-rbs-r2/source-ref.sha256)
- 依赖：无新依赖（node:sqlite 内置）；测试全 mkdtemp 临时目录
- 自测前后 sourceRef 一致（同一冻结副本复跑）

## Finding 逐条回答

### RBS-F001（高 / 阻断：失败重载后下一次重试返回未持久的成功）→ 已修复（fail-closed poison）

- **根因**：r1 `rollbackMemory` 吞掉重载异常后仍保留已增长的内存注册表；下一次同 binding 走「size 未变 → 直接返回」的幂等路径 → 假成功（memorySize>durableSize）。`close` 只关 DB，不阻止后续 API。
- **修复**：
  1. 新增 `assertUsable()` 门：`closed` → `RouteBindingError("store-closed")`；`poisonReason !== null` → `RouteBindingError("store-poisoned")`，错误信息含**诚实原因**。
  2. 所有 API 入口先 `assertUsable()`：`bind` / `resolve` / `planEffect` / `recover` / `size` / `intentCount`（含幂等路径——**先确认 store 可用**再决定幂等返回）。`close()` 置 `closed=true`。
  3. **任何写路径失败**（INSERT/COMMIT 任意一环）→ `poisonAfterWriteFailure(error)`：best-effort 从 durable 重载；**若重载也失败则把内存注册表置空**（不再保留已增长记录），并记 poison 原因（含 reload 失败原因），随后**原样抛出根因**。绝不吞错后声称零偏差。
  4. 受控恢复 `recover()`：从 durable 重载并经 route-binding 的 `fromJSON` 全量校验；失败则保持 poisoned 并抛 `store-poisoned`；成功才清除 poison。
- **理由**：审计两复现——① close 后 bind 第二次同 binding 假成功（memorySize=1/durable=0）：现第二次直接 `store-closed`；② 保持打开、写失败+reload 失败后下一次同 binding 假成功：现第二次 `store-poisoned`，且未 COMMIT 的 record **永不**被报告为成功 persisted。

### RBS-E001（高 / 接线阻断：未知既有库被 bootstrap 接管）→ 已修复（打开即来源校验）

- **根因**：r1 打开即 `chmod` + 建 `meta`/`bindings`/`intents`，把任意既有 SQLite 当作本库接管。
- **修复**：新增 `assertStoreProvenance(absolute)`，**在 chmod 与任何 DDL 之前**执行：
  - 路径不存在 → 允许 fresh 初始化；
  - 已存在 0 字节普通文件 → 允许初始化；
  - 符号链接 / 非普通文件 → `RouteBindingError("unsafe-store-path")`（不跟随）；
  - 已存在非空 → **只读**探针查 `meta.store_namespace`；等于 `STORE_NAMESPACE="personal-ai-os/route-binding-store"` → 允许；否则 `RouteBindingError("unknown_existing_db")`。
  只读探针不写主文件、不建 journal/wal，故被拒文件 **bytes/mode/目录项零变化**。
- schema 变更：`meta` 现含 `store_namespace` 标记行 + `schema_version`（建库时写入）；版本冲突（我们自己的库）仍 `unsupported-schema-version`。
- **理由**：不默认任何 SQLite 都是本库；`absent/0字节` 与「有有效 namespace 的恢复库」区别处理，明示 unknown 既有库拒绝。
- **交付级诚实声明**：provenance gate 会**拒绝 r1 旧库**（无 namespace 标记）。因该模块从未接线生产、无生产 r1 库，故无迁移影响；若将来存在 r1 真实库，需显式迁移（不在本批）。

### 继承 RB-F001（同批 route-binding r2）

store 的 `loadRegistry` 通过 `route-binding` 的 `fromJSON` 重建内存；因此 r2 的 intent 冲突/恢复唯一性语义自动生效——durable 里存在同 key 不同 task 的矛盾 intent 时，打开/`recover` 会 `intent-conflict` 拒绝，而非静默取最后。

### 关键 diff 摘要（route-binding-store.mjs）

- `+ STORE_NAMESPACE_KEY / STORE_NAMESPACE`；`+ assertStoreProvenance()`（在 `mkdirSync` 之后、`new DatabaseSync`/`chmodSync` **之前**调用）。
- bootstrap：先写 `store_namespace` 再写 `schema_version`；namespace 不符 → `unknown_existing_db` 并 `db.close()`。
- `+ closed / poisonReason` 状态；`+ assertUsable()`；`rollbackMemory`（吞错）**删除**，替换为 `poisonAfterWriteFailure()`（poison + best-effort 重载，重载失败置空）。
- `bind/planEffect`：入口 `assertUsable()`；写失败 `poisonAfterWriteFailure(error); throw error;`（原为吞错后 `return record/intent`）。
- `resolve` 入口 `assertUsable()`；`size/intentCount` getter 入口 `assertUsable()`。
- `+ recover()` 并加入返回对象；`close()` 幂等。

## 反向负例清单与原始结果摘要

新增 8 条固定负例（`tests/route-binding-store.test.mjs`，11–18），逐条锚定审计复现：

| 负例 | 断言 | 锚定 | r2 结果 |
| --- | --- | --- | --- |
| 11 every API is refused after close | bind/resolve/planEffect/recover/size/intentCount 均 `store-closed`；零写入 | 复现① 闭后 API 仍可用 | 通过 |
| 12 failed INSERT poisons; retry refused | 触发 INSERT 失败后同 binding 重试 `store-poisoned`；durable 行数不变 | 复现① memorySize=1/durable=0 | 通过 |
| 13 write failure + reload failure stays poisoned | 异连接写非法 JSON + INSERT 触发失败；保持打开；重试 `store-poisoned`，`recover()` 亦 `store-poisoned` | 复现② 假成功 | 通过 |
| 14 failed COMMIT poisons | 第二连接持 SHARED 读事务使 COMMIT 失败；重试 `store-poisoned`；durable 0 行 | INSERT/COMMIT 失败矩阵 | 通过 |
| 15 failed intent INSERT poisons | planEffect 写失败→`store-poisoned`；intent 行 0 | intent 路径故障窗口 | 通过 |
| 16 existing foreign DB refused untouched | `unknown_existing_db`；前后 **bytes 相等 / mode 不变（非 0600）/ 目录项不变 / 仅存 foreign 表** | RBS-E001 接管缺口 | 通过 |
| 17 zero-byte file fresh init + valid reopen | 0 字节可初始化；有效库正常重开且记录完整 | fresh 与恢复库区别 | 通过 |
| 18 symlink / non-regular refused | symlink → `unsafe-store-path` 且目标 bytes 不变；目录 → `unsafe-store-path` | 非普通/alias 拒开 | 通过 |

**负例的负例证据（r1 代码上必失败）**：把三处修复（provenance gate 调用、`assertUsable` 调用、poison 行为）逆向回退到 r1 语义的临时副本上运行本套件 → `tests 18 / pass 11 / fail 7`，失败的正是 11–16、18（17 属未变行为，仍过）；原始日志 [route-binding-store-negative-on-prefix.log](evidence/2026-10-08-rb-rbs-r2/route-binding-store-negative-on-prefix.log)。

## 实现、自测与证据

| 要求/Case | 当前实现 | 验证命令/API与cwd | 退出码/断言/效果计数 | evidenceRef | 尚未覆盖 |
| --- | --- | --- | --- | --- | --- |
| RBS-F001 poison | 写路径失败即 poisoned，幂等/resolve/写一律拒绝，`recover()` 受控恢复 | `npm run test:route-binding-store`（仓库根） | **18/18 pass，exit 0** | [route-binding-store-r2.log](evidence/2026-10-08-rb-rbs-r2/route-binding-store-r2.log) | 多写者/owner/fence |
| RBS-E001 provenance | chmod/DDL 前来源校验；未知拒绝且零变化 | 同上 | 对应用例通过 | 同上 | 生产共库迁移方案 |
| r1 原契约回归 | 持久化/冲突/幂等/崩溃原子/过期/版本/权限/一致性 | 同上 | 10 条原用例仍全过（其中 7 更新为含 namespace） | 同上 | — |
| 相邻回归 | legacy adapter（openBindingStore 消费者） | `npm run test:legacy-adapter` | 14/14 pass，exit 0 | [legacy-adapter-regression.log](evidence/2026-10-08-rb-rbs-r2/legacy-adapter-regression.log) | — |

- 真实模型/原文外呼/生产读写/原生会话/微信外发：**均未发生**；全合成临时目录（`mkdtemp`）。私有 second connection / trigger / SHARED-lock 均只作用于自建临时 DB。
- 失败、部分结果和不明副作用：无。偏差登记：新增错误码 `store-closed` / `store-poisoned` / `unknown_existing_db` / `unsafe-store-path`；`dbPath` getter 为纯定位符，close 后**仍返回路径**（不拒绝）——与「close 后所有 API 拒绝」的偏差（见边界）；r1 审计探针因行为已变需 r2 新探针（本批 8 条负例即 r2 定向探针）。
- 活动进程/job/handle：无。
- 数据守恒、回退和恢复方法：删除本批两个文件即回退 r1；DB 语义仍由 SQLite 事务保证；poison 后经 `recover()` 或重建实例恢复。
- 状态分列：实现完成 ✅（本批范围）；自测通过 ✅（主 Agent 亲自复跑）；独立审计：⏳ 待审计 AI；部署/真机：未做。

## 诚实边界与未覆盖项

- **provenance TOCTOU**：`assertStoreProvenance` 用 `lstat` 预检，随后 `new DatabaseSync` 重新打开，二者之间存在极小竞态窗口（`lstat → open` 的路径替换）。本批未做 fd/fencing 级防护。已披露的 symlink 缺口以「拒绝软链/非普通文件」收窄，但**跨进程竞态未闭环**。
- **COMMIT 失败复现**依赖 SQLite 的锁语义（第二连接持 SHARED 读事务使 COMMIT 需 EXCLUSIVE 时失败）；在本机 Node 24 上确定性复现（日志 14 通过），但属环境相关技术，非跨平台保证。
- **r1 旧库无 namespace → 现被 `unknown_existing_db` 拒绝**：有意 fail-closed；无生产 r1 库故无迁移影响；若将来存在，需显式迁移方案（另包）。
- `recover()` 只做**本连接可见 durable** 的一致性重载，不做跨进程/跨文件锁的一致性校验。
- 未做：多写者/owner 化（单写者假设须产品 owner/fence 实证）；WAL；schema 迁移策略；binding 与 Submission 的跨层原子准入（不把每次一条 INSERT 说成整个 V03 跨层事务已满足）。
- 本次仅在**普通 shell** 复跑（未再套 sandbox-exec OS 隔离）；未打开任何真实用户 DB。

## 要求审计方做什么

- 审计范围与重点风险：`runtime/route-binding-store.mjs` 与 `tests/route-binding-store.test.mjs`。建议重点：① poison 语义是否覆盖全部写路径与幂等重试（`size` 未变分支已在入口门后）；② `assertStoreProvenance` 的 TOCTOU 边界与 namespace 设计的取舍；③ `recover()` 的重载一致性边界；④ `dbPath` 不拒绝是否接受。
- 已知不足/需决定的方案：见上「诚实边界」；共库迁移与多写者 owner 化待产品决定。
- 等待期间将继续的无冲突独立任务：I03c 第三切片 legacy adapter 本体设计（消费本 store）；同批 [route-binding r2](m02-route-binding-r2.md)。
- 返工 revision：本文件为对 RBS-F001 / RBS-E001 的返工交接（r2），并继承 RB-F001。
