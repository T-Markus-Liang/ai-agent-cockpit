# 执行交接包：SKEY-F003 遥测返工（r2）+ 假 SDK 全出口断言

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包为 **r2** revision，逐条回应 [2026-10-08 SKEY-F002 遥测 r1 复核](../audits/2026-10-08-telemetry-r1-review.md)（**CHANGES_REQUESTED / SKEY-F003**）。r1 交接（`docs/handoffs/skey-f002-telemetry-r1.md`）与审计证据保留不动。

## 批次身份与状态

- batchId / revision：skey-f002-telemetry / **r2**
- 状态：**READY_FOR_REVIEW**
- 执行方：Kimi Code 会话（执行方）；branch `feat/0.3.0-progress`；cwd `/Users/markus/ai-agent-cockpit`；返工由该会话 subagent（deepseek-flash）完成，主 Agent 定设计、亲自复跑。
- 已读并遵守铁律：全离线假 SDK/注入 loader、不连真实端点、不碰生产、**本批未执行任何 git 命令**、未改 `docs/audits/**`、`docs/plans/**`、**未改 `package.json`**（`audit:secrets` 已在，r2 未触碰）。
- `vendor/wechat-acp/` 下无自己的 AGENTS.md；vendor 内测试用该包自带 runner（`node --import tsx/esm --test`），未新增依赖。
- r2 写入文件（全部）：`vendor/wechat-acp/src/telemetry/index.ts`（改）、`vendor/wechat-acp/tests/telemetry.test.ts`（改，+2 用例）、`docs/handoffs/skey-f002-telemetry-r2.md`（新）。**未改** README、`scripts/secret-scan.mjs`、`config/secret-scan-dispositions.json`（无新增/变更合成样例，清单无需更新）。

## 固定来源（完整 sha256）

- base HEAD（只读自审计快照；本批未执行任何 git 命令）：`19e4e274a9306aa3fee0515b86ac22c90e8ca7d7`
- r1 被审源码（复核绑定）：`4b2a7abc99469d12e3f04475624c19d4ca5f87e05608f60d31de7469540541da`
- r2 变更/新增文件（SHA256，2026-10-08）：
  - `vendor/wechat-acp/src/telemetry/index.ts`（**改**） = `fbfe8235cd42c24c873d27d8d01622f65730bd6ae2096768bdb3d1138c635d2d`（r1 `4b2a7abc…d541da`）
  - `vendor/wechat-acp/tests/telemetry.test.ts`（**改**，11 → 13 用例） = `a5435c2a09725a9b38161fa2ae1f6ec5a473509910dc3d545723c534e8da487e`（r1 `310c8786…d36494`）
  - `docs/handoffs/skey-f002-telemetry-r2.md`（新，本文件）
- r2 未改动、沿用 r1 hash：`vendor/wechat-acp/README.md` = `475cf0587cfe2b3e10a4cdbf86fdf4d1a2209418c1dbe34d47122f7348733673`；`scripts/secret-scan.mjs` = `3ead55c414b348c8df47ef95ba6d7f1e910a424b24fa7dae7963015471c5af73`；`config/secret-scan-dispositions.json` = `7e80416b6ab13e7226884929d84c43bdfd23f47b472aa4cb9b81ef1fab9fa27d`
- 只读未改的调用点：`bin/wechat-acp.ts`、`src/bridge.ts`、`src/acp/session.ts`、`src/acp/agent-manager.ts`、`src/weixin/monitor.ts`（r2 保持 `initTelemetry/trackEvent/trackException/hashUserId/shutdownTelemetry` 签名，调用方零改动）。
- 依赖：无新依赖。

## Finding 逐条回答（r2 合同 6 条）

### 1. 保持默认关闭，不恢复硬编码连接串 → 保持

未回归。`WECHAT_ACP_TELEMETRY` 未设置或非 `1/true/on`，或缺 `WECHAT_ACP_TELEMETRY_CONNECTION_STRING`（trim 空）时：不加载 SDK、不生成安装 ID、不写文件、不发事件/异常。源码内仍**无任何连接串字面量**。审计探针在 r2 上仍观测 `defaultOff: true`。

### 2. 外发值只来自枚举/计数/代码计算哈希/可信版本元数据 → 已实现

- **删除 `TOKEN_RE` 透传路径**：`coerceProp` 不再有 `"token"` 类型；对任意原文不再用「1–64 字符合法字符集」当安全批准。
- 现在每个外发值只能是：`bool` / 有界整数（`0..1e12`）/ 固定枚举（非集合 → `other`，preset → `custom`）/ `hash`（十六进制，仅接受 `hashUserId` 这类代码计算产物）/ `saltedHash`（**模块内 `hashWithSalt()` 计算的加盐哈希**）/ 错误码枚举。
- `version` 为可信版本元数据，但仍经 `boundedVersion()`（`^[0-9A-Za-z.+-]{1,32}$`，越界 → `unknown`）。

### 3. 逐项修复 → 已实现

- **`agentPreset`**（event `app.start`/`session.created`/`prompt.completed` 及 `commonProperties.agentPreset`）：统一走 `classifyAgentPreset()` → 已知内置类别集合（`copilot/claude/gemini/qwen/codex/opencode/openclaw/kiro/hermes/kimi/pi/raw`），未知 → **`custom`**。原文绝不外发。
- **`optionValue` / `configId`（同类 config 值）**：schema 类型改为 `saltedHash` —— 只外发 `hashWithSalt(installId||常量, value).slice(0,16)`，**不传自由字符串**（键名保持 `optionValue`/`configId` 以维持调用方契约；值为 16-hex 加盐哈希）。`optionType` 仍为枚举（`select/boolean/unknown`）。
- **session tag（`ai.session.id`）**：`buildTagOverrides()` 改为对调用者 sessionId 做 `saltedHash()`（salt = 安装级随机 `installId`，无则固定常量 `HASH_SALT_FALLBACK`），sessionId 为空时回退 installId/`anonymous`。**event 与 exception 两条路径都调用同一 `buildTagOverrides()`**。
- **commonProperties / context.tags 全字段受约束**：`commonProperties = { version(bounded), node, os, arch, installId(随机 UUID), agentPreset(分类), daemon(String(bool)) }`；`context.tags = { ai.cloud.role="wechat-acp"、ai.user.id=installId、ai.application.ver=bounded version }`。全部为固定常量 / 随机 ID / 可信元数据 / 分类值，无原文透传。

### 4. 完整 egress 收集断言 → 已实现

新增用例 `full egress surface carries no raw credential, path, URL or free text`：用假 SDK 采集**全出口**（`init` 写入的 `commonProperties` 与 `context.tags`、全部 `events`（含 `properties`+`tagOverrides`）、全部 `exceptions`（含 message/stack/properties/tagOverrides）；序列化器 `egressBlob()` 覆盖这些位置）。对每个可接受字段位置注入 synthetic credential（`TESTONLY` 构造）、私有路径、URL、自由文本，断言序列化后**不含任一原文**；并断言 `version` 被界定为 `unknown`、`agentPreset` 落 `custom`、tags 均为 ≤64 有界串。

### 5. 审计 r1 探针路径回归测试 → 已实现

新增用例 `SKEY-F003: audit canary (sk-identifier shape) never egresses via config/tag/preset`：复刻审计探针的 35 字符合成值 `"sk-" + "TESTONLY".repeat(4)`，作为 `agentPreset`（init）、`configId`/`optionValue`（event）、sessionId（event 与 exception）输入，断言：
- 全出口 `egressBlob` 不含 `sk-TESTONLY`；
- `optionValue`/`configId` 仅为 16-hex 加盐哈希，`optionType` 保留；
- event 与 exception 的 `ai.session.id` 均为 16-hex 且**相等**（同一 tag 计算）；
- `commonProperties.agentPreset === "custom"`；
- 异常 message 不含 canary、`stack === undefined`。

**同一探针在 r1 会失败、r2 通过**（见下「审计探针重放」原始输出）：r1 复核记录 4 项均为泄漏（`…Leaked: true`），r2 全部为 `false`。既有 11 个负例保持全绿，**合计 13/13**。

### 6. r2 交接包 → 本文件

（含 sourceRef、逐条回答、负例原始结果、探针重放、未覆盖项。）

## 关键 diff 摘要（`vendor/wechat-acp/src/telemetry/index.ts`）

1. `PropKind` 删除 `"token"`，新增 `"saltedHash"` / `"agentPresetEnum"` / `"mimeEnum"`。
2. `EVENT_PROP_SCHEMA`：`agentPreset` → `"agentPresetEnum"`（3 处）；`configId`/`optionValue` → `"saltedHash"`；`mimeType` → `"mimeEnum"`（3 处）。
3. 新增 `agentPresetEnum`（12 个已知预设）与 `mimeEnum`（20 个常见 MIME）集合；`mimeType` 不再透传。
4. 新增 `hashWithSalt(salt,value)`（模块级）与实例 `saltedHash(value)`（salt=installId||`HASH_SALT_FALLBACK`）；新增 `classifyAgentPreset()`、`boundedVersion()`；删除 `TOKEN_RE`/`TOKEN_FALLBACK`。
5. `coerceProp(kind,value,hash)` 接收实例哈希函数；`"saltedHash"` → 计算哈希；`"agentPresetEnum"` → 分类或 `custom`。
6. `init`：`version=boundedVersion(opts.version)`；`commonProperties.version`、`ai.application.ver` 用有界版本；`commonProperties.agentPreset=classifyAgentPreset(opts.agentPreset)`。
7. `buildTagOverrides`：sessionId → `saltedHash(sessionId)`，不再用正则放行原文；event 与 exception 共用。
8. 头部文档注释更新为 SKEY-F003 契约。

## 假 SDK 负例原始结果摘要

命令：`cd vendor/wechat-acp && node --import tsx/esm --test tests/telemetry.test.ts`（该包自带 runner，Node v24.15.0）

```
ℹ tests 13
ℹ pass 13
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 111.067875
EXIT=0
```

回归（整包）：`node --import tsx/esm --test 'tests/**/*.ts'`

```
ℹ tests 326
ℹ pass 325
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 2789.173709
EXIT=0
```

（1 skipped 为该包原有 skip，与本批无关。）

## 审计探针重放（复用审计的 r1 探针路径，仅去掉冻结 sha 断言）

用审计证据 `telemetry-r1-probe.mjs` 的**同一路径**（同一 synthetic canary、同一假 SDK/假 fs、无网络），在 /tmp 副本中去掉 `sourceSha256==='4b2a7abc…'` 断言后指向 **r2 源码**运行：

```
--- replay audit probe on r2 source ---
{
  "sourceSha256": "fbfe8235cd42c24c873d27d8d01622f65730bd6ae2096768bdb3d1138c635d2d",
  "network": "none; fake SDK",
  "filesystem": "fake only",
  "defaultOff": true,
  "rawExceptionMessageDropped": true,
  "rawExceptionStackDropped": true,
  "eventPropertyCanaryLeaked": false,
  "eventTagCanaryLeaked": false,
  "exceptionTagCanaryLeaked": false,
  "commonPropertyCanaryLeaked": false
}
PROBE_EXIT=0
```

对照 r1 复核的观察（`telemetry-r1-probe-results.json`）：`eventPropertyCanaryLeaked/eventTagCanaryLeaked/exceptionTagCanaryLeaked/commonPropertyCanaryLeaked` 均为 `true`；r2 全部翻为 `false`。

## 泄漏扫描门槛（未受影响）

r2 未新增合成样例（新测试中的 canary 用 `"sk-"+"TESTONLY".repeat(4)` 与 `["TESTONLY",…].join("-")` 构造，源内无字面量），处置清单无需变更。实跑 `npm run audit:secrets`：

```
== secret-scan ==
file list      : git ls-files
files scanned  : 1694 (binary skipped: 55)
dispositions   : 6
…（7 条 dispositioned hits 全部 ok）…
PASS: 0 undispositioned credential-shaped hits.
SCAN_EXIT=0
```

## 验证

| 套件/命令 | 结果 |
| --- | --- |
| telemetry 负例 `node --import tsx/esm --test tests/telemetry.test.ts` | **13/13** pass，exit 0 |
| wechat-acp 整包 `node --import tsx/esm --test 'tests/**/*.ts'` | **326 tests / 325 pass / 0 fail / 1 skip**，exit 0 |
| 包构建/类型检查 `npm --prefix vendor/wechat-acp run build`（tsc，strict） | exit 0 |
| 泄漏扫描 `npm run audit:secrets` | 0 未处置命中，exit 0 |
| 审计探针重放（r2 源码） | 4 项泄漏路径全 `false`，exit 0 |

- 未执行任何真实遥测外呼/真实网络、未改生产/launchd/真实用户文件、**未执行任何 git 命令**。
- sourceRef 复核：r2 仅改 `src/telemetry/index.ts`、`tests/telemetry.test.ts`，新增本交接文件；README / 扫描器 / 处置清单 / `package.json` 零改动。

## 要求审计方做什么

- 按 SKEY-F003 与 r2 合同 1–6 复核：默认关闭仍在、无连接串、值来源收敛到枚举/计数/哈希/版本、config 值哈希化、session tag 加盐且两条路径一致、commonProperties/context.tags 受约束、全出口断言、探针重放全 false。
- 重点裁决：`configId`/`optionValue` 采用「键名不变、值为 16-hex 加盐哈希」是否接受（vs 直接删除该字段）；`hash` 类型仍接受 `hashUserId` 输出的 16-hex（代码计算产物，未再哈希）是否接受。

## 未覆盖项与诚实边界声明

- **生产未重启**：现役进程仍运行旧遥测代码；本批只改源码（`dist/` 被 gitignore，不属交付物）。部署/重启另批。
- **真实 SDK 行为未验**：全部假 SDK/注入 loader，未向任何真实端点发送数据。
- **加盐哈希的可逆性**：session/config 值用 install 级随机 salt 加盐后截断 16-hex，跨安装在不可逆假设下不可链接；但**低熵输入**（如枚举式 config 值）在持有 installId 时仍可枚举比对——本批只保证「不外发原文」，不承诺抗穷举。
- **`hash` 类型来源不可自证**：模块无法独立证明传入的 16-hex 确实来自 `hashUserId`，依赖调用方契约（现调用点均传 `hashUserId` 输出）。
- **遥测是否彻底移除属 0.3.0 裁剪裁决**：本批按「保留则白名单化 + 哈希化」实现；整模块移除（含删依赖与调用点）需设计裁决，未做。
- `package.json` 本批零改动；相对 r1 交接所示 hash 的差异来自并行批次的 `test:native-acp-executor` 行，非本批。
