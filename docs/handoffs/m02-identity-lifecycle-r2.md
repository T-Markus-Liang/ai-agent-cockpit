# 执行交接包：M02/I03d 身份生命周期切片（r2）——缓存前置安全校验（关闭 RR-F004）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包逐条回应 [2026-10-08 重启就绪审计 r1](../audits/2026-10-08-restart-readiness-r1.md) 的 **RR-F004（Major；共享 authority 生命周期与 G2/G4 准入）**。**r1 交接包与旧审计文件保留不覆盖**；本包镜像 r1 结构，仅记录 r2 的增补。

## 批次身份与状态

- batchId / revision：m02-identity-lifecycle / **r2**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；branch `feat/0.3.0-progress`；cwd `/Users/markus/ai-agent-cockpit`；subagent（deepseek-flash）实现，主 Agent 定稿设计合同、亲自复跑
- 已读并确认协作协议：是。本批允许写入且实际写入：`control-plane/request-authority.mjs`、`tests/request-authority.test.mjs`、`docs/handoffs/m02-identity-lifecycle-r2.md`（新文件）。**未改** `package.json`、`docs/audits/**`、`docs/plans/**`、`gateway/control-plane.mjs`（r1 已接线，本批无消费点变更）、任何生产服务/DB/launchd/真实用户文件
- 对应：M02 / I03d（身份接线切片）**安全返工**；验收：审计 RR-F004「下一动作」——每次同 fd 安全元数据检查前置于 cache 返回；缓存不免除 mode/uid/type/size 验证；仅 chmod 无内容变化、危险权限下首次/缓存认证、恢复安全权限、轮换/吊销/过期/删除/符号链接负例齐备；不回落旧缓存
- 本批目标：把 `createLiveRequestAuthority.authenticate` 的安全元数据校验**移到缓存命中判断之前**，关闭 r1「单独 chmod 不触发重载」这一已知边界。明确不做：生产重启/部署、真实凭据轮换、gateway 行为变更、`generation` 接 health、多进程共享缓存、commit/push

## 固定来源

- base HEAD：`8fc8adef5b7253405e6fa9f53e93c97eeb82323c`（branch `feat/0.3.0-progress` 的 ref 值；**未执行任何 git 命令**，该值由直读 `.git/HEAD` → `.git/refs/heads/feat/0.3.0-progress` 得到；审计 r1 报告记录的现场 HEAD 为 `a9747bd185897504a4c63b96eebec6407d1b2a17`，其间已有其他批次提交，本包只对 r2 三文件负责）
- 变更文件（SHA256，2026-10-08；**旧值 = 审计绑定值**）：
  - `control-plane/request-authority.mjs`
    - 旧 `a96954507408a6704cd26f31c470f2eb4274c6a15df5dc2744cae6c37d24f997`（与审计 r1 表内 sourceRef 逐字一致）
    - 新 `a279820e1237a27547d7f86be3bc44582b88e4312ac6c485f673c357983fa9bd`（201 → 210 行）
  - `tests/request-authority.test.mjs`
    - 旧 `aa99a7314a8d9754bcb75811cbfaa25e98038fd226e6983eaac8a58ce9102e54`（r1 基线）
    - 新 `2bbbbc86ecba2230f40479ac4c88127d901d3687f2a7b32aa73000b256432043`（311 → 389 行；**14 → 18 用例**，新增 4 条）
  - `docs/handoffs/m02-identity-lifecycle-r2.md`（本新文件）
- `package.json` 未改：`test:runtime-policy` = `npm --prefix vendor/wechat-acp run build && node --test tests/request-authority.test.mjs tests/approval-authority.test.mjs tests/acp-permission-broker.test.mjs tests/control-plane-lock.test.mjs`（多批共享，不形成共同冻结版本）
- 依赖：无新依赖（`node:fs` 同步 API + `node:crypto` 均已在用）；未改 lock
- 自测前后 sourceRef 一致；只有上列 3 个源文件按授权变更

## Finding 逐条回答

### RR-F004（Major；共享 authority 生命周期与 G2/G4 准入）→ 安全元数据校验前置于缓存

审计证据（`request-authority.mjs:120` 命中缓存就返回，先于 `:121` 的 mode/uid/type 检查；合成 600→644 保持 ino/mtime/size 不变仍认证成功）在 r2 sourceRef 上复现并修复。审计要求的四条「下一动作」逐条落地：

1. **每次同 fd 安全元数据检查必须前置于 cache 返回** → `authenticate` 每次调用都 `openSync(O_RDONLY|O_NOFOLLOW)` + `fstatSync(fd)`，在**同一 fd** 上先做全部安全校验（普通文件、`mode & 0o077 !== 0`、uid 匹配、`size > MAX_AUTHORITY_BYTES`），**全部通过**才计算变更键 `ino:mtimeMs:size` 并允许命中缓存。
2. **缓存不免除 mode/uid/type/size 验证** → 缓存现在只能省下 `readFileSync + JSON.parse + createRequestAuthority`（解析成本），**绝不省任何安全校验**。chmod 只改 ctime（不动 ino/mtimeMs/size），因此旧实现命中缓存后完全跳过 mode 检查；新实现无论缓存冷暖都先过 mode 门槛。
3. **补仅 chmod 无内容变化、危险权限下首次/缓存认证、恢复安全权限、轮换/吊销/过期/删除/符号链接负例** → 见「反向负例清单」：新增 4 条用例精确覆盖；既有轮换/吊销/过期/删除/半写负例逐字保留、零回归。
4. **不能回落旧缓存** → 校验失败抛 `AuthorityError('AUTH_CONFIGURATION', 500)`，`cache` 不被更新、也不被读取（校验在 `cache` 判断之前），因此「曾经缓存过好配置」的情形同样 fail-closed；恢复 0600 后因变更键未变，缓存仍可用（正例回到正常）。

**变更键语义不变**：仍为 `ino:mtimeMs:size`，来自同一 fd 的 `fstatSync`——消除 stat→read 的路径替换竞态（TOCTOU）。r1 的性能特征保持：安全校验是 fstat 级廉价操作；变更键未变时仍**不重解析** JSON。本批**仅调整了校验与缓存判断的先后顺序**，未改键、未改阈值、未改任何 schema。

## 关键 diff 摘要

1. `control-plane/request-authority.mjs`（`createLiveRequestAuthority`，r1 的 L114–131 一带）：
   - 在 `const stat = fstatSync(fd);` 之后**先**放置安全校验 `if (!stat.isFile() || stat.size > MAX_AUTHORITY_BYTES || (stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new AuthorityError('AUTH_CONFIGURATION', 500);`，**再** `const key = ...; if (cache !== null && cache.key === key) return cache.authority.authenticate(headers);`。
   - 新增 5 行内联注释说明「缓存只省解析、绝不省安全检查；chmod 不改 ino/mtimeMs/size，朴素变更键会漏检（RR-F004）」。
   - 更新 `createLiveRequestAuthority` 顶部契约注释（原 5 行 → 9 行），明确安全元数据**每次调用都校验、在缓存键之前**。
   - **未改**：`createRequestAuthority`、`loadRequestAuthority`、`writeAuthorityFile`、`authorizeHttpRequest`、`trustedApprovalDecision`、`nativeRemoteInput`、`AuthorityError`；校验表达式本身逐字未变，只是移动位置。
2. `gateway/control-plane.mjs`：**本批未改**（r1 已把装点切到 `createLiveRequestAuthority`；消费路径不变）。
3. `tests/request-authority.test.mjs`：仅新增 4 条用例 + 一段分节注释；原有 14 条**逐字未动**。

## 反向负例清单与原始结果摘要

新增用例（`tests/request-authority.test.mjs`）：

- `live authority: widening permissions alone is refused though the change key is untouched (RR-F004)` —— 审计复现固定为回归。成功认证 → `chmod 600→644`，**断言 ino/mtimeMs/size 三者与 chmod 前完全相等**（即朴素变更键「未变」）→ 连续两次再认证均 `AUTH_CONFIGURATION 500`（且 `generation` 停在 1，未成功重载）→ 恢复 `0600` → 再次认证成功。
- `live authority: a warmed cache does not excuse a later permission drift` —— 先用 `operator` token 成功认证一次（暖缓存）后 `chmod 0600→0640`，断言变更键三项不变 → 该 principal 与**另一** principal（`chief`）均被 `AUTH_CONFIGURATION 500` 拒绝（缓存不豁免安全检查，且不止影响暖缓存的那个 principal）。
- `live authority: a file already widened before the first call is refused with no cache` —— 首次装载前文件即为 `0644` → 首次 `authenticate` 即 `AUTH_CONFIGURATION 500`，`generation === 0`（从未解析/缓存）。
- `live authority: a symlinked authority path is refused (O_NOFOLLOW) from the first call` —— `file` 指向符号链接 → 首次 `authenticate` 即 `AUTH_CONFIGURATION 500`，`generation === 0`（`O_NOFOLLOW` 触发 `ELOOP`）。

为证明新负例**承重**而非仅正例通过，在自建 tmp 目录 `/tmp/rr-f004-repro`（本进程内合成，**未改仓库、未 git**）对 `request-authority.mjs` 做一处逆向变异（把校验块与缓存短路**换回 r1 的旧顺序**），并用合成探针 `probe.mjs` 重放审计场景（600 认证成功 → chmod 644，断言键不变）：

| 变体 | 变异 | 审计复现场景（chmod 漂移） |
| --- | --- | --- |
| fixed（r2 源码） | 无 | **PASS（`AUTH_CONFIGURATION`，acceptedAfterWiden=false）** |
| pre-fix mutant（r2 源码，校验/短路换回旧序） | cache 短路先于校验 | **FAIL（`acceptedAfterWiden=true`，errorCode=null）——bug 精确复现** |

探针原始输出（`syntheticOnly:true, productionWrites:0, modelCalls:0`）：

- fixed：`{ initialAuthenticated: true, keyUnchanged: true, acceptedAfterWiden: false, errorCode: "AUTH_CONFIGURATION" }`
- pre-fix：`{ initialAuthenticated: true, keyUnchanged: true, acceptedAfterWiden: true, errorCode: null }`

结论：新用例在旧顺序下必然失败、在新顺序下通过，精确捕获 RR-F004（缓存前置绕过安全元数据）。`/tmp/rr-f004-repro` 为本进程自建夹具，测后已删除。

## 验证

| 要求/Case | 实现 | 验证命令与 cwd | 结果 |
| --- | --- | --- | --- |
| 仅 chmod 无内容变化仍拒 | 安全校验前置于缓存短路 | `node --test tests/request-authority.test.mjs`（仓库根，Node **v24.15.0**） | ✅ 用例「widening permissions alone is refused…（RR-F004）」：键三项相等 + 两次拒绝 + 恢复后通过 |
| 暖缓存下权限漂移仍拒 | 缓存不豁免校验 | 同上 | ✅ 用例「a warmed cache does not excuse a later permission drift」 |
| 危险权限下首次即拒 | 首次调用同样先校验 | 同上 | ✅ 用例「a file already widened before the first call…」：500 且 `generation===0` |
| 符号链接负例 | `O_NOFOLLOW` | 同上 | ✅ 用例「a symlinked authority path is refused…」 |
| 轮换/吊销/过期/删除/半写零回归 | 原 14 条逐字未动 | 同上 | ✅ 原 14 条全通过（含 rotation / revoked / expiry / cache-no-reparse / fail-closed / partial-write / legacy / HTTP 端到端） |
| 变更键未变仍不重解析 | 顺序调整不动缓存命 | 同上 | ✅ 用例「an unchanged file is served from the parsed cache (no re-parse)」仍通过（`generation` 不变） |
| 反向变异证明用例承重 | tmp 变异 + 探针 | `node probe.mjs <module>`（`/tmp/rr-f004-repro`） | ✅ pre-fix 复现 bug、fixed 拒绝 |
| 四文件联跑（含 vendor build） | — | `npm run test:runtime-policy`（仓库根） | ✅ **39/39**，exit 0（4 文件全绿；基线 35，本批 +4） |
| goals 服务消费方回归 | — | `npm run test:goals`（仓库根） | ✅ **66/66**，exit 0 |

- 真实模型/原文外呼/生产读写/launchd/微信外发：**均未发生**。全部为 tmp 合成夹具（`fs.mkdtemp`）+ 合成 token；未 chmod 任何真实用户文件（仅 chmod 自建 tmp 文件）。审计探针 `auth-permission-probe.mjs` 的合成场景已在本文件内固定为正式用例。
- 失败、部分结果和不明副作用：无。sourceRef 复核：仅上列 3 文件按授权变更；继续跑的生产 gateway 进程**未被本批触碰**（本地复跑用 `freePort` 独立端口 + 独立 tmp state）。
- 活动进程/job/handle：测试子进程均在 `finally` 中 `SIGTERM` 并 `await close`，无遗留；`/tmp/rr-f004-repro` 已删除。
- 状态分列：实现完成 ✅（本批范围）；自测通过 ✅；独立审计：⏳ 待审计 AI；部署/真机：**未做**（生产服务仍在跑旧代码，真实部署另批）。

## r1「待裁决」条目关闭说明

r1 交接「未覆盖项与诚实边界声明」中列出：**「缓存键的已知边界①：仅修改权限位（chmod）而不改内容/mtime/size 不会触发重载，缓存命中下不重校验 mode（审计请裁决是否需将 `ctimeMs` 或 mode 纳入键）」**，并在「要求审计方做什么」中请审计裁决。

- 审计 r1 以 RR-F004（Major）**受理该待裁决项**，判定为缺陷并给出返工合同：安全校验必须前置于缓存。
- 本批（r2）**按审计合同关闭该条目**，且采用的方案**不是**把 `ctimeMs`/mode 塞进变更键（那会让任何 chmod 触发重解析、也会引入键来源歧义），而是**更彻底的顺序保证**：安全元数据每次调用无条件校验（在缓存判断之前），缓存退化为「只省 JSON 解析」。
- 关闭后语义：**单独 chmod（漂移或恢复）不再需要否决缓存——缓存根本无从绕过校验**。因此 RR-F004 的「已知边界①」自 r2 sourceRef 起**不再适用**。
- r1 边界②（写者以「完全相同 size 且精确复原 mtimeMs、同 inode 就地写」损坏文件仍可能命中缓存）**仍成立且不变**：这是变更键的固有限制，正常原子替换（tmp+rename，必换 ino/mtime）不会发生；权限位校验现值在缓存判断之前，故「权限漂移」类别已与边界②解耦。

## 要求审计方做什么

- 按 **RR-F004** 复核本批 diff / 新 hash / 负例与反向变异结果。重点：① 安全校验是否**确实**位于缓存短路之前、且用的是同一 fd 的 `fstatSync`（读 `authenticate` 语句序）；② 失败是否只抛 `AuthorityError('AUTH_CONFIGURATION', 500)` 且**不读不写** `cache`（无回落路径，含「曾缓存好配置」情形）；③ 缓存命中仍**不重解析**（`generation` 不变）——确认本批未把性能特征改坏；④ 原 14 条用例是否逐字未动、`gateway/control-plane.mjs` 是否确实未被本批触碰。
- 非返工前请确认：本包未触碰 `package.json`、`docs/audits/**`、`docs/plans/**`；未执行任何 git 命令；base HEAD 为直读 `.git` ref 得到。
- 等待期间继续的无冲突独立任务：`generation` 接入 `/health` 观测、多进程/持久状态来源设计。

## 未覆盖项与诚实边界声明

- **生产服务未重启**：本批只改代码 + 合成测试；已在跑的 gateway 仍执行旧代码，「缓存前置安全校验」的**真机效果未经本批验证**。真实部署/重启/凭据轮换**另批**，本包 READY 不授予该权限。
- **仅调整校验顺序**：本批不新增/不修改任何安全门槛（`mode & 0o077 === 0`、uid、普通文件、`size ≤ 16384` 与 r1 逐字相同），只把它们的**执行时点**提前到缓存判断之前。若审计认为还需要「写者级」约束（例如禁止非原子就地写），那属于写者侧契约，不在本层内存实现内。
- **变更键固有边界（r1 边界②）保留**：`ino:mtimeMs:size` 无法察觉「同 inode、同 size、精确复原 mtimeMs 的就地内容改写」。这需要刻意构造；正常原子替换必然换 ino 与 mtime。本批未改键以求保守（改键会改变已验证的轮换/吊销语义），此限制沿用 r1。
- **跨进程一致性**：本层是「文件 → 每次请求校验 + 变更键重解析」；跨进程一致性仍依赖写者原子替换文件，未做内存共享或 fencing（与 r1 相同，未在本批变化）。
- **gateway 未改**：`gateway/control-plane.mjs` 消费的是同一个 `authority.authenticate` chokepoint（HTTP 与 `/mcp` 共用），故 r2 的安全语义自动覆盖两条入口；本批**未**新增 `/mcp` 或 gateway 级端到端用例（HTTP 端到端轮换/吊销用例已在 r1 覆盖同一 chokepoint，本批未动）。
- **`generation` 未接 health**：仍仅作对象只读属性，未写入 `/health`（与 r1 相同）。
- **clock 语义**：`createRequestAuthority` 直接调用注入的 `clock()`，非本层对 clock 返回值做 fail-closed 校验（与 r1 相同，若审计要求一致化请单列）。
- 未执行真实外呼/生产读写/launchd/微信外发/服务重启/git；未改 `package.json`。
