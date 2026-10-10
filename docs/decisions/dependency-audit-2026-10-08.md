# 依赖 · 许可 · 遥测审计（I01/P0，2026-10-08）

对应执行计划 I01：“完整引用/依赖/许可审计；生命周期 scripts 与遥测审核”。
本文档由只读审计工具 `scripts/dependency-audit.mjs` 的真实输出整理而成，不含推测数据。

- 运行命令：`npm run audit:deps`（= `node scripts/dependency-audit.mjs`）
- 运行结果：**退出码 1**（存在 3 个许可未声明项，见 §4）
- 审计对象：根 `package.json` / `package-lock.json`、`node_modules/<pkg>/package.json`、
  `vendor/cezar/**`、`vendor/wechat-acp/**`
- 边界：全程只读、零依赖、不联网、不安装、不修改依赖、不提交

---

## 1. 结论速览

| 维度 | 结果 | 是否违例 |
| --- | --- | --- |
| 钉版完整性（dependencies + overrides ↔ lock 解析） | 0 处漂移，全部精确命中 | 否 |
| 许可清单（全 lock 图，121 个包） | 118 allowlisted / **3 unknown** | **是（退出码 1）** |
| 生命周期 install scripts（全 lock 图） | 9 个包，全部列出 | 否（审核对象） |
| 遥测面关键词扫描（仅直接依赖） | 4/5 有命中，均为字面/契约命中，无一条指向真实外发 | 否（审核对象） |
| vendor 摘要 | cezar 4 workspace MIT + 1 未声明（desktop，非 workspace）；wechat-acp MIT | 记录 |

**一句话**：依赖钉版干净、无版本漂移；唯一的硬违例是 `@getpaseo/*`（client/protocol/relay）
三处许可**完全未声明**（package.json 与 lock 里都无 `license` 字段，包内也无 LICENSE 文件）。
被怀疑的 `@earendil-works/pi-telemetry` 经读实现确认**不发任何数据**（纯契约/类型包）。

---

## 2. 工具能力与设计（`scripts/dependency-audit.mjs`）

纯 Node ESM、零依赖、只读。仅读取：根 `package.json`、`package-lock.json`、
`node_modules/<pkg>/package.json`、vendor 的 `package.json` 与 lock。

### 2.1 五项能力与扫描边界

1. **钉版完整性**：遍历根 `package.json` 的 `dependencies` 与 `overrides` 每一项，与
   `package-lock.json` 的 `packages["node_modules/<name>"].version` 比对。缺失 → `missing-in-lock`；
   精确 pin 与解析版本不等 → `version-drift`。范围为区间（range）时只校验存在性（本仓库全部为精确 pin）。
2. **许可清单**：遍历 lock 全部包（121 个，含全部传递依赖）。许可来源优先
   `node_modules/<pkg>/package.json` 的 `license`/`licenses`；该目录不存在时（例如为其他平台准备的
   optional 二进制包）回退读 lock 自带的 `license` 字段，并如实标注 `source`（`node_modules` / `lock` / `unresolved`）。
   按头部 ALLOWLIST 分类：`MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, CC0-1.0, Unlicense, 0BSD, Python-2.0`。
3. **生命周期 scripts**：列出 lock 中每个 `hasInstallScript=true` 的包，或磁盘 package.json 里含
   `preinstall/install/postinstall/prepare` 的包。
4. **遥测面扫描**：**仅对直接依赖**（5 个）的包目录做有界文本扫描。
   - 文件类型：`.js/.mjs/.cjs/.json`；**跳过 `.map`**；单文件 **>512KB 跳过**；识别疑似 minified（超长单行/极少行）跳过。
   - 关键词：`telemetry, analytics, phone-home, posthog, segment, sentry.io, /v1/track, collectMetrics`（大小写不敏感）。
   - **每包最多 10 条命中**，超过则标 `truncated:true` 防爆量。
5. **vendor 摘要**：cezar 根 `package.json` + `packages/*`（实际枚举磁盘目录，并标注是否为声明的 workspace）
   + cezar lock；wechat-acp 的 `package.json`、依赖、lock。

### 2.2 退出码语义

- **1**：`pinDrift` 非空 **或** 许可 `unknown` 非空 → 两类硬违例（版本没锁死 / 许可不明）。
- **0**：其余情况。

`installScripts[]` 与 `telemetryHits[]` **只报告、不失败**。理由已写入脚本头注释：生命周期脚本是 npm 的
正当机制，只是需要人眼复核；关键词命中（例如名为 pi-telemetry 的包里出现字面量 "telemetry"）是**待核线索
而非已证实的数据外发**。让这两类影响退出码会迫使 ALLOWLIST 去编码它表达不了的意图，并让读者对退出码脱敏。

### 2.3 输出

stdout 先打印人类可读分节摘要，随后打印完整 JSON：
`{ ok, generatedAt, root, directDependencies, pinDrift[], licenses{allowlisted[],unknown[]}, installScripts[], telemetryHits[], vendorSummary{cezar,wechatAcp} }`。

---

## 3. 真实运行结果

**退出码：1**（`ok=false`）。人类摘要逐字如下要点：

```
[1] pin integrity: OK — every pinned dependency resolves to its exact version in the lock.
[2] licenses: allowlisted=118  unknown=3
[3] lifecycle install scripts: 9 个包
[4] telemetry keyword scan: chord 10(trunc) / pi-ai 2 / pi-durable 7 / pi-telemetry 10(trunc) / @getpaseo/client 0
[5] vendor: cezar MIT(5 workspaces) ; wechat-acp MIT
RESULT: ok=false — violations: 0 pin drift, 3 unknown license (exit 1)
```

### 3.1 pinDrift：空

`dependencies`（5 项）与 `overrides`（6 项，含未列在 dependencies 的 `@getpaseo/protocol`、
`@getpaseo/relay`）全部精确命中 lock 解析版本，**无漂移、无缺失**。

### 3.2 许可 unknown 清单（3，全部为硬违例来源）

| 包 | 版本 | lock.license | 磁盘 package.json.license | 包内 LICENSE 文件 | 分类 |
| --- | --- | --- | --- | --- | --- |
| `@getpaseo/client` | 0.10.3 | 无 | 无 | 无 | unknown |
| `@getpaseo/protocol` | 0.10.3 | 无 | 无 | 无 | unknown |
| `@getpaseo/relay` | 0.10.3 | 无 | 无 | 无（relay 只有 dist+package.json） | unknown |

其余 118 个包全部在 ALLOWLIST 内，许可值分布：`MIT 68、Apache-2.0 34、BSD-3-Clause 12、
Unlicense 2、ISC 1、0BSD 1`（其中 26 个为 optional 平台包，回退读 lock 许可）。

### 3.3 installScripts 清单（9，报告不失败）

| 包 | 版本 | hasInstallScript | 命中的 hooks |
| --- | --- | --- | --- |
| `@google/genai` | 2.21.0 | true | preinstall, prepare |
| `esbuild` | 0.28.2 | true | postinstall |
| `protobufjs` | 7.6.6 | true | postinstall |
| `gaxios` | 7.3.1 | false | prepare |
| `gcp-metadata` | 8.1.2 | false | prepare |
| `google-auth-library` | 10.9.1 | false | prepare |
| `google-logging-utils` | 1.1.3 | false | prepare |
| `standardwebhooks` | 1.1.1 | false | prepare |
| `web-streams-polyfill` | 3.3.3 | false | prepare |

均为上游发布包的常规构建/补丁脚本（esbuild/protobufjs 的 postinstall 属已知模式）；本仓库
`config/runtime-versions.json` 亦记录 `transitiveAudit: "install-scripts-disabled-and-inventoried; broader-security-audit-pending"`，与本清单一致。

### 3.4 telemetryHits 摘要（4/5 直接依赖命中，全部为假阳性/契约命中）

| 包 | 命中数 | 命中的关键词与位置 | 判读 |
| --- | --- | --- | --- |
| `@earendil-works/chord` | 10（截断） | 全为 `segment`，位于 `dist/delta/*` | 数组/路径遍历变量名 `const segment = path[index]`，与遥测无关 |
| `@earendil-works/pi-durable` | 7 | 全为 `segment`，`harness/events.js`、`testing/storage-benchmark.js` | `prefix.every((segment,index)=>…)` 等，与遥测无关 |
| `@earendil-works/pi-ai` | 2 | `telemetry`：`dist/api/simple-options.js:25`、`package.json:72` | 见 §5，为透传的 `telemetryContext` 选项与依赖声明 |
| `@earendil-works/pi-telemetry` | 10（截断） | 全为 `telemetry`，位于 `dist/index.js`、`dist/memory.js` | 包名/接口名本身，见 §5 |
| `@getpaseo/client` | 0 | — | 关键词零命中（但存在其它网络面，见 §6.3 边界） |

### 3.5 vendor 摘要

- **cezar**（`cezar-monorepo`，`private`，**license = MIT**）：
  - 声明 workspaces 4 个：`@open-mercato/cezar`、`-api-client`、`-contract`、`-web`，均 MIT。
  - 磁盘另有 `packages/desktop`（`@open-mercato/cezar-desktop`，**非**声明 workspace，**license 未声明**）——
    工具如实列出并标注 `declaredWorkspace:false`。
  - `vendor/cezar/package-lock.json`（571 包）`hasInstallScript`：`esbuild`、`fsevents`。
- **wechat-acp**（`wechat-acp@0.10.0`，**license = MIT**）：
  - 依赖：`@agentclientprotocol/sdk`、`@modelcontextprotocol/sdk`、`applicationinsights`、`qrcode-terminal`、`zod`。
  - `vendor/wechat-acp/package-lock.json`（184 包）`hasInstallScript`：`esbuild`、`fsevents`（注意 esbuild 版本 0.28.0，与根 0.28.2 不同实例）。
  - 其依赖中的 **`applicationinsights`（Azure Application Insights APM SDK）是真实的遥测 SDK**，但
    vendor 不在本工具的直接依赖扫描范围内（见 §6.2 边界）。

---

## 4. 直接依赖逐包结论

| 直接依赖 | 版本 | 许可 | install scripts | 遥测命中（实质判读） |
| --- | --- | --- | --- | --- |
| `@earendil-works/pi-durable` | 1.0.4 | MIT | 无 | 7 条 `segment`，全部为变量名，无遥测行为 |
| `@earendil-works/pi-ai` | 1.0.4 | MIT | 无 | 2 条 `telemetry`：一个透传的 `telemetryContext` 选项 + 依赖声明；dist 中**无** `import 'pi-telemetry'` 运行时代码（仅 `types.d.ts` 的 `import type`），即遥测运行时**不会加载** |
| `@earendil-works/chord` | 1.0.4 | MIT | 无 | 10 条 `segment`，全部为数组路径遍历变量名，无遥测行为 |
| `@earendil-works/pi-telemetry` | 1.0.4 | MIT | 无 | 见 §5：纯契约包，不发数据 |
| `@getpaseo/client` | 0.10.3 | **未声明（unknown）** | 无 | 关键词 0 命中；其为 daemon/relay/websocket 传输客户端（本地通信面），非本工具遥测关键词可覆盖 |

---

## 5. pi-telemetry 实际遥测行为（读实现结论，非仅关键词）

任务要求“代码里发不发数据、发到哪里，必须读其实现给出结论”。读完
`node_modules/@earendil-works/pi-telemetry/dist/{index,noop,memory}.js` 与 README：

- 该包**只是契约层**：导出一个回调式 `TelemetryContext`/`TelemetrySpan` 接口、
  一个 `NOOP_TELEMETRY_CONTEXT`（所有方法为空操作）、一个 `InMemoryTelemetryContext`
  参考实现（把 span/属性/事件存进内存数组），以及若干类型工具。**无 exporter、无后端 SDK、无全局 current-span 状态。**
- 对整个 `dist`（含 `.d.ts`）做网络原语扫描（`fetch(`、`http(s).request`、`createConnection`、`net.`、
  `axios`、`XMLHttpRequest`）：**零命中**。README 的 “Security and Portability” 也明确：
  适配器由应用自行提供，本包不绑定任何遥测后端、不使用 `AsyncLocalStorage`。
- 引用关系：仓库代码（`runtime/`、`scripts/`、`control-plane/` 等，排除 node_modules/vendor）**没有任何一处**
  直接 `import` pi-telemetry；`pi-ai` 仅在 `dist/types.d.ts` 里 `import type { TelemetryContext }`（**类型级**），
  `pi-ai/dist` 的运行时代码不 import 它，因此 pi-telemetry 的运行时模块在本项目中**根本不会被加载**。

**结论**：`pi-telemetry` 名字虽含 “telemetry”，但它是**声明式接口 + 内存参考实现**，自身**不发送任何数据、
不指向任何端点**。真正决定是否外发的是应用注入的适配器；本仓库未配置适配器，也未导入该包。故它是
**惰性的遥测契约面**，不构成数据外发通道。

---

## 6. “这不是全面安全证明”的边界声明

1. **不是安全性证明。** 本工具核验的是：版本钉死、许可分类、生命周期脚本清单、直接依赖的关键词线索。
   它**不**核验 CVE/漏洞、混淆或恶意代码、运行期数据流、构建产物与源码一致性、lock 的 `integrity`
   是否与 tarball 真实一致。`config/runtime-versions.json` 记录的 pi 四包 `sourceCommit/integrity`
   是**来源锁定**，同属“锁定而非安全证明”。
2. **扫描范围有限。** 遥测扫描**只覆盖 5 个直接依赖**，不覆盖 100+ 传递依赖，也不覆盖两个 vendor 包
   （cezar、wechat-acp 各有独立 lock，合计 755 个包）。特别地，wechat-acp 声明的
   **`applicationinsights`（Azure APM SDK）是真实遥测 SDK**，本工具未扫描，属**已知未覆盖面**。
3. **关键词扫描有假阴性。** 未命中不等于无遥测：混淆/编码/自定义端点/即便 `@getpaseo/client` 的
   websocket/relay 传输面本工具也覆盖不到；命中也不等于外发。
4. **未安装即未扫描。** 26 个 optional 平台包在本机未落盘，许可取自 lock；其运行期行为不在本机可审计。

---

## 7. 发现的实际问题

1. **【硬违例，退出码 1】`@getpaseo/*` 三处许可完全未声明。**
   `@getpaseo/client`（直接依赖，overrides 钉 0.10.3）、`@getpaseo/protocol`、`@getpaseo/relay`
   的 `package.json`（磁盘与 lock）均无 `license`/`licenses` 字段，包内亦无 LICENSE 文件。
   - 影响：供应链许可合规无法从发布物判定；客户端 SDK 已实际进入运行时（`scripts/runtime-canary.mjs`
     等 `import { createPaseoClient } from "@getpaseo/client"`）。
   - 建议：向 `@getpaseo` 上游确认许可并回填；在本仓库以台账记录来源与判定；如无明确许可，评估替换，
     或在下游选择上收紧（与 `config/runtime-versions.json` 中 paseo `productionEnabled:false` 一致）。
2. **【记录，非违例】cezar `packages/desktop` 许可未声明且非声明 workspace。**
   `@open-mercato/cezar-desktop`（Tauri 桌面端）存在于磁盘但不在根 `workspaces` 列表，且无 `license`。
   vendor 未打包发行为独立产物，风险低，但建议明确其归属（补 workspace 声明或许可）。
3. **【记录，非违例】生命周期脚本 9 处。** 均为上游常规构建/补丁脚本；已知并锁定
   （`config/runtime-versions.json: transitiveAudit` 记录 “install-scripts-...-inventoried”）。
4. **【记录，线索】vendor/wechat-acp 依赖 `applicationinsights`（Azure 遥测 SDK）。**
   属 vendor 边界外的已知未扫描面，建议在 0.3.0 后续审计中单独评估该 bridge 是否实际启用远端上报。

---

## 8. 复现

```bash
npm run audit:deps        # 退出码 1：0 pin drift，3 unknown license
```

回归对照（未受本次改动影响）：

```bash
npm run test:control-plane   # node --test；21 passed / 0 failed，退出码 0
```
