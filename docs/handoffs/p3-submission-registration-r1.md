# 执行交接包：P3 / Wave 2.2 桥侧 runtime Submission 登记（r1）——admitIncoming 唯一、持久登记

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双 AI 协作协议](../plans/0.3.0-collaboration.md)。本包逐条回应 [p3-readiness-r1](p3-readiness-r1.md) 第 30、43 行识别的 **“唯一 runtime Submission 登记（零）”** 缺口，落地地图给出的插入点（`admitIncoming`，现 `bridge.ts:720`）。r1 交接与旧文件保留不覆盖。

## 批次身份与状态

- batchId / revision：p3-submission-registration / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行 AI：Kimi Code 会话（执行方）；branch `feat/0.3.0-progress`；cwd `/Users/markus/ai-agent-cockpit`；subagent（deepseek-flash）实现，主 Agent 定稿设计合同、亲自复跑
- 已读并确认协作协议：是。本批允许写入且实际写入：`vendor/wechat-acp/src/storage/submission-registry.ts`（新文件）、`vendor/wechat-acp/src/bridge.ts`、`vendor/wechat-acp/tests/submission-registry.test.ts`（新文件）、`vendor/wechat-acp/tests/bridge-submission.test.ts`（新文件）、`docs/handoffs/p3-submission-registration-r1.md`（本文件，新文件）。**未改** `package.json`（仓库根与 vendor 均未改）、`docs/audits/**`、`docs/plans/**`、任何生产服务/launchd/真实用户文件；**未执行任何 git 命令**；**未新增任何依赖**
- 对应：B02/P3 前置。验收：桥侧对每条入站微信消息登记唯一、持久、跨重启存活的 runtime Submission；登记失败 fail-closed，消息留在 inbox 等既有 monitor/sweep 重试，绝不假装已处理
- 本批目标：Submission 登记落地。明确不做：接真实微信、发真实消息、dispatch 时的真正 runtime 绑定接线、生产重启/部署、任何 git 操作
- vendor 说明：`vendor/wechat-acp/` 目录**无**自己的 `AGENTS.md`，故遵循仓库根 `AGENTS.md`；使用 vendor 自带测试 runner `node --import tsx/esm --test 'tests/**/*.ts'`，不新增依赖

## 固定来源

- base HEAD：`32fe74e71df73b9c278246ad6a618abe8e98088a`（读 `.git/HEAD` 与分支 ref `refs/heads/feat/0.3.0-progress` 得到；**未执行任何 git 命令**）
- 变更文件（SHA256，2026-10-08）：
  - `vendor/wechat-acp/src/storage/submission-registry.ts` `5b1ed2265c49bef337240ee4e6679603ec01e5524f28812ff839bfc361ae5e3d`（新文件，382 行）
  - `vendor/wechat-acp/src/bridge.ts` `9d83b139a48d3f40888979524a618dbfe185e14b06eb1fddf55c84628202f8de`（2456 行；本批新增 import ×1、字段 ×1、构造块 ×1、startup 对账调用 ×1、close ×1、admitIncoming 重写 + 2 个新私有方法）
  - `vendor/wechat-acp/tests/submission-registry.test.ts` `cabb40d79ab3e958b4d350a98a5e7c07ce7376345421c0bccbccdd3b9b026800`（新文件，194 行，**11 用例**）
  - `vendor/wechat-acp/tests/bridge-submission.test.ts` `14224a4ccbc4575f7a7aed31e95f1f4be9aab5cd9dbf2f1cf9d934e626222b51`（新文件，159 行，**5 用例**）
  - `docs/handoffs/p3-submission-registration-r1.md`（本文件；其 SHA256 见执行方回报，因自引用不入上表）
- `package.json`（仓库根与 vendor）均**未改**；复用既有脚本：`test:runtime-policy`（含 `npm --prefix vendor/wechat-acp run build`）、vendor `test` = `node --import tsx/esm --test tests/**/*.ts`
- 依赖：无新依赖（仅 `node:crypto`/`node:fs`/`node:path` + 包内 `../weixin/types.js`，与 message-inbox/reply-outbox 同族）
- 构建产物：按要求跑了 `npm --prefix vendor/wechat-acp run build`（`tsc`，strict，exit 0），`vendor/wechat-acp/dist/` 随之重新生成（既有构建步骤，非源码改动）
- 自测前后 sourceRef 一致；只有上列源/测试文件按授权变更；`bridge.ts` 变异实验已还原并校验 SHA256（见下“反向负例”）

## 已定设计决策与偏差决策

### 已定（主 Agent 定稿，本批照做）

- 插入点：`admitIncoming`（现 `bridge.ts:720`）中 `messageInbox.put` 返回 `isNew` 后、返回 `true` 前登记；数据源 `record.id`（=sourceRequestId）+ `from_user_id`（=ownerId）。
- 记录形状：`{ receiptId, userId, payloadDigest, registeredAt, state: 'registered' }`；本批不预留 dispatch 假字段。
- 文件存储于 `config.storage.dir/submission-registry/`，沿用 reply-outbox/message-inbox 的既有 idiom（原子 tmp+rename、`loadAll`、串行 `run` 队列、`close` 生命周期、0700/0600）。
- 语义合同对齐 route-binding-store r2：持久化、启动校验、写失败 poison fail-closed、幂等/冲突、`recover()`/`close()`。

### 偏差决策 ①（**待审计裁决**）：语义复用而非模块本体复用（包边界）

p3-readiness 第 36 行原写“复用 route-binding-store”（`runtime/route-binding-store.mjs`）。本批**不 import 该模块本体**，只复用其 **r2 语义合同**，理由是包边界与构建约束：

- `vendor/wechat-acp/package.json` 声明 `engines.node >= 20`，存储全为**文件型**，`tsconfig` 为 `strict` 且**无 `allowJs`**，包内**无任何跨包 import 先例**；其模块系统为 `NodeNext`，import 需显式 `.js`。
- `runtime/route-binding-store.mjs` 是**根侧** `.mjs`，依赖 `node:sqlite`（`DatabaseSync`），且非本包发布物。直接 import 会破坏包边界（vendor 发布时不含根侧 `runtime/`）、触发构建/解析问题。
- 因此 `submission-registry.ts` 独立实现**文件型**持久化，逐条对齐 r2 的可观察语义（见下“合同逐条↔r2 对齐”）。**dispatch 时真正的 runtime 绑定仍由根侧 route-binding-store 承担**，属后续 Wave；本批只产出桥侧 Submission 身份。

**请审计方裁决**：是否接受“语义复用 + 文件型实现”，抑或要求以其它方式（如抽取根侧纯逻辑到包内可依赖的形态）实现模块复用。

### 偏差决策 ②（**待审计裁决**）：payloadDigest 取值

任务原文：“payloadDigest 来源：优先复用 inbox record 自带的 identity digest（先读 message-inbox.ts 的 record 形状确认字段名），没有则由桥侧对规范化正文计算 sha256。”

**核对结果：`MessageInboxRecord` 形状为 `{ id, message, status, receivedAt, errorKind?, execution? }`，其中并没有独立的 `identityDigest`/`payloadDigest` 字段。** `record.id` 本身就是 inbox 的 sha256 **identity digest**（`computeId`：sender+recipient+server id，无 server/client id 时才回退到整包内容摘要），同时它就是 `sourceRequestId`。

因此按契约的 **fallback 分支**处理：桥侧对**规范化正文**计算 sha256 —— `computePayloadDigest(message) = sha256(canonicalize(message 去掉 context_token))`（与 message-inbox 的 `canonicalize`/`withoutContextToken` 同构）。取此值而非 `record.id` 的**理由**：使 `payloadDigest` 与 `receiptId` 相互独立，让 `register` 的“同 receiptId 不同 digest → 冲突”语义非空、承重（若两者恒等，冲突守卫即退化为恒真而不承重）。**若审计方更认同“直接复用 `record.id` 作为 payloadDigest”**，改动是局部的（`bridge.ts:745 registerSubmission` 一行 + 断言）。

## 合同逐条（`SubmissionRegistry`）

**(1) 记录形状**：`{ receiptId, userId, payloadDigest, registeredAt: number, state: 'registered' }`，写入冻结对象。

**(2) `register({receiptId, userId, payloadDigest})`**：
- 同 `receiptId` + 同 `payloadDigest` + 同 `userId` → **幂等**：返回既有冻结记录，**不写盘**（`records.get` 命中即返回）。
- 同 `receiptId` + 不同 `payloadDigest`（或不同 `userId`）→ 抛 `SubmissionRegistryError('registration-conflict')`，**零状态变化**（fail-closed，既有记录逐字不动）。
- 字段缺失/类型错/`receiptId` 不合 `[A-Za-z0-9_-]{1,128}` → 抛 `('invalid-registration')`。
- 新记录：先 `persist`（原子 uuid-tmp + fsync + rename，0600；目录 fsync 尽力而为），成功后再入内存 map。

**(3) poison fail-closed**：任何 `persist` 失败 → `poisonAfterWriteFailure`：置 poison，尽力从磁盘重载（重载也失败则清空内存 map，绝不让未持久化记录冒充权威），随后**重抛原始写错误**。此后一切 API（`register`/`getRegistration`/`has`/`count`/`recover` 前）在 `assertUsable` 拒绝，`code='store-poisoned'`，带原因，**绝不假成功**。

**(4) `recover()`**：只读重载并重校验磁盘真相，清 poison；重载失败则保持 poisoned 并抛 `('store-poisoned')`。（写失败导致的 poison，只要存储**可读**即能被 `recover()` 清除——写失败不影响读；下一步写会再次 fail-closed。）

**(5) `close()`**：`closed=true`，等待 `ready` 与串行队列排空；此后一切 API 抛 `('store-closed')`。

**(6) 启动加载 fail-closed**：构造时异步 `readAll()`，逐文件 `parseRegistration` + 文件名↔`receiptId` 一致性校验；任一文件损坏/JSON 不可解析/schema 不符/身份不符 → **poison（拒绝），绝不静默丢记录**（`count()` 会以 `store-poisoned` 拒绝，而不是少报）。

**(7) 查询/观测**：`getRegistration(receiptId)`（未知 → `undefined`）、`has(receiptId)`、`count()`；三者皆 `assertUsable` + 校验入参。

**(8) `computePayloadDigest(message)`**（导出）：`sha256(canonicalize(去 context_token 的 message))`，确定性、忽略投递 token。

### 合同逐条 ↔ route-binding-store r2 对齐

| r2 可观察语义 | submission-registry 对齐点 |
| --- | --- |
| 持久化单记录原子写（r2 用 SQLite `BEGIN IMMEDIATE`…`COMMIT`） | uuid-tmp + `fsync` + 原子 `rename`（文件 idiom；单文件单记录天然原子） |
| 启动来源/格式门（`unknown_existing_db`/`unsafe-store-path`/版本不符即拒） | `readAll` 逐文件 schema 校验 + 文件名↔id 一致，任一不符即 poison |
| 写失败 → `store-poisoned` 直到 `recover()`（RBS-F001） | 逐字对齐：`persist` 失败即 poison，之后全 API 拒，直到 `recover()`/重建实例 |
| `assertUsable` 前置门（closed 优先、poison 次之） | 同 |
| `bind()` 幂等 / `binding-conflict`；冲突零状态变化 | `register()` 幂等 / `registration-conflict`；冲突零状态变化 |
| `recover()` 重载校验清 poison；失败保持 poison | 同 |
| `close()` 后所有 API 拒（`store-closed`） | 同 |

## 关键 diff 摘要（`bridge.ts`，全部插在既有 LF 区块，未动 CRLF 行）

1. **import**（`:56` 后 +1 行）：`import { SubmissionRegistry, computePayloadDigest } from './storage/submission-registry.js';`
2. **字段**（`:141` 区 +1）：`private readonly submissionRegistry?: SubmissionRegistry;`
3. **构造**（`:155-160`）：把原单行 `messageInbox` 创建包成块，**在同一条件内**创建 `submissionRegistry`，dir = `path.join(config.storage.dir, 'submission-registry')`（与 messageInbox 同生共死）。
4. **startup 对账**（`startOwned`，`:380`）：`await this.replyOutbox?.recover(); await this.recoverIncoming();` 之后 `await this.reconcileSubmissions();`（幂等补登记历史未登记记录）。
5. **close**（`:458`）：`await this.submissionRegistry?.close();`（夹在 `messageInbox.close()` 与 `replyOutbox.close()` 之间）。
6. **`admitIncoming` 重写**（`:720-742`）：
   - 早返回分支 `if (this.receiptIds.has(msg)) return true;` → `if (this.receiptIds.has(msg)) { await this.registerSubmission(this.receiptIds.get(msg)!, msg); return true; }`。**关键**：sweep 重试（`bridge.ts:875` 先 `receiptIds.set` 再 `handleMessage`，`:876`）与 `recoverIncoming`（`:948`）都会走此早返回分支；在此登记使“登记失败→留在 inbox→既有重试路径”真正**重跑登记**而非静默跳过。
   - `isNew` 分支：`this.receiptIds.set(...)` 后、`return true` 前 `await this.registerSubmission(result.record.id, result.record.message);`。**登记失败（含 poisoned）→ 抛错**，`handleMessage` 的 `admitIncoming` 抛，消息留在 inbox（put 已持久化），绝不 `return false` 假装已处理。
7. **新增 2 私有方法**（`:744-765`）：`registerSubmission(receiptId, message)`（无 registry 则 no-op，否则 `register({receiptId, userId: from_user_id, payloadDigest: computePayloadDigest(message)})`）；`reconcileSubmissions()`（遍历 inbox，`has` 为假则补登记，幂等，异常 fail-closed 上抛不吞）。
   - 对账挂载点**选择说明**：既有 `sweepRecovery`（`bridge.ts:857`）只对 `received/queued/retry_wait` 非命令记录补处理，覆盖不到命令/终态历史记录，故**另起一次启动扫描**（`startOwned` 内），确保“inbox 中已存在但无登记的记录”全覆盖。选择即为主 Agent 允许的“在 start/init 路径加一次扫描”。

`handleMessage`、`/消息`、`/acp-more`、缓冲、outbox drain 等**一行未动**。

## 反向负例清单与原始结果

**a) 新增用例（正向）**：
- 模块级 11：登记字段精确/幂等不重复/冲突零变化（digest 或 owner 变更）/参数拒绝（缺字段、类型错、非法 id、空串）/写失败 poison 后全 API 拒 + `recover()` 从盘恢复/recover 在存储不可读时 fail-closed/损坏文件不静默丢/schema 不符与身份不符 poison/跨实例持久/close 后全拒/`computePayloadDigest` 确定性与忽略 token。
- 桥级 5：入站登记字段精确（`payloadDigest === computePayloadDigest(record.message)`）/同 server id 重放幂等不重复登记且只派发一次/poisoned 时入站抛错且 inbox 记录仍在（status `received`、未派发、未假装已处理）/重启新实例同目录登记仍在/启动对账补登记历史未登记记录且二次调用幂等。

所有用例为 tmp 合成夹具（`fs.mkdtemp`）+ 注入内存 session 假体；**未接真实微信、未发真实消息**。

**b) 承重验证（逆向变异，证明新负例真会捕获“登记缺失”回归）**：把 `bridge.ts` 原文件备份到 `/tmp/bridge.ts.submission-backup`（字节级，SHA256 `9d83b139…02f8de`），将 `admitIncoming` 的 `isNew` 分支登记调用替换为 `/*MUTANT: admission does not register a submission*/`（仅模拟“不登记”，不动模块本体），重跑 `tests/bridge-submission.test.ts`：

| 变体 | 变异 | 结果（同一测试文件） |
| --- | --- | --- |
| original（本轮源码） | 无 | **5/5 pass，0 fail** |
| mutant | `admitIncoming` 不登记 | **1 pass / 4 fail** |

mutant 下失败的 4 条（原始断言输出）：
- `an admitted inbound message records the exact runtime submission` → `AssertionError: the receipt must be registered`（`actual: undefined, expected: true`）
- `a replayed delivery is idempotent and never double-registers` → `AssertionError: the replay must not create a second submission`（`actual: 0, expected: 1`）
- `a poisoned registry fails admission and keeps the durable inbox record` → `AssertionError: Missing expected rejection.`
- `a registration survives a bridge restart (same dir)` → `AssertionError: the submission must persist across a restart`（`actual: false, expected: true`）

第 5 条（启动对账）在 mutant 下仍**通过**，符合预期——它直接调 `reconcileSubmissions()`，不经过 `admitIncoming`。结论：4 条用例精确捕获“入站未登记”这一回归。还原后 `bridge.ts` SHA256 与备份逐字一致（`9d83b139…02f8de`），无 `MUTANT` 残留（`grep -c MUTANT` = 0）。

## 验证

| 要求/Case | 实现 | 验证命令与 cwd | 结果 |
| --- | --- | --- | --- |
| 登记唯一、字段正确、持久 | `register` + 原子 persist | `node --import tsx/esm --test tests/submission-registry.test.ts`（vendor） | ✅ 11/11 pass |
| 幂等/冲突零变化/参数拒 | `records` map + 校验 | 同上 | ✅ 同 |
| 写失败 poison→全拒→recover 恢复 | `poisonAfterWriteFailure`/`recover` | 同上 | ✅ 同（含存储不可读时 recover fail-closed） |
| 损坏文件不静默丢 | 构造期 `readAll` poison | 同上 | ✅ 同 |
| 入站登记字段正确 | `admitIncoming` isNew 分支 | `node --import tsx/esm --test tests/bridge-submission.test.ts`（vendor） | ✅ 5/5 pass |
| 重放幂等不重复登记 | receiptId 早返回 + put 去重 | 同上 | ✅ 同 |
| poisoned 入站抛错、消息不丢 | 登记失败上抛，inbox 已持久化 | 同上 | ✅ inbox 记录 `received`、未派发 |
| 重启登记仍在 | 文件持久 + 新实例加载 | 同上 | ✅ 同 |
| 启动对账补登记 | `reconcileSubmissions()` | 同上 | ✅ 幂等补登记 |
| vendor 整包零回归 | — | `node --import tsx/esm --test 'tests/**/*.ts'`（vendor） | ✅ **tests 347 / pass 346 / fail 0 / skipped 1**（改前 331；本批 +16） |
| vendor 类型构建 | `tsc` strict | `npm --prefix vendor/wechat-acp run build`（仓库根） | ✅ exit 0 |
| 仓库运行时策略门（含 vendor build） | — | `npm run test:runtime-policy`（仓库根） | ✅ **35/35**，exit 0 |
| 仓库密文扫描 | — | `npm run audit:secrets`（仓库根） | ✅ **PASS：0 undispositioned**，exit 0 |
| 逆向变异承重 | mutant 重跑 | 见“反向负例” | ✅ 4 条登记用例在 mutant 下精确失败 |

- 真实模型/原文外呼/生产读写/launchd/微信收发/真实外发：**均未发生**。全部为 tmp 合成夹具 + 内存注入；未 chmod 任何真实用户文件（仅 chmod 测试自建的 tmp 目录并复位）。
- 失败、部分结果和不明副作用：无。sourceRef 复核：仅上列文件按授权变更；`bridge.ts` 变异实验已还原并校验 SHA256。
- 活动进程/job/handle：测试用 `after` 钩子统一 `stop()`/`close()` 并 `fs.rm` 临时目录；`/tmp/bridge.ts.submission-backup` 为一次性还原备份，位于仓库外。

## 要求审计方做什么

- 按 **B02“唯一 runtime Submission 登记”** 复核本批 diff / 新 hash / 负例与逆向变异结果。重点：① `admitIncoming` 是否在 `put` 成功（`isNew`）后、返回前登记，且**登记失败上抛**而非 `return false`（消息留 inbox 等既有重试）；② 早返回分支（`receiptIds.has`）的补登记是否使 sweep/recover 重试**真正重跑登记**；③ 模块 poison/recover/close/冲突零变化是否与 r2 语义逐条对齐；④ 启动加载对损坏/schema 不符是否 poison 而非静默丢。
- **裁决两处偏差决策**：① “语义复用而非模块复用”（包边界依据）是否接受；② `payloadDigest` 取“规范化正文 sha256”而非复用 `record.id` 是否接受（理由：使冲突语义承重）。
- 非返工前请确认：本包未触碰 `package.json`、`docs/audits/**`、`docs/plans/**`；`/消息`、`/acp-more` 等既有文案/逻辑未改。
- 等待期间继续的无冲突独立任务：p3-readiness 中“后台分离 → `/消息` 六类 → 派发窗口”等其它 T 项，以及本批后续 Wave 的“dispatch 时接根侧 route-binding-store”。

## 未覆盖项与诚实边界声明

- **dispatch 时的真正 runtime 绑定属后续 Wave**：本批只登记 Submission 身份（receiptId/userId/payloadDigest/registeredAt/state=registered），**不挂** executionId/durableTaskId/runtimeBinding 等 dispatch 链接字段（未预留假字段）。到 dispatch 时把该 Submission 绑到根侧 `route-binding-store` 由后续 Wave 完成。
- **真实微信抽验属 Markus/B02 验收**：本批只改源码 + 合成测试，**未**接真实微信、未发真实消息；真实入站消息上的跨重启登记**未经真机验证**。
- **生产未重启/未部署**：已在跑的服务仍执行旧代码；本轮为源码 + 合成测试，生产重启/部署另批，本包 READY 不授予该权限。
- **poison 的运维面**：若生产 `submission-registry/` 出现损坏文件，桥启动期对账将 fail-closed 抛错（`store-poisoned`），入站登记随之拒绝、消息留 inbox 等待，需人工修复/`recover()`。这是**刻意的 fail-closed**（对齐 r2），但**未做**运维自动修复/告警接线——如需，请单列。
- **payloadDigest 语义冗余提示**：如审计裁决复用 `record.id`，则 `payloadDigest === receiptId`，模块冲突守卫将成为防御性冗余（桥侧正常流不再触发），需同步调整 `bridge-submission.test.ts` 的 digest 断言。
- **未执行**真实外呼/生产读写/launchd/微信外发/服务重启/git；未改 `package.json`。
