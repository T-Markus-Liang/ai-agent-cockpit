# 执行交接包：M02/I03d 身份生命周期接线切片（r1）——HTTP/MCP 经证明的同步重载

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包逐条回应 [m02-identity-pairing-r1 审计](../audits/m02-identity-pairing-r1.md) 的 **M02-ID-E001（高 / 阻断完整接线）**。r1 交接与旧审计文件保留不覆盖。

## 批次身份与状态

- batchId / revision：m02-identity-lifecycle / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；branch `feat/0.3.0-progress`；cwd `/Users/markus/ai-agent-cockpit`；subagent（deepseek-flash）实现，主 Agent 定稿设计合同、亲自复跑
- 已读并确认协作协议：是。本批允许写入且实际写入：`control-plane/request-authority.mjs`、`gateway/control-plane.mjs`、`tests/request-authority.test.mjs`、`docs/handoffs/m02-identity-lifecycle-r1.md`（新文件）。**未改** `package.json`（复用既有 `test:runtime-policy` script）、`docs/audits/**`、`docs/plans/**`、任何生产服务/DB/launchd/真实用户文件
- 对应：M02 / I03d 第三切片（身份接线）；验收：审计「下一接线包」段——三种凭据变化（rotate/revoke/expiry）在不重启整个服务时**立即拒旧 token**，当前有效 token 仍可用
- 本批目标：把 HTTP/MCP 身份层从「启动时静态快照」改为「每次请求经证明的同步重载」。明确不做：生产重启/部署、真实凭据轮换、多进程共享缓存、health 接线、commit/push

## 固定来源

- base HEAD：`e8c4317201d70e75cabe279da5e7736a9aab20a0`（与 ID-E001 审计同基线；**未执行任何 git 命令**）
- 变更文件（SHA256，2026-10-08）：
  - `control-plane/request-authority.mjs` `b494e9c3a7d43521900322e7bc7f2844ac5253da6efa3f789a6bd9ed3248f04c`（原 95 行 → 167 行；原批未提供旧 hash）
  - `gateway/control-plane.mjs` `eb38d53b6df5d29cd18f0cf8acd72578c0a4f4e7b61a2c9f104ea346e3f5a3ad`（仅改第 14 行 import 与第 18 行装载点，其余 handler 逐字未动）
  - `tests/request-authority.test.mjs` `aa99a7314a8d9754bcb75811cbfaa25e98038fd226e6983eaac8a58ce9102e54`（117 行 → 258 行；**6 → 14 用例**，新增 8 条）
- `package.json` 未改：`test:runtime-policy` = `npm --prefix vendor/wechat-acp run build && node --test tests/request-authority.test.mjs tests/approval-authority.test.mjs tests/acp-permission-broker.test.mjs tests/control-plane-lock.test.mjs`（多批共享，不形成共同冻结版本）
- 兼容契约（只读未改）：`control-plane/identity-pairing.mjs:190–198` 的 `exportPrincipals()` 输出 `{version:1, principals:[{id,role,tokenDigest}]}` 仍被本层逐字接受（v1 兼容扩展，见下）
- 依赖：无新依赖（`node:fs` 同步 API + `node:crypto`）；未改 lock
- 自测前后 sourceRef 一致；只有上列 3 个源文件按授权变更

## Finding 逐条回答

### M02-ID-E001（高 / 阻断完整接线：静态导出不继承生命周期）→ 每次请求经证明的同步重载

审计证据（`identity-pairing.mjs:190–198` 仅导出当时过滤 isActive；`request-authority.mjs:20–42` 构造时捕获 digest 不再读 pairing 状态）显示：rotate 后旧 token / revoke 后 token / clock 超 30 天，在**已构造的 HTTP authority** 上仍被接受。本批把 authority 的装载点从「一次性静态快照」改为「每次 authenticate 都做经证明的同步重载」。

**(1) schema 扩展（`createRequestAuthority`，v1 兼容扩展）**：principal 新增两个**可选**字段：

- `expiresAt`：有限非负 number（epoch ms）。`clock() >= expiresAt` → 该 principal 不匹配（`AUTH_REQUIRED` 401），含边界时刻（`===`）。
- `revoked`：出现时必须 `=== true`；被吊销条目**永不匹配**，但条目保留在配置里作为吊销证据（而非静默删除）。
- 签名改为 `createRequestAuthority(input, { clock = Date.now } = {})`，注入时钟供确定性测试。
- 未知键照旧拒绝；ID/ROLES/HEX/唯一性/上限 16 等**全部原有校验不变**；未提供新字段的旧 v1 文档行为逐字不变。

**(2) 新增 `createLiveRequestAuthority({ file, required = false, clock = Date.now } = {})`**（本切片核心）：返回与现有 authority **相同形状** `{ mode, authenticate(headers) }`（同步接口不变），外加只读 `generation` 重载计数。`authenticate` 每次调用执行：

- `openSync(file, O_RDONLY | O_NOFOLLOW)` → 立即 `fstatSync(fd)`；变更键 = `fstat` 的 `ino:mtimeMs:size`。**注意键取自同一 fd 的 fstat，而非 lstat 路径后再读**——消除 stat→read 的路径替换竞态（TOCTOU）。
- 键与缓存一致 → 关 fd 直接用**已解析**的缓存 authority（**不重解析**）。
- 键变化（或首次）→ 在**同一 fd** 上完成全部校验（普通文件、≤16384 字节、`mode & 0o077 === 0`、uid 匹配；现行门槛）后 `readFileSync(fd,'utf8')` + `JSON.parse` + `createRequestAuthority(..., { clock })` 重建缓存，`generation += 1`。
- **任何一步失败**（文件消失/权限漂移/符号链接/JSON 非法/schema 非法）→ fail-closed：抛 `AuthorityError('AUTH_CONFIGURATION', 500)`，**绝不回退到旧缓存**（重载失败不更新缓存，且变更键已不再与旧缓存匹配，后续请求持续拒绝）。
- `file` 未配置且 `!required` → 与现行一致返回冻结的 `legacy-loopback` 对象（无重载逻辑）；`required` 且无 file → `AUTH_CONFIGURATION` 500。
- 返回对象冻结；模块不打印/返回任何 token、digest 或文件内容。

**轮换契约（写入注释与交接）**：写者必须用 **tmp + rename 原子替换**。就地 `truncate + write` 存在被读取窗口观测到半写状态的可能，本层会 fail-closed 拒绝（而非半解析）——已在测试中固化。

**(3) gateway 接线（唯一消费点，最小 diff）**：`gateway/control-plane.mjs` 第 14 行 import 由 `loadRequestAuthority` 换为 `createLiveRequestAuthority`；第 18 行 `const authority = createLiveRequestAuthority({ file: process.env.CONTROL_PLANE_AUTH_FILE, required: process.env.CONTROL_PLANE_REQUIRE_AUTH === '1' })`（同步装载，去掉顶层 `await`）。**其余 handler 一行未动**；health 只读 `authority.mode`；MCP `/mcp` 与所有 `/api/**` 都经同一个 `authority.authenticate(req.headers)` chokepoint（`gateway/control-plane.mjs:101`），故 MCP 自动覆盖。

## 关键 diff 摘要

1. `control-plane/request-authority.mjs`
   - import：`import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';`；新增常量 `MAX_AUTHORITY_BYTES = 16384`（`loadRequestAuthority` 的 `16384` 字面量同步改用该常量，行为不变）。
   - `createRequestAuthority`：签名加 `{ clock = Date.now }`；允许键集加 `expiresAt`、`revoked`；新增两条字段校验；principal 结构增 `expiresAt`、`revoked` 派生字段；`authenticate` 循环内 `if (principal.revoked || (principal.expiresAt !== undefined && now >= principal.expiresAt)) continue;`。
   - 新增 `createLiveRequestAuthority`（L86–133，含契约注释）：sync `openSync`/`fstatSync`/`readFileSync`/`closeSync`，缓存键 `ino:mtimeMs:size`，键命中短路，键变则同 fd 全量校验+重建，`catch` 中 `AuthorityError` 原样重抛（保证坏 token 仍是 401），其余转 `AUTH_CONFIGURATION` 500，`finally` 关 fd。
   - **未改**：`loadRequestAuthority`（保留导出，行为不变）、`authorizeHttpRequest`、`trustedApprovalDecision`、`nativeRemoteInput`、`AuthorityError`。
2. `gateway/control-plane.mjs`：第 14、18 行（见上），其余逐字未动。
3. `tests/request-authority.test.mjs`：import 增 `createLiveRequestAuthority`；新增 `digestOf`/`writeAtomic`/`withPrincipal` 合成夹具与 8 条用例；原有 6 条逐字未动。

## 反向负例清单与原始结果摘要

新增用例覆盖：轮换、吊销、过期（注入时钟）、缓存命中、fail-closed、非原子半写、legacy-loopback、真实 HTTP gateway 端到端轮换/吊销。运行命令 `npm run test:runtime-policy`（仓库根，Node **v24.15.0**），**本轮源码**结果：`tests 35 / pass 35 / fail 0`，exit 0（4 文件全绿）。

为证明新负例**承重**而非仅正例通过，在自建 tmp 副本 `/tmp/e001-repro`（本进程内合成，**未改仓库、未 git**）对 `request-authority.mjs` 做两处逆向变异并重跑同一探针 `probe.mjs`（场景：①缓存命中后把同键文件损坏→若仍解析出旧 principal 则缓存在用；②重载失败时是否回落旧缓存）：

| 变体 | 变异 | 缓存场景 | fail-closed 场景 |
| --- | --- | --- | --- |
| original（本轮源码副本） | 无 | PASS（served from cache） | PASS（fail-closed 500） |
| no-cache | 删除 `if (cache !== null && cache.key === key) return ...` 短路 | **FAIL（re-parsed a corrupt file: AUTH_CONFIGURATION）** | PASS |
| fallback | `catch` 内改为先 `return cache.authority.authenticate(headers)` | PASS | **FAIL（fell back to the stale cache）** |

结论：缓存用例与 fail-closed 用例分别精确捕获「未用缓存」与「回落旧缓存」两类回归。原始 `probe.mjs` 输出见上表（`/tmp/e001-repro/` 为本进程自建夹具，不在仓库内）。

## 验证

| 要求/Case | 实现 | 验证命令与 cwd | 结果 |
| --- | --- | --- | --- |
| 轮换即时生效（无重启） | `createLiveRequestAuthority` 键变重载 | `node --test tests/request-authority.test.mjs`（仓库根） | ✅ 用例「atomic rotation is visible immediately without a restart」：旧 token 401、新 token 通过、`generation 1→2` |
| 吊销即时生效 | `revoked:true` 条目永不匹配 | 同上 | ✅ 用例「revoked entries stop authenticating and are kept as evidence」 |
| 过期（注入时钟） | `clock() >= expiresAt` | 同上 | ✅ 用例「expiry honours the injected clock…」：`expiresAt-1` 通过、`===expiresAt` 401；无 `expiresAt` principal 不受影响 |
| 非法 expiresAt/revoked 拒绝 | schema 校验 | 同上 | ✅ `NaN/-1/'1000'/Infinity/null` → `AUTH_CONFIGURATION`；`revoked` 非 `true` → `AUTH_CONFIGURATION` |
| 不变文件命中缓存 | 键一致短路 | 同上 | ✅ 同键损坏文件仍返旧 principal 且 `generation` 不变（重解析则会 500） |
| fail-closed 不回落 | 重载失败即 500 | 同上 | ✅ 删文件/0644/坏 JSON/未知键 → `AUTH_CONFIGURATION 500`，且旧 token 亦由 500 拒绝 |
| 非原子半写拒绝 | `JSON.parse` 失败→500 | 同上 | ✅ 截断 JSON → `AUTH_CONFIGURATION 500`，非半解析 |
| legacy-loopback 不变 | 无 file 分支 | 同上 | ✅ `mode==='legacy-loopback'`、`generation===0`、冻结、`required` 无 file → 500 |
| 真实 HTTP 端到端 | gateway 接线 | 同上 | ✅ 同一子进程内原子轮换：旧 token 401、新 token 201、`child.exitCode===null`（未重启）；再吊销 → 401 |
| 既有用例零回归 | — | 同上 | ✅ 原 6 条全通过 |
| 四文件联跑 | — | `npm run test:runtime-policy` | ✅ **35/35**，exit 0 |

- 真实模型/原文外呼/生产读写/launchd/微信外发：**均未发生**。全部为 tmp 合成夹具（`fs.mkdtemp`）+ 注入时钟；未 chmod 任何真实用户文件（仅 chmod 自建 tmp 文件）。
- 失败、部分结果和不明副作用：无。sourceRef 复核：仅上列 3 文件按授权变更；继续跑的生产 gateway 进程**未被本批触碰**（本地复跑用 `freePort` 独立端口 + 独立 tmp state）。
- 活动进程/job/handle：测试子进程均在 `finally` 中 `SIGTERM` 并 `await close`，无遗留；`/tmp/e001-repro` 为一次性夹具目录。
- 状态分列：实现完成 ✅（本批范围）；自测通过 ✅；独立审计：⏳ 待审计 AI；部署/真机：**未做**（生产服务仍在跑旧代码，真实部署另批）。

## 要求审计方做什么

- 按 **ID-E001** 复核本批 diff / 新 hash / 负例与反向变异结果。重点：① 变更键 `ino:mtimeMs:size` 是否足以捕获轮换（原子替换必然换 ino 与 mtime；纯 chmod 不改 mtime/ino/size，故**单独 chmod 不触发重载**——见「诚实边界」，请裁决是否需要纳入键）；② fail-closed 是否真的无回落路径（读 `catch`/`finally` 分支）；③ `AuthorityError` 重抛是否保证坏 token 仍为 401（而非被吞成 500）；④ schema 扩展是否保持 v1 兼容（旧文档零行为漂移）。
- 非返工前请确认：本包未触碰 `package.json`、`docs/audits/**`、`docs/plans/**`；`loadRequestAuthority` 保留导出（既有用例仍用），删除它不在本批范围。
- 等待期间继续的无冲突独立任务：`generation` 接入 `/health` 观测、多进程/持久状态来源设计。

## 未覆盖项与诚实边界声明

- **生产服务未重启**：本批只改代码 + 合成测试；已在跑的 gateway 仍执行旧代码，轮换即时生效的**真机效果未经本批验证**。真实部署/重启/凭据轮换**另批**，本包 READY 不授予该权限。
- **TOCTOU 已用 fd 内 fstat 消除**：变更键与全部校验均在 `openSync` 得到的**同一 fd** 上完成（`fstatSync`），不存在 lstat 路径后再按路径读取的替换窗口。但**跨两次 `authenticate` 调用之间**的写者行为不在本层控制内——因此契约要求写者原子替换（tmp+rename）。
- **缓存键的已知边界**：变更键为 `ino:mtimeMs:size`。① 仅修改权限位（chmod）而不改内容/mtime/size **不会**触发重载，缓存命中下不重校验 mode（审计请裁决是否需将 `ctimeMs` 或 mode 纳入键）；② 若写者以「完全相同 size 且精确复原 mtimeMs、同 inode 就地写」的方式损坏文件，可能命中缓存——这需要刻意构造，正常原子替换不会发生；权限位校验在触发重载时**仍在 fd 上**执行（fstat，非路径 stat）。
- **MCP 覆盖方式**：MCP 与 HTTP 共用 `gateway/control-plane.mjs:101` 的同一 `authenticate` chokepoint，故自动获得重载语义；本批**未**单独为 `/mcp` 增加端到端轮换用例（HTTP 端到端已覆盖同一 chokepoint）。
- **`generation` 未接 health**：仅作为对象只读属性暴露，**未**写入 `/health` 响应（health 只读 `authority.mode`）。接入观测为后续切片。
- **多进程/持久状态来源**：本层是「文件 → 每次请求重载」；跨进程一致性依赖写者原子替换文件，未做内存共享或 fencing。`identity-pairing.mjs` 的 `exportPrincipals()`（每进程内存态 → 文件）**未在本批接线**：本批只消费文件，不生产文件。
- **clock 语义**：`createRequestAuthority` 直接调用注入的 `clock()`；非本批次内对 clock 返回值做 fail-closed 校验（不同于 budget-policy 的 `clock-invalid`）。若审计要求一致化，请单列。
- 未执行真实外呼/生产读写/launchd/微信外发/服务重启/git；未改 `package.json`。
