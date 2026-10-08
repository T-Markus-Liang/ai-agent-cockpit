# 执行交接包：M02 goals 角色授权（r1）——角色×动作矩阵与写路由负例

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包逐条回应 [0.3.0 重启准入审计 r1](../audits/2026-10-08-restart-readiness-r1.md) 的 **RR-F003（Major；Goal 权限与 G4 准入）**。r1 交接与旧审计文件保留不覆盖。

## 批次身份与状态

- batchId / revision：m02-goals-role-authz / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；branch `feat/0.3.0-progress`；cwd `/Users/markus/ai-agent-cockpit`；subagent（deepseek-flash）实现，主 Agent 定稿设计合同、亲自复跑
- 已读并确认协作协议：是。本批允许写入且实际写入：`gateway/goals.mjs`、`tests/goal-role-authz.test.mjs`（新文件）、`docs/handoffs/m02-goals-role-authz-r1.md`（新文件）。**未改** `package.json`（复用既有 `test:goals` script，新测试文件天然被其 glob 收录）、`docs/audits/**`、`docs/plans/**`、`control-plane/request-authority.mjs`、任何生产服务/DB/launchd/真实用户文件
- 对应：M02 goals 波次 / RR-F003；验收：审计「RR-F003 下一动作」——Goal 路由显式按角色/动作授权，viewer 只读，grant 等高风险动作不能凭 `X-Goal-Actor=local` 获得
- 本批目标：给 goals HTTP 路由补**独立于 actor 头的角色授权**，并补全角色×写路由负例与合法路径。明确不做：生产重启/部署、真实微信 owner 端到端、控制面 `authorizeHttpRequest` 与 goals 矩阵的统一、commit/push

## 固定来源

- base HEAD：`a9747bd185897504a4c63b96eebec6407d1b2a17`（与 RR-F003 审计同基线；**未执行任何 git 命令**）
- 变更文件（SHA256，2026-10-08）：
  - `gateway/goals.mjs` `3f4521ab0dd9a760827817cf68abf6b3b05f50e630c7f298d48d96390cf2ce39`（121 行 → 168 行；审计基线旧值 `cf10b8007fd37196f89d2ad73ca89996a68bc765cd546142408ae082226ab086`）
  - `tests/goal-role-authz.test.mjs` `8192c1dbc2c661472798ae432b11383c36e991e23d069a2db6bdf1ba718c3eb4`（新文件，8 用例）
- `package.json` 未改：`test:goals` = `node --test tests/goal-*.test.mjs tests/verification-gate.test.mjs`，新测试文件 `tests/goal-role-authz.test.mjs` 匹配 `tests/goal-*.test.mjs` 被自动收录（**66 → 74 用例**）
- 兼容契约（只读未改）：`control-plane/request-authority.mjs` 的 `createLiveRequestAuthority` / `authenticate` 仍返回冻结的 `{ id, role, authenticated: true }`；`ROLES = ['operator','coordinator','chief','viewer']`（该模块**未导出** `ROLES`，goals 侧以同名角色为键自建矩阵）
- 依赖：无新依赖；未改 lock
- 自测前后 sourceRef 一致；只有上列 2 个源文件按授权变更（加本交接文件）

## Finding 逐条回答

### RR-F003（Major；Goal 权限与 G4 准入：认证只查 authenticated、不查 principal.role）→ 角色×动作授权矩阵

审计证据（`gateway/goals.mjs:65–78`）显示：认证后只断言 `principal.authenticated === true`，**从不解引用 `principal.role`**；操作者身份来自请求头 `X-Goal-Actor`（缺省 `local`）。因此一个合成 **viewer** 对 `POST /api/goals/pause-all` 得到 **200**，fake `controlAll` 被调用 **1** 次（省略或显式 `local` 都可越权）。本批在**认证之后、owner/actor 检查与任何状态变动之前**插入独立的角色授权。

**(1) 角色×动作矩阵（`ROLE_ACTIONS`，新增于 `gateway/goals.mjs`）**：

| 动作（action） | 对应路由 | viewer | coordinator | chief | operator |
| --- | --- | :--: | :--: | :--: | :--: |
| read | `GET /api/goals`、`GET /api/goals/:id`、`GET /api/goals/:id/proof` | ✅ | ✅ | ✅ | ✅ |
| wake | `POST /api/goals/:id/wake` | ❌ | ✅ | ✅ | ✅ |
| create | `POST /api/goals` | ❌ | ❌ | ✅ | ✅ |
| pause | `POST /api/goals/:id/pause` | ❌ | ❌ | ✅ | ✅ |
| resume | `POST /api/goals/:id/resume` | ❌ | ❌ | ✅ | ✅ |
| cancel | `POST /api/goals/:id/cancel` | ❌ | ❌ | ✅ | ✅ |
| revise | `POST /api/goals/:id/revise` | ❌ | ❌ | ✅ | ✅ |
| grant | `POST /api/goals/:id/grant` | ❌ | ❌ | ❌ | ✅ |
| pause-all | `POST /api/goals/pause-all` | ❌ | ❌ | ❌ | ✅ |
| resume-all | `POST /api/goals/resume-all` | ❌ | ❌ | ❌ | ✅ |

- `goalActionFor(method, pathname)` 把请求映射为上述 action；**不在矩阵内的请求返回 `undefined`**，从而保留原有 `NOT_FOUND`/`INVALID_METHOD`/`INVALID_ACTION` 处理，不误报 403。
- `authorizeGoalRequest(principal, method, pathname)`：action 为 `undefined` 时直接放行（交回后续既有分支）；否则若 `ROLE_ACTIONS[principal.role]` 不含该 action，抛 `GoalError('AUTH_FORBIDDEN', …, 403)`。**未知角色**（`ROLE_ACTIONS[role]` 为 `undefined`）不匹配任何 action → 403，fail-closed。

**(2) 接线点（唯一调用点，最小 diff）**：`gateway/goals.mjs` 在认证断言（原 :71）之后、`const actor = …`（原 :72）之前插入一行 `authorizeGoalRequest(principal, req.method, url.pathname)`。**owner/actor 语义逐字保留**：`X-Goal-Actor` 仍只影响 owner 绑定（行内 `actor !== 'local' && (!owner || actor !== owner)` 与 `:id` 的 `current.owner !== actor` 均未改），它**不再带来任何权限**，因为角色授权独立于、且先于 actor 检查执行。grant 的 `approvedBy` 语义保持（=actor，未改 `goals.grant(id, { digest, approvedBy: actor })`）。`/health`、`/api/bootstrap`(410) 在认证之前处理，行为不变。

**(3) actor=local 的 viewer 不能写（审计复现路径固定为回归）**：授权在 actor 判定之前执行，故 `X-Goal-Actor: local` 或缺省都不能让 viewer 触达写路由。审计证据脚本 `docs/audits/evidence/2026-10-08-restart-review/goal-role-probe.mjs` 对本批源码重放：`omitted` 与 `local` 两种情形均 **403 / fakeMutationCalls 0**（修复前为 200 / 1）。

## 关键 diff 摘要

1. `gateway/goals.mjs`
   - 新增 `ROLE_ACTIONS`（冻结的角色→动作表）、`goalActionFor(method, pathname)`、`authorizeGoalRequest(principal, method, pathname)`（均 `export` 供直测与后续复用）。
   - 处理器内认证断言后新增一行 `authorizeGoalRequest(principal, req.method, url.pathname)`；其余路由分支（health、bootstrap、read、pause-all/resume-all、create、`:id` 分派、owner 检查、grant/revise/pause/resume/cancel/wake、respond）**逐字未动**。
2. `tests/goal-role-authz.test.mjs`：新建 8 用例（见下）。合成夹具 `startServer` 用 `fs.mkdtemp` 建 tmp 状态目录、合成 token 的 sha256 digest 写入 0600 `authority.json`、`ControlPlaneStore` 建合成 task store、假 runtime engine；`recordStore()` 用 `Proxy` 包裹真 `GoalStore` 记录被调用的方法名，用于断言拒绝路径**零 store 调用**。

## 反向负例清单与原始结果摘要

新增 8 用例（`node --test tests/goal-role-authz.test.mjs`，Node **v24.15.0**，仓库根，**本轮源码**：8/8 通过）：

| 用例 | 覆盖 | 断言要点 |
| --- | --- | --- |
| role/action matrix resolves routes and denies exactly the contract | 矩阵直测 | 路由解析（read/create/grant/wake/pause-all…；DELETE、`POST /:id`、`POST /:id/proof`、`GET /:id/other` → `undefined`）；各角色 allow/deny 向量 |
| viewer is read-only: every goal write route is 403 AUTH_FORBIDDEN with zero store calls | viewer 全写路由负例 | 9 条写路由全部 `403 AUTH_FORBIDDEN`；`recorder.calls` 长度不变（零 store 方法调用）；goal 仍 `draft`、`grant` 未设、全局未暂停 |
| a local-actor viewer still cannot write (audit reproduction is fixed) | 审计复现回归 | `actor=omitted` 与 `actor=local` 对 `pause-all` 与 `pause` 均 403；`controlAll` 从未被调用 |
| coordinator may read and wake, but no write action is allowed | coordinator | create/pause-all/resume-all/grant/pause/cancel/revise → 403 且零 store 调用；`wake` → 200；读 → 200 |
| chief manages single goals but is denied grant and the global pause-all/resume-all | chief | create → 201；grant/pause-all/resume-all → 403 且零 store 调用；pause/revise/cancel/wake → 200 |
| operator may perform every action, including grant and the global pause | operator 合法全通 | create/revise/grant(`approvedBy:'local'`)/pause/resume/wake/pause-all/resume-all/cancel 均 200 且状态正确 |
| a bound WeChat owner manages its own goals under a sufficient role; owner semantics and reads are unchanged | 微信 owner 绑定 | 合成 owner 绑定下 create owner = `wechat-<sha256(user)>`；chief+owner actor 可 pause 自己 goal、grant 仍 403、陌生 actor 仍 `OWNER_REQUIRED`；viewer 读（list/get/proof）200、写 403；operator（local actor）跨 owner cancel 200 |
| /health and the retired /api/bootstrap remain unauthenticated and unchanged | 不变行为 | `/health` 200 ok（无 token）；`/api/bootstrap` 410 `BOOTSTRAP_RETIRED` |

审计证据脚本重放原始输出（本批源码，`/tmp` 自建夹具）：

```json
{
  "syntheticOnly": true, "productionWrites": 0, "modelCalls": 0, "realGoalsTouched": 0,
  "observations": [
    { "role": "viewer", "actorHeader": "omitted", "expectedStatus": 403, "actualStatus": 403, "fakeMutationCalls": 0 },
    { "role": "viewer", "actorHeader": "local",   "expectedStatus": 403, "actualStatus": 403, "fakeMutationCalls": 0 }
  ]
}
```
（修复前同脚本：`actualStatus` 200、`fakeMutationCalls` 1，两种情况均越权。）

## 验证

| 要求/Case | 实现 | 验证命令与 cwd | 结果 |
| --- | --- | --- | --- |
| viewer 写路由全 403 且零状态变化 | 矩阵 + 调用点 | `node --test tests/goal-role-authz.test.mjs`（仓库根） | ✅ 9 写路由 403，`recorder.calls` 不变 |
| actor=local viewer 不能写（审计复现） | 授权先于 actor | 同上 / 审计 `goal-role-probe.mjs` | ✅ 两种 actor 均 403、`controlAll` 未调用 |
| coordinator grant/pause-all 403 | 矩阵 | 同上 | ✅ 403，零 store 调用 |
| chief grant 403 但 create/pause 200 | 矩阵 | 同上 | ✅ create 201、grant 403、pause 200 |
| operator 全通 | 矩阵 | 同上 | ✅ 全部 200 |
| 微信 owner 合法路径 + viewer 读正常 | owner 绑定保留 | 同上 | ✅ 见上表 |
| /health、/api/bootstrap 行为不变 | 未动分支 | 同上 | ✅ 200 / 410 |
| 既有 goals 用例零回归 | — | `npm run test:goals` | ✅ **74/74**（原 66 + 新 8），exit 0 |
| 身份配对套件零回归 | — | `npm run test:identity-pairing` | ✅ **13/13**，exit 0 |
| 运行策略套件零回归 | — | `npm run test:runtime-policy`（含 vendor 构建） | ✅ **39/39**，exit 0 |

- 真实模型/原文外呼/生产读写/launchd/微信外发：**均未发生**。全部为 tmp 合成夹具（`fs.mkdtemp`）+ 合成 token；唯一读取的仓库内文件是只读夹具 `tests/fixtures/goal-pilot`（由既有 `goal-http.test.mjs` 同样使用），workspace 只写入 tmp。
- 失败、部分结果和不明副作用：无。sourceRef 复核：仅上列 2 文件（+ 本交接）按授权变更；继续跑的生产 goals/gateway 进程**未被本批触碰**（本地复跑用独立端口 + 独立 tmp state）。
- 活动进程/job/handle：测试子进程均在 `t.after` 中 `closeAllConnections` + `await close` 并删 tmp 目录，无遗留。

## 要求审计方做什么

- 按 **RR-F003** 复核本批 diff / 新 hash / 负例：① `ROLE_ACTIONS` 是否与审计要求的「viewer 只读；coordinator 读+wake；chief 单 goal 管理但不含 grant/pause-all/resume-all；operator 全部」逐格一致；② 授权是否确在认证之后、owner/actor 与任何状态变动之前（读 `gateway/goals.mjs` 处理器顺序）；③ `goalActionFor` 的 `undefined` 逃逸是否有可被利用的写路由（当前仅命中非真实路由的 `POST /:id`、`POST /:id/proof`、未知路径/方法，均无状态变动）；④ 零 store 调用断言是否真承重（`recorder.calls` 是否可能因构造期调用而失真——当前构造期不调用 store）。
- 非返工前请确认：本包未触碰 `package.json`、`docs/audits/**`、`docs/plans/**`、`control-plane/request-authority.mjs`；唯一生产源码改动是 `gateway/goals.mjs` 的新增块 + 1 行调用。
- 等待期间继续的无冲突独立任务：RR-F004（`request-authority.mjs` 缓存 chmod 漂移）、控制面与 goals 矩阵的统一。

## 未覆盖项与诚实边界声明

- **生产服务未重启**：本批只改代码 + 合成测试；已在跑的 goals 服务仍执行旧代码，角色授权的**真机效果未经本批验证**。真实部署/重启**另批**，本包 READY 不授予该权限。
- **控制面 `authorizeHttpRequest` 与 goals 矩阵的口径差异**：两者**未统一**。相同点——角色集合一致（`operator/coordinator/chief/viewer`）、拒绝语义一致（`AUTH_FORBIDDEN` → 403）。差异——① 拒绝错误类型不同：控制面抛 `AuthorityError('AUTH_FORBIDDEN')`，goals 抛 `GoalError('AUTH_FORBIDDEN', …, 403)`（沿用 goals 现有错误风格）；② 动作词表不同：控制面按 `/api/control-plane/**` 的 REST 路径白名单判定，goals 按 goal 动作词表（create/grant/pause-all/…）判定，故同一角色的具体可写路由不同；③ 控制面对 `GET /api/control-plane/native-sessions` 额外限制 viewer，goals 把所有 GET 视为 read。`ROLES` 未从 `request-authority.mjs` 导出，goals 以同名角色为键自建矩阵——**新增角色时两处需 lock-step 更新**（goals 侧未知角色 fail-closed 403）。是否抽公共角色模块由审计裁决。
- **真实微信 owner 端到端另验**：本批 owner 用例用**合成** `wechatStateFile`（`lastActiveUserId: 'TESTONLY-owner-user'`），不是真实微信 owner、不消费真实游标/状态文件。真实 owner 的签发→映射→授权闭环需在隔离实例另验。
- **未做全仓回归**：仅跑 `test:goals`、`test:identity-pairing`、`test:runtime-policy` 三条指定套件，不构成整版本验收。
- **非真实写路由的 `POST`（如 `POST /api/goals/:id`、`POST /api/goals/:id/proof`）**：不在矩阵内，仍走既有 `INVALID_ACTION` 400 / `NOT_FOUND` 404（无状态变动）。若审计要求对一切未知写请求也 fail-closed 403，请单列。
- 未执行真实外呼/生产读写/launchd/微信外发/服务重启/git；未改 `package.json`、`docs/audits/**`、`docs/plans/**`。
