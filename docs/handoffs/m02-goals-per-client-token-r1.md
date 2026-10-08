# 执行交接包：M02 goals token 每客户端化（Wave 1.6 / r1）——identity-pairing exportPrincipals 接入 goals 服务

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包落实[施工序列 r1](../handoffs/construction-sequence-r1.md) 第 6 步「**goals token 每客户端化**」：把 goals 服务的单一共享 bearer token 换成每客户端 principal 认证，并补齐 [m02-identity-lifecycle-r1](m02-identity-lifecycle-r1.md) 未覆盖项中 D40 所指的「文件生产端未接线」。前序交接与审计文件保留不覆盖。

## 批次身份与状态

- batchId / revision：m02-goals-per-client-token / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；branch `feat/0.3.0-progress`；cwd `/Users/markus/ai-agent-cockpit`；subagent（deepseek-flash）实现，主 Agent 定稿设计合同、亲自复跑
- 已读并确认协作协议：是。本批允许写入且实际写入：`control-plane/identity-pairing.mjs`、`control-plane/request-authority.mjs`、`gateway/goals.mjs`、`scripts/test-goals-live.mjs`、`tests/goal-http.test.mjs`、`tests/identity-pairing.test.mjs`、`tests/goal-per-client-token.test.mjs`（新文件）、`docs/handoffs/m02-goals-per-client-token-r1.md`（新文件）。**未改** `package.json`、`docs/audits/**`、`docs/plans/**`、`control-plane/goal-client.mjs`、`scripts/goals.mjs`、`config/wechat-acp.json`、`vendor/**`、任何生产服务/DB/launchd/真实用户文件
- 对应：M02 / 施工序列 Wave 1.6；验收：goals 服务按每客户端 principal 认证；每客户端独立 token（A 通过、B 吊销/过期即 401、未知 401）；轮换不重启即生效；`exportPrincipals` 溢出 16 拒绝；非法快照不落盘
- 本批目标：把 goals 服务从「共享 token（`<stateDir>/api-token`）+ 恒定时间比较」改为「每请求从权威 authority 文件认证每客户端 principal」。明确不做：生产重启/部署、真实凭据轮换/配对、把 wechat bridge / CLI 客户端实际迁移到 pairing token、role 粒度授权、revoked 条目修剪、commit/push

## 固定来源

- base HEAD：`e8c4317201d70e75cabe279da5e7736a9aab20a0`（沿用[上一批 m02-identity-lifecycle-r1](m02-identity-lifecycle-r1.md) 记录的基线；**本批未执行任何 git 命令**，未用 git 复核）
- 变更文件（SHA256，2026-10-08，`shasum -a 256`）：
  - `control-plane/identity-pairing.mjs` `4bbb0648c8c1d2b8ccae42e9c96af3edbccbbd5489eaf62834c4a9eac43631ea`（205 → 221 行；仅 `exportPrincipals()` 与新增常量）
  - `control-plane/request-authority.mjs` `a96954507408a6704cd26f31c470f2eb4274c6a15df5dc2744cae6c37d24f997`（167 → 201 行；新增 `writeAuthorityFile`，其余逐字未动）
  - `gateway/goals.mjs` `cf10b8007fd37196f89d2ad73ca89996a68bc765cd546142408ae082226ab086`（112 → 121 行；import、:17–21 共享 token 段、:60–62 认证段、返回值 tokenFile→authFile）
  - `scripts/test-goals-live.mjs` `f0a8028f0fc4331d74cbe11b14fbf323c845502e88aacf8cb8e2f98c9979af21`（42 → 46 行；token 来源改环境变量，去掉 `os` import）
  - `tests/goal-http.test.mjs` `79848d0bd7fd4272912d255fef86ab46aa90c95ff24c32fb42f2bac130db0a65`（79 → 87 行；startServer 夹具）
  - `tests/identity-pairing.test.mjs` `f3c81f3cd55f7b94db9339d931b4fadd7a677001b5f6297bbb40e66cb0d13cd1`（214 → 227 行；**仅 test 9 语义对齐新合同**，其余 12 条逐字未动）
  - `tests/goal-per-client-token.test.mjs` `d438ae87cbba03a88ada479b2a081ed19b8d1145b7747635143e1b7e3f7e8485`（新文件，116 行，6 用例）
- `package.json` 未改：`test:goals` = `node --test tests/goal-*.test.mjs tests/verification-gate.test.mjs`，新用例文件 `goal-per-client-token.test.mjs`（前缀 `goal-`）被既有 glob 自动纳入，故 `test:goals` 由 **60 → 66** 项
- 依赖：无新依赖（`node:fs/promises` + `node:crypto`）；未改 lock

## 设计合同逐条落实

### 1. `identity-pairing.mjs`：`exportPrincipals()` 继承生命周期（对齐 ID-E001）

原 :190–198 仅在导出当时 `filter(isActive)` 输出 `{id,role,tokenDigest}`（审计 ID-E001 判定「静态导出不继承生命周期」）。现改为输出 request-authority 文件 schema：

- 导出 `{ version:1, principals:[...] }`，每条：
  - 活跃 principal → `{ id, role, tokenDigest, expiresAt }`
  - 已吊销 principal → `{ id, role, tokenDigest, expiresAt, revoked:true }`（**吊销记录保留为吊销证据，绝不静默删除**）
  - 已过期但未吊销 → 丢弃（不再活跃）
- 上限对齐 request-authority：新增常量 `EXPORT_MAX_PRINCIPALS = 16`；导出条目数 > 16 → 抛 `PairingError('export-overflow')`，**诚实拒绝、不截断、不静默丢弃**（revoked 记录的修剪属后续事项，见未覆盖项）。
- 返回值为**冻结对象**（顶层、`principals` 数组与每个条目均 `Object.isFrozen`）。契约注释同步更新。
- 未叠第二套函数：直接在既有 `exportPrincipals()` 上对齐语义。

### 2. `request-authority.mjs`：新增 `writeAuthorityFile(file, snapshot)`

补齐 D40「文件生产端未接线」。契约：**先校验后落盘**。

- 先 `createRequestAuthority(snapshot)` 做结构校验（含 v1 schema、id/role/HEX/唯一性/上限 16、`expiresAt`/`revoked` 合法性）——**非法快照永不落盘**，直接抛 `AuthorityError('AUTH_CONFIGURATION',500)`。
- 序列化后按 `MAX_AUTHORITY_BYTES`(16384) 复核（与 `loadRequestAuthority`/`createLiveRequestAuthority` 的读取上限互为生产/消费两端；超限亦 `AUTH_CONFIGURATION`）。
- 写入 `<file>.<16hex random>.tmp`（`fs.open(..., 'wx', 0o600)` + `chmod(0o600)` + `writeFile` + `sync`），随后 `rename` 原子替换到 `file`。tmp 与目标同目录，保证 rename 原子性；任何失败路径清理 tmp 并抛 `AUTH_CONFIGURATION`。
- 与 `createLiveRequestAuthority` 的读取合同互补：原子替换必然更换 ino/mtime，触发其 `ino:mtimeMs:size` 变更键重载——轮换即时生效。
- 未改 `createRequestAuthority`/`createLiveRequestAuthority`/`loadRequestAuthority`/`authorizeHttpRequest`/`trustedApprovalDecision`/`nativeRemoteInput`/`AuthorityError`。

### 3. `gateway/goals.mjs`：共享 token → 每客户端 principal

- **删除** :17–21 共享 token 生成/读取与 :60–62 恒定时间比较（**不保留兼容路径**）。
- 改用 `createLiveRequestAuthority({ file: process.env.GOALS_AUTH_FILE ?? path.join(root, 'authority.json'), required: true })`（同步装载）。文件在**每次请求**重新校验，轮换/吊销/过期无需重启。
- 每请求 `authority.authenticate(req.headers)` 得 principal；`AuthorityError` 统一映射到既有 GoalError 风格：401 透传为 `GoalError('AUTH_REQUIRED', …, 401)`，配置错误如 `AUTH_CONFIGURATION` **如实 500**。
- `X-Goal-Actor` 与 wechat owner 绑定逻辑（:63–64 与 grant 的 actor）**语义不变**；actor 默认值仍为 `local`（owner 流程零破坏）。health 仍不需认证；`/api/bootstrap` 仍 410。
- `createGoalServer` 返回值 `tokenFile` 移除，改返回 `authFile` 路径。`scripts/goals.mjs` 经核查**未引用** tokenFile（其经 `goal-client.mjs`），故未改。

### 4. 测试

- 现有 goal 套件全部适配：`tests/goal-http.test.mjs` 的 `startServer` 夹具改为写合成 authority 文件（mode 0600，`tokenDigest = sha256(已知 token)`），服务器返回值以 `authFile` 取代 `tokenFile`。
- `tests/identity-pairing.test.mjs` test 9 按新合同对齐（原断言「仅活跃 principal、键恰好 id/role/tokenDigest、全过期后长度 0」被新合同取代），**仍为 13 项**。
- 新增 `tests/goal-per-client-token.test.mjs`（6 用例）：每客户端独立 token、轮换不重启、缺文件 500 fail-closed、`writeAuthorityFile` 拒非法快照、`exportPrincipals` 溢出 16 拒、pairing→export→server 端到端 + 吊销落盘。

### 5. 本交接包

结构镜像 m02-identity-lifecycle-r1：批次身份、固定来源 sha256、设计合同逐条、负例原始结果、验证表、要求审计方、未覆盖项。

## 关键 diff 摘要

1. `control-plane/identity-pairing.mjs`
   - 新增常量 `EXPORT_MAX_PRINCIPALS = 16`（含契约注释）。
   - `exportPrincipals()`：改为遍历 `principals`，revoked 分支 → `{…, revoked:true}`；活跃分支 → `{…, expiresAt}`；过期未吊销丢弃；`exported.length > 16` → `PairingError('export-overflow')`；返回 `Object.freeze({version, principals: Object.freeze(...)})`。**其余方法逐字未动**。
2. `control-plane/request-authority.mjs`：新增 `writeAuthorityFile`（L135–169，见上）。**其余逐字未动**。
3. `gateway/goals.mjs`：新增 import `{ createLiveRequestAuthority, AuthorityError }`；`root` 后装配 `authFile`/`authority`；认证段替换为 try/catch 映射；返回值 `tokenFile`→`authFile`。
4. `scripts/test-goals-live.mjs`：`token = process.env.GOALS_AUTH_TOKEN`，缺失即抛清晰错误；移除仅用于旧 token 路径的 `os` import。
5. `tests/goal-http.test.mjs` / `tests/identity-pairing.test.mjs`：夹具 / test 9 对齐（见上）。
6. `tests/goal-per-client-token.test.mjs`：新增。

## 反向负例清单与原始结果摘要

| 负例 | 期望 | 结果 |
| --- | --- | --- |
| 未知 token / 无 token | 401 | ✅ |
| 已吊销 principal 的 token（B，`revoked:true`） | 立即 401 | ✅ |
| 已过期 principal 的 token（`expiresAt<now`） | 401 | ✅ |
| 有效 principal 的 token（A） | 200 | ✅ |
| `writeAuthorityFile` 原子替换后旧 token | 立即 401、新 token 200（**未重启**） | ✅ |
| authority 文件缺失 | 每请求 500 `AUTH_CONFIGURATION`（fail-closed，health 仍 200 无需认证） | ✅ |
| `writeAuthorityFile` 收到非法快照（version:2 / 空 principals / 非法 role / 非 hex digest / 未知键） | 抛 `AUTH_CONFIGURATION`，**目标文件逐字节不变、无 `.tmp` 残留** | ✅ |
| `exportPrincipals` 第 17 个活跃 principal | 抛 `PairingError('export-overflow')`（16 个时正常） | ✅ |
| pairing→export→server 端到端；随后 revoke + 重导出（保留 revoked 条目） | 旧 token 401，无需重启 | ✅ |

所有负例为 tmp 合成夹具（`fs.mkdtemp`），无外呼、无真实凭据、无生产读写。

## 验证

| 要求/Case | 实现 | 验证命令与 cwd | 结果 |
| --- | --- | --- | --- |
| 每客户端独立 token（A 通过，B 吊销/过期/未知 401） | gateway 每请求 authenticate | `npm run test:goals`（仓库根，Node v24.15.0） | ✅ `goal-per-client-token.test.mjs`「per-client principals authenticate independently…」 |
| 轮换不重启生效 | `writeAuthorityFile` 原子替换 + `createLiveRequestAuthority` 重载 | 同上 | ✅「rotating the authority file refuses the old token immediately without a restart」 |
| 缺文件 fail-closed 500 | 每次请求 open 失败 → `AUTH_CONFIGURATION` | 同上 | ✅「a missing or invalid authority document fails … with 500」 |
| 非法快照不落盘、目标不变 | 先校验后写 | 同上 | ✅「writeAuthorityFile refuses an invalid snapshot and never mutates the target」 |
| exportPrincipals 溢出 16 拒 | `EXPORT_MAX_PRINCIPALS` | 同上 | ✅「exportPrincipals refuses to exceed the 16-principal request-authority ceiling」 |
| pairing→export→server 端到端 + 吊销 | 全链路 | 同上 | ✅「identity-pairing export feeds the live goal server…」 |
| 现有 goal 套件适配 | goal-http 夹具 | `npm run test:goals` | ✅ **66/66**（原 60 + 新 6），exit 0 |
| identity-pairing 零回归（test 9 按新合同） | — | `npm run test:identity-pairing` | ✅ **13/13**，exit 0 |
| runtime-policy 零回归 | — | `npm run test:runtime-policy` | ✅ **35/35**，exit 0 |

- 真实模型/原文外呼/生产读写/launchd/微信外发/服务重启：**均未发生**。全部为 tmp 合成夹具；未 chmod 任何真实用户文件（仅 chmod 自建 tmp 文件）。
- 失败、部分结果和不明副作用：无。活动进程/handle：测试子进程均在 `finally` 中关连接并 `SIGTERM`，无遗留；活动生产 goals/gateway 进程**未被本批触碰**（本地复跑用随机独立端口 + 独立 tmp state）。

### 本批关键偏离（请审计方重点复核）

- **`tests/identity-pairing.test.mjs` test 9 断言被更新**：原断言编码了旧语义（仅活跃、键恰 `id/role/tokenDigest`、全过期后长度 0）。新合同要求导出带 `expiresAt` 且保留 revoked 条目，故 test 9 必须对齐；这是**合同规定的语义变更**，非回归。用例数保持 13。
- **`test:goals` 由 60 增至 66**：新增 6 条负例/正例（设计合同 §4 要求）。若审计方要求 goal 套件恒为 60，请单列裁决。

## 要求审计方做什么

- 按 Wave 1.6 验收复核本批 diff / 新 hash / 负例；重点：① `exportPrincipals` 的 active/revoked/expired 三类取舍是否符合 ID-E001「持续生命周期」意图（尤其「过期未吊销丢弃、revoked 保留」的不对称是否认可）；② 溢出判据按**导出后条目数** > 16 是否正确（revoked 计不计数）；③ `writeAuthorityFile` 的「先校验后落盘」是否确实杜绝非法落盘，且 tmp+rename 原子性/0600 无窗口；④ goals 认证映射是否保证坏 token 仍 401、配置错误仍 500 且**无共享 token 回退**；⑤ `principal` 未参与 owner/actor 决策是否满足「语义不变」。
- 非返工前请确认：本包未触碰 `package.json`、`docs/audits/**`、`docs/plans/**`、`goal-client.mjs`、`scripts/goals.mjs`、`config/wechat-acp.json`、`vendor/**`。
- 等待期间继续的无冲突独立任务：wechat bridge 客户端配对迁移（见未覆盖项）。

## 未覆盖项与诚实边界声明

- **生产服务未重启**：本批只改代码 + 合成测试；已在跑的 goals/gateway 仍执行旧代码（读 `api-token`/静态快照）。**部署顺序**：重启生产 goals 前**必须**先由 pairing `exportPrincipals()` → `writeAuthorityFile()` 生成 `authority.json`（或经 `GOALS_AUTH_FILE` 指定）；否则服务对**所有**认证请求 500 fail-closed。真实重启/部署/凭据轮换**另批**，本包 READY 不授予该权限。
- **客户端迁移清单（本批未实施，仅文档）**：现有共享 token 客户端须先经 pairing 配对拿各自 token，再改造读取方式：
  1. wechat bridge：`vendor/wechat-acp/src/goals.ts` + `config/wechat-acp.json` 的 `goals.tokenFile`（当前读 `~/.local/state/personal-ai-os/goals/api-token`）——**未迁移**。
  2. CLI：`control-plane/goal-client.mjs`（`npm run goal-status` / `scripts/goals.mjs`）当前读同一 `api-token`——**未迁移**（`scripts/goals.mjs` 本身未引用 tokenFile，无需改）。
  3. live 脚本：`scripts/test-goals-live.mjs` **已最小适配**——token 改从 `GOALS_AUTH_TOKEN` 环境变量读取（authority 文件只含 digest，明文 token 需操作者经 pairing 取得后注入），缺失即抛错；**未实际运行**（`test:goals-live` 命中真实 :4326，本批不跑）。
- **role 粒度未细分**：goals 服务本次只做**认证**（任何有效 principal 通过），**不按 role 授权**，也不调用 `authorizeHttpRequest`；`X-Goal-Actor`/owner 绑定与 `approvedBy` 语义保持原样。按 role 细分 goals 权限属后续切片。
- **revoked 条目修剪**：`exportPrincipals` 保留全部 revoked 条目（证据），因此长期运行积累 > 16 条 revoked 后会触发 `export-overflow`。如何安全修剪 revoked 记录（保留期/审计归档）**待后续**。
- **过期 principal 导出语义**：已过期但未吊销的 principal 在导出时**丢弃**；若审计认为过期也需保留为「曾存在」证据，请单列裁决。
- **空文档边界**：`exportPrincipals` 允许 0 条目（此时 request-authority 会以 `AUTH_CONFIGURATION` 拒绝该文件，即 0 客户端服务 fail-closed）；本批不特殊处理。
- **启动期不读文件**：`createGoalServer` 构造时**不**校验 authority 文件存在/合法，首个认证请求才读取并 fail-closed；即「配置错误在首个请求暴露」。若审计要求启动即校验，请单列。
- **clock 语义**：`writeAuthorityFile` 校验不依赖时钟；`createLiveRequestAuthority` 透传注入 `clock`；生产用默认 `Date.now`。`expiresAt` 由 pairing 以 `now()` 生成。
- 未执行真实外呼/生产读写/launchd/微信外发/服务重启/git；未改 `package.json`。
