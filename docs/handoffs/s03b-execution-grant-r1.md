# 执行交接包：S03b 宿主正式 per-task Grant 对象（r1，§5 第 1、2、6 条）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)。本包实现 [0.3.0 审计整改方案](../plans/0.3.0-remediation-2026-10-09.md) **§5 S03 第 1、2 条及第 6 条验收**中"宿主正式 Grant / Grant 准入 / 取消边界"部分。设计合同以主 Agent 的 S03b 任务说明为准。

**r1 更新（同日 second pass）**：补上首版自报的"入口未接线"缺口——全部 6 个生产入队入口已在 createExecution 前由宿主签发 Grant 并随记录入队前持久化；见「生产入队入口接线清单」节。首版"诚实边界 1"已消解并从该节移除。

## 批次身份与状态

- 批次：S03b（控制面侧正式 per-task Grant）。与 FG-F001 r2（vendor 桥侧 `deadlineAt`，见 [p3-foreground-background-r2](p3-foreground-background-r2.md)）互补：桥侧语义未动，本批是**控制面侧**准入工件。
- 状态：**DONE，待审计裁决**（裁决点见末节）。
- 新建：`control-plane/execution-grant.mjs`、`tests/execution-grant.test.mjs`、`tests/helpers/execution-grant.mjs`（Grant 签发小助手，合同预先授权、按铁律报告于此）、本文件。
- 修改（核心）：`control-plane/store.mjs`、`control-plane/dispatcher.mjs`、`control-plane/native-acp-executor.mjs`。
- 修改（入口接线，second pass）：`gateway/control-plane.mjs`、`interfaces/mcp/server.mjs`、`scripts/control-plane.mjs`、`control-plane/reviewer.mjs`、`control-plane/goal-runtime.mjs`、`runtime/chief-tools.mjs`。
- 修改（测试夹具/断言，零断言方向改变）：`tests/control-plane.test.mjs`、`tests/native-acp-executor.test.mjs`、`tests/approval-authority.test.mjs`、`tests/control-plane-http.test.mjs`、`tests/runtime-tools.test.mjs`、`tests/goal-core.test.mjs`。
- 未改（铁律遵守）：`vendor/`、`services/`、`docs/audits/`、`package.json` 零改动；未执行任何 git 命令；未联网；未触生产路径。

## 探明的准入链与上限来源（文件+行号，改后行号）

真实 dispatch 只有两条路径，Grant 强制点均位于**任何 spawn/外呼副作用之前**，且以**存储的**执行记录为准（RO r2 防洗白先例）：

1. **Cezar 派发**：`control-plane/dispatcher.mjs` `dispatchCezar`
   - 取队列：`store.getTask` → 找 execution → `EXECUTION_NOT_QUEUED` 检查（:72-77）；
   - replay 短路（已有 engineRef 直接返回，非新派发，:78）；
   - **Grant 强制点 :82** `assertDispatchGrant(...)`（定义 :41，verifyGrant 失败→ queued→blocked 诚实结算 + 抛 StoreError `GRANT_*`，`details.grantCode` 保留小写原码）；
   - 之后才 `consumeApproval`（:84）与外呼 `adapter.start`（:88）。
2. **Native ACP 启动**：`control-plane/native-acp-executor.mjs` `executeNativeSessionPrompt`
   - 既有准入链：queued 检查 → sessionRef 绑定 → `nativePromptPlan` → `assertSessionRefMatches` → approvalId 检查（:527-555 区域）；
   - **Grant 强制点 :557**，位于 durable launch intent（`attachExecutionRef` :566）、occupancy、`consumeApproval`、`runNativeAcpPrompt`（:591，spawn 在 :332）**之前**——拒绝时零 launch intent、零 spawn（测试断言 `engineRef === undefined`）。
3. **取消路径不设 Grant 门**：`cancelCezarExecution` / `cancelNativeExecution` 故意不校验 Grant——Grant 到期停的是**新派发**，取消通道必须始终可用以结算在飞工作。
4. **签发与持久化**：`store.createExecution` 接受可选 `input.grant` + `input.parametersDigest`，随执行记录整体 JSON 持久化（`control-plane/store.mjs:405-424`）；store 仅做廉价绑定校验（grant.taskId/executionId 必须等于本记录，否则 `GRANT_BINDING_MISMATCH` 400，移植的 grant 连持久化都进不去），完整结构/clock/过期校验 fail-closed 在派发准入点。

**现有上限来源（探明结论）**：

- `Approval.expiresAt`（可选 ISO，`control-plane/contracts.mjs:215`；消费侧 `store.mjs:590`）——签发时若已知，经 `limits.approvalExpiresAt` 参与 min；
- `runtime/budget-policy.mjs` 有执行寿命上限（`maxDurationMs → expiresAt`），但它是 **runtime 请求域**预算，未接线到控制面 dispatch，故不是本批的既成适用上限；同类能力由 `limits.maxLifetimeMs`（相对单次 issuedAt 推导，不二次读钟）提供；
- 控制面**无**全局 MAX 常数。`effectiveDeadlineAt = min(expiresAt, 各适用上限)`，缺失项不参与，推导只读一次注入时钟（测试断言 `now()` 恰好调用 1 次）。

## 固定来源（完整 sha256，shasum -a 256 实算，second pass 后）

```
aced1cf8d8d12a903ad2b3151a45be143b492db8977184eaa66cf5ea1a99bca7  control-plane/execution-grant.mjs
37c70466131ab00a0cfd31a7e944b8d6dc6e68bf785b54c003698968d8321988  control-plane/store.mjs
3332065b6aee62d3fb3adc09b908c496bb96eee53b45028fe8d726c73dbe81ef  control-plane/dispatcher.mjs
a30d3c20186a4ce2ce30c713c471216550183eef54cb7478d0fc33c85ac8afe6  control-plane/native-acp-executor.mjs
3393b4cc180252bbe1bac97ec62106b333ec5972f1e2eb1663888cc7c96e2f35  control-plane/reviewer.mjs
217395a644f2a7adb859c3c3a156a2a8066d5ca864e361bc2f20224371a79202  control-plane/goal-runtime.mjs
f9633c7b2f3be05cd59628d1092dca3af930185ebfc24a1b859459621379becb  gateway/control-plane.mjs
f7ade1bc1f0a38cfe3376a324a8368c77af348f30d84ee53ad65d338a875377a  interfaces/mcp/server.mjs
0c74f776c52086c14c37da95f5b817fdaa1fe24a64717bee036fb53416de3a4f  scripts/control-plane.mjs
025631a1d9ca2fa2f779ec8f0d7aa179650b0a8e5d149644044777c95f287202  runtime/chief-tools.mjs
84d5d4a6747ebe40b3879188797c356ccc66a99a20679b6e068ea8636754f25e  tests/execution-grant.test.mjs
c640096487a94b3d45d572ca13aa6eb19c67cdcf14be9ea4c0dc55bde5e7aee4  tests/helpers/execution-grant.mjs
5444d10c40802affd8ab7eaecc10d31332c577adb188cd94e89665dc1bc0e9f1  tests/control-plane.test.mjs
7bca3417a15dedbce1205584b74a8f2f76d7fe06559ee155d50a665446f2c381  tests/control-plane-http.test.mjs
4ba389bffb74cc3829cf4d65577b2372b5bcd89a3d60f12959afd648380d59c1  tests/native-acp-executor.test.mjs
446e27085a101cbd40836956d6a3636842861e2ef8e446acb89fcb323cccea2a  tests/approval-authority.test.mjs
1a37f7b1ddc48374135c92a74a44ce64ce1423aa7048649de77a2d9892edca7f  tests/runtime-tools.test.mjs
bdf4f20b0b50fa75558c9365f2b0c1fc3f5f71b56495f2ce1fd4337d00848298  tests/goal-core.test.mjs
```

## 生产入队入口接线清单（second pass；文件+行号，改后行号）

探明结论：生产入队面共 **6 个**（>4，已在开工报告中声明；`evals/` 与 `scripts/runtime-tools-canary.mjs` 的直连 store 调用属评测/金丝雀脚本，不经 dispatcher 真实派发，不在接线范围，见诚实边界）。所有入口统一经共享胶水 `executionAdmissionInput`（`control-plane/dispatcher.mjs:47-84`）→ `issueGrantForAdmission`（`control-plane/execution-grant.mjs:320-358`）：digest 用与审批匹配**同源**的 `parametersDigest()`（store.mjs）对入队准许参数集计算；`GrantError` 在边界翻译为 StoreError `GRANT_*`（`details.grantCode` 保原码）。

| # | 入口（文件:行号） | owner | scope | digest 参数集 | limits/expiresAt |
|---|---|---|---|---|---|
| 1 | `gateway/control-plane.mjs:180-204`（HTTP `POST /tasks/:id/executions`） | 认证 principal.id，否则 body.owner，否则 workerId | `['cezar.dispatch','native.session.prompt']` | `admittedParametersOf(body)`（workerId/sessionRefId/parentExecutionId/role/artifactRef/attempt，**排除** sessionLockToken） | body.expiresAt 显式优先（只窄不宽）；`PERSONAL_AI_OS_MAX_EXECUTION_LIFETIME_MS` 环境变量可覆盖默认帽（非法值启动即崩，fail-closed）；调用方自带 grant/digest **剥除重签** |
| 2 | `interfaces/mcp/server.mjs:231-246`（MCP `create_execution`） | 认证 principal.id，否则 workerId | 同上 | 同上 | 工具 schema allowlist 不含 expiresAt/grant（调用方无法注入）；默认帽 |
| 3 | `scripts/control-plane.mjs:85-111`（CLI `execution create`） | `--owner`，缺省 workerId | 同上 | 同上 | `--expires-at`（ISO 或 epoch ms）显式优先；`--max-lifetime-ms` 覆盖帽（非法即 GRANT_INVALID 退出码 1） |
| 4 | `control-plane/reviewer.mjs:3-19`（`createReviewerExecution`，覆盖 gateway `/reviews`、MCP `create_review_execution`、CLI `review create` 三个调用点） | reviewerId | `['native.session.prompt']`（reviewer 只经 native 路径派发，RO 约束所在） | 含 role:'reviewer' 的准许参数集 | 默认帽 |
| 5 | `runtime/chief-tools.mjs:74-84`（Pi chief 工具 `aios_create_worker_execution`） | binding.ownerId | `['native.session.prompt']` | workerId/parentExecutionId/sessionRefId | 默认帽；签发失败走工具既有 isError 诚实路径，零入队 |
| 6 | `control-plane/goal-runtime.mjs:90-97,125`（goal 迭代 worker/reviewer） | goal.owner | `['goal-runtime.execution']` | workerId(/parentExecutionId)/artifactRef | `authorizerExpiresAt = goal.grant.expiresAt`（goal 物料授权期限参与 min：迭代准入绝不超出其授权）；已过期 goal grant → 拒绝入队 fail-closed |

**统一 limits 组合**：`effectiveDeadlineAt = min(显式 expiresAt ?? issuedAt+maxLifetimeMs, issuedAt+maxLifetimeMs, authorizerExpiresAt?)`；`maxLifetimeMs` 缺省 `DEFAULT_MAX_EXECUTION_LIFETIME_MS = 30*60_000`（`execution-grant.mjs:18-25`，与桥侧 `grantDeadlineMs` 默认 30 分钟对齐，头注释注明依据 `vendor/wechat-acp/src/config.ts:304`）；入口显式 `expiresAt` 只能把窗口**收窄**（帽仍参与 min），operator 配置只能来自环境/flag，绝不来自被准入方的 payload。

**幂等重放安全（second pass 探明的关键问题）**：入口签发引入时间相关字段（issuedAt/expiresAt），若参与幂等指纹，同一 Idempotency-Key 的重试会被误判 IDEMPOTENCY_CONFLICT。处置：① 执行 id 由请求确定派生（`idSeed = {taskId, idempotencyKey, parameters}` → `execution_adm_<sha256>`），重试铸同一 id；② `store.createExecution` 的幂等指纹**排除**宿主签发的 grant/digest 字段（`store.mjs:382-393`，注释声明：调用方语义字段全部仍参与，宿主条目先剥除调用方 grant 材料，无洗白面）；③ 重试返回首签 grant，绝不重章（测试「store.createExecution idempotency excludes the host-issued grant…」固化：retry replay=true、grantId 与首签一致、payload 真变仍冲突）。

**入口测试映射**：
- 入口 1（HTTP）：`tests/control-plane-http.test.mjs` 主套件内——「entry-created execution 自带可 verifyGrant 的 grant + 默认帽参与 + 同键重试 replay 同 id + 调用方伪造 grant 被剥除重签 + 非法 expiresAt → 400 GRANT_INVALID 且 executionCount 不变」；
- 入口 2（MCP）：`tests/execution-grant.test.mjs`「MCP create_execution entry issues a valid grant at enqueue and the execution dispatches without GRANT_MISSING」（含 replay + 真实 dispatchCezar 放行）；
- 入口 3（CLI）：同上文件「CLI entry (scripts/control-plane.mjs) issues a grant at enqueue; an illegal --expires-at refuses and enqueues nothing」（真实子进程 + 临时 state dir）；
- 入口 4（reviewer）：`tests/control-plane.test.mjs`「reviewer execution is an independent auditable child」增断言（owner=reviewerId、scope 单 native）；
- 入口 5（chief-tools）：`tests/runtime-tools.test.mjs`「actual Pi tool round…」增断言（owner=binding.ownerId、grant 可验）；
- 入口 6（goal-runtime）：`tests/goal-core.test.mjs`「runtime executes real checks…」增断言（worker+reviewer grant 可验、scope、30 分帽与 goal grant 期限双参与）；
- 胶水单测：`tests/execution-grant.test.mjs` Part 3 四例（默认帽/单读钟/显式只窄不宽/authorizer 参与/idSeed 确定性/负例/翻译/digest 同源/指纹归一化重放）。

## 逐项应答（§5-1 / §5-2 / §5-6 验收 → 测试名映射）

### §5 第 1 条：正式 Grant 绑定 + 最早截止点 + 入队前持久化 + 只继承不重章

- 绑定字段：`issueGrant` 产出冻结记录 `{ version:1, grantId, taskId, executionId, owner, parametersDigest, scope, issuedAt, expiresAt, effectiveDeadlineAt }`（`control-plane/execution-grant.mjs`）。scope 对齐仓库既有表达（approval action 字符串 / budget scopeKey 字符串）：非空字符串或字符串数组，归一化为去重冻结数组。
- clock 校验：`now()` 必须返回有限非负数（抛错/NaN/±Infinity/负数/非数字/非函数 → `clock-invalid`）；`expiresAt > issuedAt`；违反分别抛 `clock-invalid` / `grant-invalid`。
- `effectiveDeadlineAt = min(expiresAt, limits.approvalExpiresAt, issuedAt + limits.maxLifetimeMs)`；缺失项不参与；未知 limit 键拒绝（防拼写漏帽）；推导确定性（单次读钟）。
- grantId 默认确定性（内容 sha256），可注入 `random` 复现。
- 入队前持久化：grant 随 `createExecution` 原子落盘；恢复/fallback 只能调 `inheritDeadline(grant)` 逐字继承（头注释 + 测试固化）。
- 测试：「issueGrant returns a frozen record…」「…requires taskId/executionId/owner/parametersDigest…」「…string or string-array scope…」「…unusable clock with clock-invalid…」「…non-finite or non-future expiresAt…」「effectiveDeadlineAt is the earliest of every applicable limit…」「…unknown limit keys…」「grantId is deterministic…」「inheritDeadline returns the persisted effectiveDeadlineAt verbatim…」。

### §5 第 2 条：缺失/非法/过期拒绝真实 dispatch；到期只停新派发；在飞工作诚实结算

- `verifyGrant` 五码：`grant-missing`(403) / `grant-invalid`(400) / `grant-mismatch`(409，防移植) / `clock-invalid`(500) / `grant-expired`(409)；通过返回**同一对象**（不新造不重章）。边界（按设计合同字面）：`now() === effectiveDeadlineAt` 仍放行，`>` 才过期——测试「…the deadline boundary admits exactly at effectiveDeadlineAt」固化。
- 准入接线：拒绝时执行记录 queued→blocked（复用既有状态机），outcome 注明 grant 码，抛 StoreError `GRANT_*`（`details.grantCode` 保留原码），不抛裸错误。
- 到期只停新派发：在飞执行不被 retroactive 取消，仍走既有状态机结算；FG r2「前台超时只改通知」语义未动（vendor 测试未改一行，见下"引用"）。
- 测试：「verifyGrant refuses a missing grant and structurally illegal grants」「…ported onto another task, execution or parameter digest」「…unusable clock and an expired grant…」「a grant is never re-stamped…」+ 集成各例。

### §5 第 6 条验收逐项映射（全部位于 tests/execution-grant.test.mjs，除非注明）

| 验收 | 测试名 | 结果 |
|---|---|---|
| 排队过期 | 「排队过期: a grant whose effectiveDeadlineAt passed while queued refuses the dispatch (grant-expired), settles blocked, and never calls the engine」+「native 排队过期…before the launch intent, with zero spawn and no engine ref」 | ✅ |
| 重启过期 | 「重启过期: the persisted grant survives a restart verbatim; the restarted store refuses an expired one and admits a live one with the SAME deadline」（新 store 实例读回，grant 逐字 deepEqual，同一切点） | ✅ |
| clock 非法 | 「issueGrant refuses an unusable clock…」（8 种变体）+「verifyGrant refuses an unusable clock…」 | ✅ |
| fallback 截止点不变 | 「恢复/fallback 截止点不变: recoverOnStartup keeps the grant untouched and inheritDeadline never re-stamps from now」+ 单元「inheritDeadline returns the persisted…verbatim」 | ✅ |
| 两类取消边界 | 「两类取消边界: Grant 到期只停新派发, 在飞工作不被 retroactive 取消并按既有语义结算」（在飞 running 不受影响、可正常 verifying 结算；另一队列项到期拒派）。FG 侧「前台超时只改通知」**引用** vendor `grant-deadline-inherit` / `session-timeout-retention`（[p3-foreground-background-r2](p3-foreground-background-r2.md) §旧反例映射），按合同不重复断言、断言方向未动 | ✅ |
| 保持已通过的 FG/RO 原反例 | RO：`tests/native-acp-executor.test.mjs` reviewer 只读全套（含「takes the role from the stored execution…」）原断言未动，80/80 通过；FG：vendor 套件本批零改动 | ✅ |
| Grant 缺失新 dispatch 拒绝 | 「缺失 Grant 的新 dispatch 被拒绝…on both dispatch paths」（cezar + native，零引擎副作用，blocked 结算） | ✅ |
| digest 移植 | 「digest 移植: a grant minted for execution A cannot be persisted onto execution B, and a stored digest drift refuses dispatch (grant-mismatch)」 | ✅ |

## 旧记录（升级前已存在、无 grant 字段）语义说明

合同给了分叉选择权。探明结论：本仓库所有 dispatch 路径消费的执行记录都由同一 store 新入队（dev 阶段 state version 1，无既有生产数据迁移面），故按合同许可**一律强制**：无 grant 的记录在真实 dispatch 时一律 `GRANT_MISSING` 拒绝并 blocked 结算——这是 fail-closed，**不是静默洗白**（拒绝即如实记录，outcome 注明 `grant-missing`）。代价：升级前遗留的 queued 记录将无法再派发（会 blocked 并注明原因），无 operator 重签通道（本批未发明重发 API）。**请审计裁决**该一刀切是否可接受，或要求引入带 operator 审批的补签路径。

## 受影响既有测试清单与适配方式（铁律要求报告）

强制 Grant 后，凡夹具创建执行记录并真实 dispatch 的套件都需补签 Grant。适配**全部为机械性夹具修改，零断言方向改变**：

| 套件 | 适配点 | 方式 |
|---|---|---|
| tests/control-plane.test.mjs | 3 处 dispatch 夹具（cezar :188 区域、native :301、native-refusal :326）；reviewer 套件增 grant 断言（second pass） | 夹具预铸 executionId + 展开 `executionGrantFixture(...)` |
| tests/native-acp-executor.test.mjs | `launchFixture`(:255) 与 `cancelFixture`(:515) 两个夹具函数（覆盖全部 ~30 个 dispatch 调用点） | 同上；`idleNativeExecution` 等 cancel-only 夹具无需 grant（取消不设门） |
| tests/approval-authority.test.mjs | :191、:207 两处 dispatch 夹具 | 同上 |
| tests/control-plane-http.test.mjs（second pass） | 主套件内加入口 1 正/负断言 | 纯断言新增，既有生命周期断言未动 |
| tests/runtime-tools.test.mjs（second pass） | 首个 Pi 工具往返用例增 child grant 断言 | 同上 |
| tests/goal-core.test.mjs（second pass） | runtime 完成用例增 worker/reviewer grant 断言 | 同上 |
| tests/helpers/execution-grant.mjs | **新建**（合同预先授权的签发小助手，特此前置报告） | 真实调用 `issueGrant`，默认真实时钟 + 1 小时寿命 |

control-plane-lock.test.mjs 无 dispatch 调用点，零改动即通过。

## 验证（原始退出码）

```
$ cd /Users/markus/ai-agent-cockpit && node --test --test-reporter=dot tests/execution-grant.test.mjs
CMD1_EXIT=0   # 28 pass / 0 fail（首版 22 + second pass 入口接线 6 例）

$ node --test --test-reporter=dot tests/control-plane.test.mjs tests/native-acp-executor.test.mjs tests/control-plane-http.test.mjs tests/control-plane-lock.test.mjs
CMD2_EXIT=0   # 80 pass / 0 fail / 0 skipped

$ ls tests/*.test.mjs | grep -v freeze-coordinator | xargs node --test --test-reporter=dot
EXIT=0        # 636 pass / 0 fail / 0 skipped（首版基线 630 + 本批净增 6）

附加：tests/approval-authority.test.mjs、tests/runtime-tools.test.mjs、tests/goal-core.test.mjs、
     tests/goal-recovery.test.mjs 单独复跑均全绿。
```

**关于 `tests/freeze-coordinator.test.mjs`（9 fail，与本批无关的环境性失败，特此声明）**：该套件是本会话期间由另一批次（Wave 5/S04b）新增的 in-flight 文件（本批开工时的 tests/ 清单中没有它；它不 import 本批任何改动模块）。失败根因是其自身夹具缺陷：`makeWorkspace()`（:73-79）只建 `snapshots` 目录，而 `seedSqliteEventStore(join(base,"stores-a","memory.sqlite"))`（:298 起）的父目录 `stores-a` 从未创建，`new DatabaseSync(path)` 报 `ERR_SQLITE_ERROR errcode 14 (SQLITE_CANTOPEN)`，全部 9 例失败均级联于此。复现路径不经过本批任何代码；修复（在 `seedSqliteEventStore` 开头 `mkdirSync(dirname(path), { recursive: true })`）属 S04b 批次范围，本批未动该文件。

## 偏差与诚实边界（未覆盖项）

1. ~~签发端未接进入队入口~~ **已消解（second pass）**：全部 6 个生产入队入口均已在入队前由宿主签发 Grant（见「生产入队入口接线清单」）。
2. **防篡改强度仅依赖存储可信**：grant 无签名/MAC；绑定校验（taskId/executionId/parametersDigest）防的是**移植与误配**，不防能直接改写 `control-plane.json` 的攻击者（他可以同时改 grant 与记录）。state 文件本身 0o600 + 目录 0o700。若审计要求密码学防篡改，需单列批次。
3. **Approval 与 Grant 的时限关系**：`limits.approvalExpiresAt`（胶水入参 `authorizerExpiresAt`）只在签发时已知授权工件期限才参与；当前 6 个入口中仅 goal-runtime 有既知授权期限（goal grant）并实际传入，其余入口的 dispatch Approval 在入队时通常尚不存在（min 组合逻辑有多上限单测覆盖）。
4. **过期边界取字面合同**：`now() === effectiveDeadlineAt` 放行、`>` 拒绝（budget-policy 是 `>=` 拒绝）。已按设计合同字面实现并测试固化，差异请审计知悉。
5. **非 macOS 未验证**：集成测试均为合成 adapter/假 agent，平台无关；Seatbelt 真实证据仍属 native-sandbox 既有批次。本批未在 Linux/Windows 复跑。
6. **在飞工作到期后的主动结算**：Grant 到期不停在飞工作（合同语义），但控制面也没有"到期主动终止在飞"的看门狗——在飞工作的寿命治理仍属桥侧 `deadlineAt`/cancel 通道，本批未新增。
7. **非入口直连 store 的写入面**：`evals/control-plane-regression.mjs`（评测脚本）与 `scripts/runtime-tools-canary.mjs:68`（金丝雀脚本）直连 `store.createExecution` 不签发 Grant——它们不经 dispatcher 真实派发（仅状态机转移/恢复演练），不受 GRANT_MISSING 影响；若未来其语义变为真实派发需补签。`control-plane/state-converter.mjs`（迁移工具）经 `contracts.createExecution` 校验旧记录：grant 字段随记录原样保留（converter 对未知可选键的处置属其自身批次，本批未验转换后 grant 保留，提请 S04 相关批次知悉）。
8. **幂等指纹排除 grant 字段的语义让步**：见「生产入队入口接线清单」幂等重放安全段。理由与边界已注释在 `store.mjs:382-393`：宿主条目先剥除调用方 grant 材料，故该排除不给调用方任何语义走私面；直连 store 的受信控制面调用方以不同 grant+同 key 重试会得到 replay 而非冲突（grant 是宿主派生件，首签为准），特此声明。

## 要求审计方做什么

1. 按 §5 第 1/2/6 条逐条复核 diff、新 SHA 与上表测试映射；重点：① 两条准入链强制点是否都在任何副作用之前且以存储记录为准；② `effectiveDeadlineAt` 是否任何路径都不从 now 重算（grep 全仓确认只有 `issueGrant` 推导它）；③ 取消边界两类的断言方向与 FG/RO 旧反例是否零改动。
2. 复核 second pass 入口接线：6 个入口的 owner/scope/digest 语义是否成立；幂等重放安全处置（确定性 id 派生 + 指纹排除 grant）是否可接受（诚实边界 8）；goal-runtime 以 `goal.grant.expiresAt` 作 authorizerExpiresAt 的语义。
3. 裁决「旧记录一刀切强制」（本文"旧记录语义说明"节）：接受，或要求 operator 补签通道。
4. 裁决过期边界语义（边界 4：合同字面 `>` vs budget-policy 风格 `>=`）。
5. 知悉 `tests/freeze-coordinator.test.mjs` 的环境性失败属 S04b 批次（见验证节声明），勿计入本批。
