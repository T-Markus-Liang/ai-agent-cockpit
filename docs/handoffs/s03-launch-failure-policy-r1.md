# 执行交接包：S03a createSession 候选链启动故障门 + Reviewer 路由核查（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)。本包对应[整改执行方案 §5](../plans/0.3.0-remediation-2026-10-09.md)第 73 行（第 3 条：createSession 候选链纳入同一故障策略——认证故障、未知启动效果、权限错误不得以"尚未 prompt"为理由自动换模型重试）与第 75 行（第 5 条：其他路径在证明同等只读前不得路由 Reviewer）。**本包只改候选链/策略镜像与其测试，不触 control-plane 任何文件、不触生产路径、未执行任何 git 命令。**

## 批次身份与状态

- batchId / revision：s03-launch-failure-policy / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；本批由该会话 subagent（deepseek-flash，官方 V4.1 Flash）实现与自测，主 Agent 定设计合同
- 分支 / cwd：`feat/0.3.0-progress` / `/Users/markus/ai-agent-cockpit`
- 基线：HEAD `c0125a8d4719783aad1e1acef8a0af45346f43cf`（审计文档所记 HEAD；本批未执行任何 git 命令，含只读）
- 本批目标：① spawnAgent 失败结构化（kind/phase/providerSessionTouched）；② 双镜像 `classifyLaunchFailure` 启动门 + 差分对拍；③ 候选循环接门（abort/认证/权限/未知启动效果不再换 candidate）；④ Reviewer 路由面只读核查 + 不变量回归测试
- 明确不做：`control-plane/goal-access-broker.mjs` 及任何 control-plane 文件修改、`package.json`/`tsconfig` 变更、provider 特有认证错误码逐一枚举、生产部署、真实 CLI、Windows 验证
- 铁律遵守：全部夹具为自建合成物（`node -e` 假 ACP agent、`os.tmpdir()` 临时文件、注入式 fetcher/spawnAgent 接缝）；未读写生产/launchd/真实用户文件；无网络/模型/微信外呼；未改 `docs/audits/**`、`docs/plans/**`

## 固定来源（完整 sha256）

| 文件 | 行数 | sha256（完整） | 状态 |
| --- | --- | --- | --- |
| `vendor/wechat-acp/src/acp/agent-manager.ts` | 586 | `81bc7ac93c09275bda348bcb7876919500aa1dc44c5c9c089132119599738f2a` | 改（502 → 586 行：AgentStartupError + toStartupError + phase/touched 追踪） |
| `vendor/wechat-acp/src/acp/fallback-policy.ts` | 147 | `c6f66d3449c7587e2997db925ff40c4b835b841a04392b42a46efc26faf12fc7` | 改（86 → 147 行：classifyLaunchFailure） |
| `vendor/wechat-acp/src/acp/session.ts` | 1889 | `57ed128314a7ad22652f2bf8298b5b36c858d3adb93898eb61d7a051abc64597` | 改（1874 → 1889 行：候选循环接门 + spawnAgent 测试接缝） |
| `runtime/fallback-policy.mjs` | 537 | `7c3d0fb3833ead717bd095710c52d00a230515de2c54dd501412673dc9e11b20` | 改（477 → 537 行：classifyLaunchFailure 规范镜像） |
| `tests/fallback-policy.test.mjs` | 520 | `edfddbe9b2cb9d22cbc735d221dc3a552869957abf00f29e18630c77e7ed85a5` | 改（473 → 520 行：新增用例 19） |
| `vendor/wechat-acp/tests/fallback-policy-parity.test.ts` | 340 | `8abea2113893305789e21334aa481a37faa662916e84baecf5cd4ae8ed0f0142` | 改（258 → 340 行：launch 对拍矩阵纳入） |
| `vendor/wechat-acp/tests/session-launch-fallback.test.ts` | 241 | `1ae28be66b803c7f3061eba181ee1d6608674db3e92d12a1109abe7853e3e5e1` | **新建**（候选链门 7 用例） |
| `tests/reviewer-routing-invariant.test.mjs` | 76 | `9ad7d369724ee3f283664cd7fcdda315562fc6f32fde30e5f742ad181e1bf6e0` | **新建**（reviewer 路由不变量 3 用例） |

`control-plane/**`（含 `goal-access-broker.mjs`）**本批一律未修改**（reviewer 核查为只读，结论见下）；未对这些未修改文件重新计算 hash，请审计方按其复核流程自行核对。未新增任何 npm 依赖。

## 逐项应答

### §5 第 3 条：候选链纳入同一故障策略

**旧行为**（`session.ts` 候选循环）：spawnAgent 失败后**无条件**推进下一个 candidate（仅最后一个才 throw）——ENOENT、权限错误、abort、initialize/newSession 失败（含 provider 可能已建 session 的未知状态）一律换 harness 重试。

**新行为**：spawnAgent 抛出结构化 `AgentStartupError { kind, phase, providerSessionTouched }`；候选循环 catch 后先过 `classifyLaunchFailure` 门，日志记录 gate 决策（`launch gate: advance|stop/<reason>`），`!gate.advance || 已是最后一个` 即 throw 原错误。

1. **结构化启动错误**（`agent-manager.ts`）：
   - 新增 `export class AgentStartupError extends Error`，字段 `kind: string`、`phase: 'spawn'|'initialize'|'load-session'|'new-session'`、`providerSessionTouched: boolean`（外加 `cause` 保留原错误）。
   - spawnAgent 内 `phase` 局部变量依次推进（initialize 前置 `'initialize'`，loadSession 前置 `'load-session'`，newSession 前置 `'new-session'`）；`providerSessionTouched` **就在 `connection.loadSession(...)` / `connection.newSession(...)` 调用之前**置 `true`——侧效应分界即"session/new（或 session/load）是否已发出"。
   - catch 统一经 `toStartupError` 包装：已是 AgentStartupError → 原样；字符串 errno `code`（ENOENT → `spawn-not-found`；EACCES/EPERM → `spawn-permission`；其它字符串 code → `spawn-error`；**数值 JSON-RPC code 绝不映射为 spawn 类**）；message 含 `exited during startup` → `startup-exit`、`timed out` → `startup-timeout`、`aborted` → `aborted`；其余 → `launch-error`。spawn 前的 abort 预检与 abortable 的 reject 走同一包装（`aborted`）。
   - **`AgentProcessCleanupError` 保持原类型不包装**（二选一中的选择）：它自带双错误与 proc 引用，`session.ts:708/802` 有 `instanceof AgentProcessCleanupError` 消费；它没有 `kind` 字段，gate 天然 fail-closed（`uncertain-side-effects`/`unknown-launch-effect` stop），无需 `cleanup-uncertain` 映射——该 kind 仅为未来/对拍完备保留在门内。
2. **启动门**（`runtime/fallback-policy.mjs` 规范 + `vendor/.../fallback-policy.ts` 镜像，同语义 `classifyLaunchFailure({ kind, providerSessionTouched })` → 冻结 `{ advance, reason }`）。决策表：

   | kind | providerSessionTouched | 决策 | reason |
   | --- | --- | --- | --- |
   | 任意 | `!== false`（true / undefined / 缺失 / null / 0 / 其它） | **stop** | `unknown-launch-effect` |
   | `aborted` | `=== false` | stop | `launch-aborted` |
   | `auth_error` | `=== false` | stop | `auth-failure` |
   | `spawn-permission` | `=== false` | stop | `permission-denied` |
   | `cleanup-uncertain` | `=== false` | stop | `cleanup-uncertain` |
   | `spawn-not-found` | `=== false` | **advance** | `spawn-not-found` |
   | `startup-exit` | `=== false` | **advance** | `startup-exit-clean` |
   | `startup-timeout` | `=== false` | **advance** | `startup-timeout-clean` |
   | 其它一切（`launch-error`/`initialize-error`/`spawn-error`/未知字符串/空/非字符串/缺失） | `=== false` | stop | `uncertain-side-effects` |

   未知启动效果屏障**先于一切 kind 判断**（与 `hasProducedMessage` 哲学一致：只有显式 `=== false` 才是零副作用证明，缺失按未知拒绝）。非 plain-object 输入 fail-closed 为 `unknown-launch-effect`。两侧头注释/JSDoc 如实记录镜像关系与"launch 判定是同一故障策略哲学在启动期的投影"。
3. **行为修复点**：abort 后不再换 candidate 继续 spawn（旧代码会推进）；非结构化普通 Error（无 `kind`）天然 stop（fail-closed）。

### §5 第 5 条：Reviewer 路由限定核查（只读，未改 broker）

通读 `control-plane/goal-access-broker.mjs` 全 280 行并 grep 全仓 `reviewer` 派发面，结论：**结构上 reviewer 只可能落在已证明只读的面或无写能力的面，未发现真实缺口，无需加 guard**。

| 派发面 | 路径 | 只读证据 |
| --- | --- | --- |
| broker `runChecks` | `goal-access-broker.mjs:246` → `runSandboxChecks`（native Seatbelt） | RO-F001 r2 已证明；broker `applyProposal` 对 reviewer 抛 `READ_ONLY_ROLE`（:189），行为测试 `tests/goal-access-broker.test.mjs:46-53` 既有 |
| broker `filesystemFor` | ACP 回调经 `workspaceState`/`applyProposal` | 同上 role 门禁覆盖 |
| `reviewer.mjs` → native-acp-executor | `createReviewerExecution` 创建即标 `role:'reviewer'`，executor 从**存储执行**取 role 强制 `writeLiterals:[]` | p4-reviewer-readonly r1/r2 已裁决 |
| `goal-runtime.mjs:117-120` | `call('reviewer', …)` → `GoalAI.call` | **无工具 chat completion**：loopback 端点 `127.0.0.1:4323`、`Bearer loopback-shim`（不读凭据文件）、请求体无 `tools` 字段、只回 JSON verdict；无文件系统/写面，只读由构造成立 |
| `dispatcher.mjs`（Cezar） | grep 全文件无 `reviewer`（不区分大小写） | 无 reviewer 路由面 |

**观察项（非缺口，请审计方知悉）**：`goal-runtime.mjs:117` 的 reviewer 执行记录**未标 `role:'reviewer'`**（与 `reviewer.mjs` 路径不同）。该执行不经 `executeNativeSessionPrompt`（role 强制点），也无 dispatch 面把它路由到沙箱路径——GoalAI 调用无写面，故不影响只读结论；若未来该执行 id 被引入 native prompt 面，role 缺失会退化为 worker 语义，届时须先补标。

**新增回归测试** `tests/reviewer-routing-invariant.test.mjs`（3 用例）：① reviewer 推理停在本机 loopback、不读凭据、无工具面（注入 fetcher + 指向不存在路径的 credentialFile——若读凭据即炸）；② `dispatcher.mjs` 不得出现 reviewer 路由；③ control-plane 源码 tripwire：凡提及 reviewer 的 `.mjs` 必须在已裁决白名单（contracts/goal-access-broker/goal-ai/goal-runtime/goal-store/native-acp-executor/native-sandbox/reviewer/store）内，新派发面直接失败。

## 旧行为 → 新回归断言映射

| 场景（`tests/session-launch-fallback.test.ts`） | 旧行为 | 新断言 |
| --- | --- | --- |
| a. ENOENT（`spawn-not-found`） | 推进（偶然正确） | 推进到 fallback 成功；`fallbackSession===true`、`fallbackUsers` 已标记、日志含 `advance/spawn-not-found` |
| b. session/new 发出后失败 | 换 harness，遗弃孤儿 session | 立即 throw；`providerSessionTouched===true`、`phase==='new-session'`；第二 candidate `Spawning agent:` 计数为 0；日志 `stop/unknown-launch-effect` |
| c. `auth_error`（接缝注入） | 换 harness 猜凭据 | 不换；`stop/auth-failure`；spawn 计数 1 |
| d. EACCES（`spawn-permission`，真实 0o644 文件） | 换 harness | 不换；`stop/permission-denied`；spawn 计数 1 |
| e. abort（挂起 agent + 50ms abort） | **推进到下一 candidate** | 不换；候选失败日志仅 1 条且含 `stop/launch-aborted`；`kind==='aborted'` |
| f. 非结构化普通 Error（接缝注入） | 换 harness | 不换；`stop/unknown-launch-effect`；spawn 计数 1 |
| g. 进程启动期退出（`startup-exit`） | 推进（偶然正确） | 推进成功；日志 `advance/startup-exit-clean` |

策略层：`tests/fallback-policy.test.mjs` 用例 19 覆盖全分支（三 advance 类 + 各 stop 类 + touched 六态 + 非 plain-object 输入 + 冻结 + 不泄漏 secret 输入）；`fallback-policy-parity.test.ts` 新增 launch 对拍矩阵 20 kinds × 6 touched = 120 行全等价 + 冻结一致性 + malformed 输入 + 决定性正负例两侧锚定。

## 验证命令与原始退出码

```
# 根侧策略（改动前 18 用例 → 现 19 用例）
cd /Users/markus/ai-agent-cockpit && node --test --test-reporter=dot tests/fallback-policy.test.mjs
# → 19 个点，exit=0

# vendor 对拍 + 候选链（5 + 7 用例）
cd vendor/wechat-acp && node --import tsx/esm --test --test-reporter=dot tests/fallback-policy-parity.test.ts tests/session-launch-fallback.test.ts
# → 12 个点，exit=0

# vendor 类型检查（strict）
cd vendor/wechat-acp && npx tsc --noEmit
# → exit=0（无输出）

# vendor 全量（改动前基线 410：409 pass + 1 skip，已先行复跑确认）
cd vendor/wechat-acp && node --import tsx/esm --test "tests/**/*.ts"
# → ℹ tests 419 / pass 418 / fail 0 / skipped 1，exit=0（dot 模式 419 个点）
#   419 = 410 基线 + 7 候选链 + 2 对拍；skip 仍为原 1 条

# reviewer 不变量 + 既有相关根侧套件
node --test tests/reviewer-routing-invariant.test.mjs            # 3/3 pass，exit=0
node --test tests/goal-ai.test.mjs tests/goal-access-broker.test.mjs \
     tests/native-acp-executor.test.mjs tests/control-plane.test.mjs
# → ℹ tests 92 / pass 92 / fail 0，exit=0（goal-access-broker 为真实 macOS Seatbelt 路径，非 skip）
```

未跑根侧全量 tests/（本批根侧只动 `runtime/fallback-policy.mjs` 纯模块与其测试、新增一条不变量测试；上表已覆盖全部直接消费面）。

## 诚实边界

- **auth 分类的深度**：当前 spawnAgent 没有任何路径产生 `kind:'auth_error'`——ACP 层认证错误会以 JSON-RPC error 落在 initialize/new-session，归为 `launch-error`（或 touched=true 时由屏障归为 `unknown-launch-effect`），**两者均 stop**，故"认证故障零重派"现阶段由 fail-closed 默认达成；`auth-failure` 分支由接缝测试固化，provider 特有认证错误码的逐一枚举未做（枚举后 stop 语义不变，只是 reason 更精确）。
- **`AgentProcessCleanupError` 不包装**（设计合同二选一）：保留原类型与双错误；靠"无 kind" fail-closed。`cleanup-uncertain` 分支保留在门内但未接线。
- **测试接缝**：`SessionManagerOpts.spawnAgent?: typeof spawnAgent` 为本批新增（默认 `(this.opts.spawnAgent ?? spawnAgent)(...)`），仅用于注入真实 spawn 无法产生的 kind（auth_error、非结构化 Error）；生产调用方不传即原行为。是否接受该接缝请审计方裁决。
- **EPIPE 噪音**：用例 g（进程启动即退）运行时被测进程 stdin 写入会打印一条 EPIPE 栈（既有 spawnAgent 竞态的固有表现，非本批引入，不导致失败）。
- **Windows 未验证**：`useShell` 分支、EACCES 探针、posix process-group 清理均只在 macOS（darwin，Node v24.15.0）验证。
- **message 子串归类**：`startup-exit`/`startup-timeout`/`aborted` 依赖 spawnAgent 自身的固定 message 文案（同文件内生成，非第三方文本）；第三方错误文本不会误入这三类（落入 `launch-error` → stop）。
- 根侧 `classifyLaunchFailure` 为独立导出，未接入 `createFallbackPolicy` 实例接口（候选链消费的是 vendor 镜像侧；两侧由对拍锁定）。

## 要求审计方裁决点

1. `toStartupError` 的 kind 归类表（errno 字符串/固定 message 子串/默认 `launch-error`）与"数值 JSON-RPC code 不映射 spawn 类"是否符合 §5 第 3 条意图。
2. `AgentProcessCleanupError` 保持原类型不包装（gate 靠无 kind fail-closed）是否接受，或要求改走 `cleanup-uncertain` 映射。
3. `SessionManagerOpts.spawnAgent` 测试接缝是否接受。
4. 决策表本身：touched 屏障先于一切、`aborted` 独立于 touched 的 stop reason、三个 advance 类的边界（尤其 `startup-timeout` clean 可推进是否过宽）。
5. reviewer 核查结论与 `goal-runtime.mjs:117` 执行记录未标 role 的观察项是否需要后续批次补标。
6. 新建测试文件两个（`session-launch-fallback.test.ts`、`reviewer-routing-invariant.test.mjs`）的夹具真实性（真实子进程/真实 Seatbelt 既有面 vs 注入接缝）是否满足证据标准。
