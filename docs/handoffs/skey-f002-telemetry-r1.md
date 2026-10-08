# 执行交接包：SKEY-F002 微信连接器遥测返工（r1）+ 仓库泄漏扫描门槛

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包逐条回应 [2026-10-08 密钥专项审计](../audits/2026-10-08-secret-scan.md) 的 **SKEY-F002（Major / CHANGES_REQUESTED）** 六条返工要求。r1 失败证据（审计探针）与旧文件保留不覆盖。

## 批次身份与状态

- batchId / revision：skey-f002-telemetry / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行方：Kimi Code 会话（执行方）；branch `feat/0.3.0-progress`；cwd `/Users/markus/ai-agent-cockpit`；返工由该会话 subagent（deepseek-flash）完成，主 Agent 定返工设计、亲自复跑。
- 已读并对齐约束：默认关闭、不连真实遥测端点、不碰生产服务/launchd/真实用户文件、**本批未执行任何 git 命令**、未改 `docs/audits/**`、未改 `docs/plans/**`；`package.json` 仅新增一行 script。
- `vendor/wechat-acp/` 下**无自己的 AGENTS.md**（该目录只有上游 README/LICENSE/CHANGELOG）；vendor 内测试使用该包自带 runner（`node --import tsx/esm --test`，tsx/typescript 已在包 devDependencies，未新增依赖）。
- 本批目标：关闭 SKEY-F002 源码层（默认关闭 + 异常/事件白名单 + 文档同步 + 假 SDK 负例 + 泄漏扫描门槛）。明确不做：生产重启/切换、真实 SDK 联网验证、0.3.0 裁剪裁决。
- 写入文件（全部）：`vendor/wechat-acp/src/telemetry/index.ts`（改）、`vendor/wechat-acp/tests/telemetry.test.ts`（新）、`vendor/wechat-acp/README.md`（改 Telemetry 段）、`scripts/secret-scan.mjs`（新）、`config/secret-scan-dispositions.json`（新）、`docs/handoffs/skey-f002-telemetry-r1.md`（新）、`package.json`（+1 行 script）。

## 固定来源（完整 sha256）

- base HEAD（只读自审计快照；本批未执行任何 git 命令）：`19e4e274a9306aa3fee0515b86ac22c90e8ca7d7`
- 绑定返工前 telemetry 源码（审计冻结）：`fccfc087f2f15d402bbf38ca311b65cbf5224bb39a3cce7cb9400472e4f6133a`
- 变更/新增文件（SHA256，2026-10-08）：
  - `vendor/wechat-acp/src/telemetry/index.ts`（**改**） = `4b2a7abc99469d12e3f04475624c19d4ca5f87e05608f60d31de7469540541da`（原 `fccfc087…f6133a`）
  - `vendor/wechat-acp/tests/telemetry.test.ts`（新） = `310c87861164fc298fb1a34d3487ed1f39feb129708ca6529d2d552e6ad36494`
  - `vendor/wechat-acp/README.md`（改） = `475cf0587cfe2b3e10a4cdbf86fdf4d1a2209418c1dbe34d47122f7348733673`
  - `scripts/secret-scan.mjs`（新） = `3ead55c414b348c8df47ef95ba6d7f1e910a424b24fa7dae7963015471c5af73`
  - `config/secret-scan-dispositions.json`（新） = `7e80416b6ab13e7226884929d84c43bdfd23f47b472aa4cb9b81ef1fab9fa27d`
  - `package.json`（改，仅 +1 行 script） = `4503ae070c5635b07ddc7384efe7436c8d7a28fa9adab70488…`（不形成共享冻结版本，多批共用）
- 只读未改的调用点（未重写，仅确认签名兼容）：`vendor/wechat-acp/bin/wechat-acp.ts`、`src/bridge.ts`、`src/acp/session.ts`、`src/acp/agent-manager.ts`、`src/weixin/monitor.ts`。
- 依赖：无新依赖；纯 Node/TypeScript，telemetry 模块保留 `initTelemetry/trackEvent/trackException/hashUserId/shutdownTelemetry` 与 `EventName` 导出，调用方零改动。

## Finding 逐条回答（SKEY-F002）

### 1. 默认禁用（核心）→ 已实现

- 删除上游硬编码连接串（含 Azure instrumentation 标识）：源码中**不再存在任何连接串字面量**（原 `index.ts:21-22` 已移除）。
- 开关语义：仅当 `WECHAT_ACP_TELEMETRY=1`（亦接受 `true`/`on`）**且** `WECHAT_ACP_TELEMETRY_CONNECTION_STRING`（trim 后非空）同时提供时才启用；缺任一条件即 `disabled=true`，**不加载 SDK、不生成安装 ID、不写任何遥测文件、不提交任何事件**。
- 连接串仅从 `process.env` 读取，作为 `appInsights.setup(cs)` 入参；不写入日志、不存 client 字段、不进入任何事件属性（负例实测外发载荷无 `InstrumentationKey`/`IngestionEndpoint`）。模块为 Node-only（`node:fs`/`node:crypto`/`node:module`），不进浏览器包。
- 安装 ID 只在启用路径、初始化成功时落盘 `storageDir/telemetry-id`；默认路径完全不触碰文件系统。

### 2. 异常遥测内容白名单 → 已实现

- `trackException(err, area, sessionId)` 只发两个字段：`category`（对 `area` 走固定 allowlist，非白名单 → `unclassified`）与 `code`（仅由 `err.name` 经固定 `name→code` 映射得到有限枚举：`E_ABORT/E_TIMEOUT/E_TYPE/E_RANGE/E_SYNTAX/E_REFERENCE/E_GENERIC/E_UNKNOWN`；`err.name` 不在映射表 → `E_UNKNOWN`）。
- **绝不读取/发送** `err.message`、`err.stack`、`err.cause`、请求正文、headers、任意 `properties` 原文。传给 SDK 的是**自造的 sanitized Error**（`message = "<category>:<code>"`、`name = <code>`、`stack = undefined`），原始 Error 对象不外发（负例断言 `notEqual(payload.exception, originalError)`）。
- 不依赖任何 token 正则去 scrub 正文——正文本就不发。
- `trackEvent` 同理：事件名走固定 `EVENT_PROP_SCHEMA`（未知事件名整条丢弃）；属性键走 per-event allowlist；值经 coerce 为有界类型：`bool` / 有界整数（`0..1e12`，负值/非有限丢弃）/ `hash`（`^[0-9a-f]{1,64}$`，否则丢弃）/ 固定枚举（不在集合 → `other`）/ 有界标识 token（`^[A-Za-z0-9._/+-]{1,64}$`，否则 `other`）/ 错误码。含空白、引号、`=`、`:`、`@` 的自由文本一律落到 `other`，不原样外发。

### 3. 文档同步 → 已实现

- `vendor/wechat-acp` **无** `.env.example`（且该目录 `.gitignore` 忽略 `.env.*`，新建不可追踪），故按合同同步进 **README 配置说明**（`README.md` 的 `## Telemetry` 段）：
  - 明确 **默认关闭**；给出双开关表（`WECHAT_ACP_TELEMETRY`、`WECHAT_ACP_TELEMETRY_CONNECTION_STRING`）与启用示例；
  - 说明连接串仅从环境读取、不落日志/磁盘、不作为事件字段；
  - 更新「采集内容」为有界枚举/计数；异常上报仅 `category`+`code`，**从不采集** message/stack/cause/请求正文/headers。

### 4. 假 SDK 负例测试（全离线）→ 已实现

- 新增 `vendor/wechat-acp/tests/telemetry.test.ts`，用**内存假 SDK**（`createTelemetry({ getEnv, sdkLoader })` 注入）+ 临时目录；无真实端点、无网络、无真实用户文件。synthetic credential 用 `TESTONLY-cred-…` 本进程构造，不落盘。
- 覆盖（11 用例，全部通过）：
  1. 缺省配置：SDK 加载 0 次、文件系统 0 次、事件/异常/关闭 flush 均 0、无 `telemetry-id` 文件；
  2. 显式 `WECHAT_ACP_TELEMETRY=0`（即便给了连接串）：全静默；
  3. `=1` 但缺/空/空白连接串：全静默（3 组参数）；
  4. SDK 初始化失败（loader 抛错）：`init` 不抛、`track*` 惰性无害；
  5. setup 抛错：同样静默降级；
  6. `Error`/`string`/nested `cause` 含 TESTONLY credential：外发载荷只有 `{category, code}`，无 credential/无 stack/无原始 Error，未知 area → `unclassified`；
  7. `trackEvent` 只保留白名单键与有界值（多余键丢弃、非法枚举→`other`、非法 hash 丢弃、负计数丢弃、小数取整、未知事件名整条丢弃、原始 session id 不外发）；
  8. 启用路径外发载荷不含连接串字面量；
  9. 重复初始化幂等（SDK 加载 1 次、首个 init 生效）；
  10. `shutdown` 后所有调用零效果，重复 `shutdown` 不再 flush，close 后 `init` 不重装；
  11. 默认关闭下 `hashUserId` 仍可用且不建文件。
- 证明：**启用路径的外发载荷只有白名单字段**（逐条 `deepEqual` properties + 全量 `egressBlob` 不含 TESTONLY/自由文本/连接串）。

### 5. 泄漏扫描门槛（仓库级）→ 已实现

- 新增 `scripts/secret-scan.mjs`：纯 Node、零外部依赖、确定性。用 `git ls-files -z` 取 tracked 文件（git 不可用时回退文件系统遍历），排除 `node_modules`、锁文件、二进制（含 NUL）、以及脚本/处置文件自身。
- 规则：Google / GitHub（含 fine-grained PAT）/ OpenAI（含 project key）/ Anthropic / AWS access key id / JWT / private-key / Slack / Stripe / GitLab / npm token 形状。
- 命中处置：仅当**路径 + 匹配值 sha256** 命中 `config/secret-scan-dispositions.json` 的精确条目才放行；否则 **exit 1** 并打印 `path:line:col` 与 **前后各 4 字符掩码**（不打印完整值）。**未做 tests/vendor/docs 全目录豁免。**
- 处置清单为本仓库现有 6 条合成/示例命中（含审计点名的 `agent-env.test.ts:21` Stripe 样例），每条附理由与审计依据；真实/未知新增命中仍会失败。
- 新增 script：`"audit:secrets": "node scripts/secret-scan.mjs"`（`package.json` 唯一改动，+1 行）。
- 自身正例：当前代码库实跑 **0 未处置命中**（见下「实跑输出」）；`--self-test` 证明 12 种形状可被检出、掩码不泄漏、处置按 (路径, 值哈希) 精确匹配。

### 6. 交接包 → 本文件

（含 sourceRef、离线原始结果摘要、未覆盖项；见下。）

## 关键 diff 摘要（`vendor/wechat-acp/src/telemetry/index.ts`）

1. 删除 `CONNECTION_STRING` 字面量；新增 `createTelemetry(deps)` 工厂（注入 `getEnv`/`sdkLoader`），默认单例包在顶部导出，保持调用方签名不变。
2. 新增 `OPT_IN_VALUES={1,true,on}`、`CONNECTION_STRING_ENV`；`init` 双条件判定：`optIn && connectionString` 才继续，否则 `disabled`。
3. 新增 `EVENT_PROP_SCHEMA`（18 事件 × 允许键 × 值类型）、`EXCEPTION_CATEGORIES`、`ERROR_CODE_BY_NAME`、`ENUM_VALUES`、`coerceProp()`、`classifyErrorCode()`。
4. `trackEvent`：未知事件名丢弃；仅 coerce 白名单键；值字符串化后外发。
5. `trackException`：只发 `{category, code}`；自造 sanitized Error（无 stack），原始 err 不外发；`buildTagOverrides` 对 sessionId 做 `TOKEN_RE` 校验，非法则回退 installId/`anonymous`。
6. `init` 幂等 (`initialized`)；`shutdown` 置 `closed` 终态（其后 `init`/`track*` 全零效果），flush 仅一次。
7. 文档注释更新为 OPT-IN ONLY 语义。

## 假 SDK 负例原始结果摘要

命令：`cd vendor/wechat-acp && node --import tsx/esm --test tests/telemetry.test.ts`（该包自带 runner，Node v24.15.0）

```
ℹ tests 11
ℹ pass 11
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 88.977833
EXIT=0
```

回归（整包）：`node --import tsx/esm --test 'tests/**/*.ts'`

```
ℹ tests 324
ℹ pass 323
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 2847.383959
EXIT=0
```

（1 skipped 为该包原有 skip，与本批无关；telemetry 用例 11/11 全绿。）

## 扫描门槛实跑输出

自身正例（当前代码库）：`node scripts/secret-scan.mjs`

```
== secret-scan ==
file list      : git ls-files
files scanned  : 1694 (binary skipped: 55)
dispositions   : 6

Dispositioned hits (7):
  ok  jwt  tests/memory_service_test.py:1074:14  sha256=9027c6a3d4bb  value=eyJh…mnop  [Synthetic JWT-shaped literal used as an offline positive case for the credential-detection heuristic in the memory-quality unit test; not a real token and never leaves the test process.]
  ok  private_key  tests/memory_service_test.py:1075:14  sha256=8bcac7908eb9  value=----…----  [PEM header marker only (no key material) used as an offline positive case for the credential-detection heuristic; the literal is a header, not a private key.]
  ok  aws_access_key_id  vendor/cezar/packages/cezar/src/core/agent-env.test.ts:19:25  sha256=1a5d44a2dca1  value=AKIA…MPLE  [AWS documentation example access key id (the well-known public EXAMPLE key) used to verify that child processes strip credential-looking env vars. Documented example, not a live key.]
  ok  aws_access_key_id  vendor/cezar/packages/cezar/src/core/agent-env.test.ts:226:25  sha256=1a5d44a2dca1  value=AKIA…MPLE  [AWS documentation example access key id (the well-known public EXAMPLE key) used to verify that child processes strip credential-looking env vars. Documented example, not a live key.]
  ok  stripe_secret_key  vendor/cezar/packages/cezar/src/core/agent-env.test.ts:21:25  sha256=3ba766556e84  value=sk_l…xxxx  [Synthetic Stripe-shaped placeholder verifying child-env secret stripping. Audit classified agent-env.test.ts:21 as a locally constructed synthetic test sample (not a credential).]
  ok  anthropic_api_key  vendor/cezar/packages/cezar/src/runs/store.test.ts:506:53  sha256=4195bc513076  value=sk-a…qrst  [Synthetic Anthropic-shaped sample used to verify secret redaction when persisting run data; constructed test fixture, not a real key.]
  ok  aws_access_key_id  vendor/cezar/packages/cezar/src/runs/store.test.ts:506:28  sha256=1a5d44a2dca1  value=AKIA…MPLE  [Same AWS documentation example access key id used as a redaction fixture in the run-store unit test.]

PASS: 0 undispositioned credential-shaped hits.
SCAN_EXIT=0
```

fail-closed 反证（临时目录合成两个未处置命中，`SECRET_SCAN_ROOT` 指向之）：

```
== secret-scan ==
file list      : filesystem walk (git unavailable)
files scanned  : 2 (binary skipped: 0)
dispositions   : 0

UNRESOLVED hits (2):
  !!  github_token  notes.txt:1:1  sha256=218c83c46ff5  value=ghp_…bbbb
  !!  google_api_key  src/leak.js:1:12  sha256=b62246d9aec1  value=AIZA…AAAA

FAIL: 2 undispositioned credential-shaped hit(s).
Command failed with exit code: 1.
```

`--self-test`：`self-test PASS: 12 shapes detected, masking safe, dispositions exact.`（exit 0）

## 验证

| 套件/命令 | 结果 |
| --- | --- |
| telemetry 负例 `node --import tsx/esm --test tests/telemetry.test.ts` | **11/11** pass，exit 0 |
| wechat-acp 整包 `node --import tsx/esm --test 'tests/**/*.ts'` | **324 tests / 323 pass / 0 fail / 1 skip**，exit 0 |
| 包构建/类型检查 `npm --prefix vendor/wechat-acp run build`（tsc，strict） | exit 0 |
| 泄漏扫描 `node scripts/secret-scan.mjs` | 1694 文件、0 未处置命中，exit 0 |
| 扫描器自检 `--self-test` | PASS，exit 0 |
| fail-closed 反证（临时根） | 2 未处置命中 → exit 1（按预期失败） |

- 未执行任何真实遥测外呼、未连任何真实网络端点、未改生产配置、未重启/切换服务、未触碰真实用户文件、**未执行任何 git 命令**（扫描器运行期对 `git ls-files` 的只读调用属合同要求的机制，非本进程自行操作）。
- sourceRef 复核：仅上列文件按授权变更；`docs/audits/**`、`docs/plans/**` 零改动；`package.json` 仅 +1 行。

## 要求审计方做什么

- 按 SKEY-F002 第 1–6 条逐条复核新 hash、白名单 schema、负例与扫描实跑输出。
- 重点裁决 ①：`trackEvent` 的 `agentPreset`/`configId`/`optionValue`/`mimeType` 采用**有界标识 token**（`^[A-Za-z0-9._/+-]{1,64}$`，非法→`other`）而非闭合枚举——是否接受为「有界、非自由文本」；如需更严格可将其收敛为闭合枚举或一律 `other`（未做，待裁决）。
- 重点裁决 ②：`config/secret-scan-dispositions.json` 的 6 条精确处置（多为 `vendor/cezar` 合成/文档示例）是否被接受；**非返工前请勿把本清单当作目录豁免**。

## 未覆盖项与诚实边界声明

- **生产未重启**：现役进程仍运行**旧遥测代码**（旧 `dist`/旧进程）；本批只改源码与仓库门槛，**部署/重启另批**。`vendor/wechat-acp/dist/` 被 `.gitignore` 忽略，本批虽执行了 `npm run build` 刷新本地 `dist`，但 `dist` 不属 tracked、不构成本批交付物，也不代表线上已切换。
- **真实 SDK 行为未验**：全部负例使用假 SDK / 注入 loader，**未用真实 `applicationinsights` 向任何真实端点发送过数据**；真实 SDK 的实际网络行为、Azure 侧字段落地未验证。
- **连接串来源未接**：启用所需的 `WECHAT_ACP_TELEMETRY_CONNECTION_STRING` 由运维以环境变量提供；本批**未**在任何配置/launchd/服务文件中写入该变量（遵守「不碰生产服务」约束）。
- **遥测是否彻底移除属 0.3.0 裁剪裁决**：本批按审计第 2 条「若保留则白名单化」实现；是否按裁剪设计整模块移除（含删除 `applicationinsights` 依赖与全部调用点）需 0.3.0 设计裁决，本批未做。
- **扫描器边界**：确定性形状匹配，非熵/非穷尽编码；`git ls-files` 仅覆盖 tracked 文件（未追踪新文件、ignored 本地文件、`node_modules`、二进制、锁文件不在内）；不验证密钥真伪、不向供应商发送疑似值。范围同审计，不替代 gitleaks。
- 未改 `docs/audits/**`、`docs/plans/**`；未删任何测试；未新建 `vendor/wechat-acp/.env.example`（该目录忽略 `.env.*`，故同步至 README）。
