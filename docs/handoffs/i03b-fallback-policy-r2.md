# 执行交接包：I03b provider fallback 策略模块（r2，按审计 Finding 返工）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。

回应 [i03b-fallback-policy-r1 审计报告](../audits/i03b-fallback-policy-r1.md)（CHANGES_REQUESTED，两项 Finding：I03b-FB-F001 高/阻断、I03b-FB-F002 中/阻断）。**r1 交接包、r1 审计报告与 r3 原始证据全部保留、未覆盖**；本包为新 revision r2。

## 批次身份与状态

- batchId / revision：i03b-fallback-policy / **r2**；状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；branch `feat/0.3.0-progress`；cwd `/Users/markus/ai-agent-cockpit`；返工由 subagent（deepseek-flash）完成，主 Agent 定返工合同、亲自复跑
- 已读并确认协作协议：是。本批写入：`runtime/fallback-policy.mjs`、`tests/fallback-policy.test.mjs`、本交接包；`package.json` **未改**（无需新脚本，复用 `test:fallback-policy`）；`vendor/`、真实用户文件、生产 DB/服务/launchd 均未触碰
- 对应：I03b（第四切片）验收 V39（有界 fallback、保留上下文来源、不换引擎重放）+ V38（auth 不重试风暴）的接口层
- 返工范围仅此两 Finding；`MAX_AUTOMATIC_ATTEMPTS`、`reset`、`decisions`、`toJSON/fromJSON`、secret 卫生等 r1 已认可语义不变

## 固定来源

- base HEAD：`e8c4317`（同 r1，未提交工作树）；本批不执行任何 git 操作
- 本批文件（SHA256，2026-10-08 冻结）：
  - `runtime/fallback-policy.mjs`（修改）`fb01ca668a72156f0fac5d0f8756645aabc83894422fdecd6517f39c94bb7934`（r1 为 `f8a17519…08e6af`）
  - `tests/fallback-policy.test.mjs`（修改，12 → 18 用例）`88e8a48cadb94a81aa00b54915a28c2be83683007e364802495f2c5fa4f0b14f`（r1 为 `b113e8ae…645000`）
  - `package.json`（未改）`b46f4bc95650da0b217ede96cc6b5733acab9ceb0ec5666c2a35c31da5818aaf`（与 r1 一致，证明未动）
- 规则参照（只读未改）：`vendor/wechat-acp/src/acp/session.ts:1034-1068,1374-1412`
- 依赖：无新依赖；纯 ESM、零依赖、无副作用（无 I/O、无网络、无定时器、无环境读取、无凭据）
- 自测前后 sourceRef 一致（测试运行不改源文件）

## Finding 逐条处置

### I03b-FB-F001（高/阻断）错误种类绕过副作用屏障 → 已修复

- **问题**：r1 仅对 `timeout` 检查 `hasProducedMessage`/`hasUsedTools` 严格 `false`；`startup_error`/`protocol_error`/`rate_limit` 不看标记即 eligible。审计复现：三 kind 带两标记 `true` 仍给 fallback；缺两标记的 `protocol_error` 也 eligible。
- **修复内容**：把副作用/不明状态屏障**统一前置到所有可降级 kind**，改为与 kind 无关的单一判据——只有宿主显式证明未执行（`hasProducedMessage === false` 且 `hasUsedTools === false`）才 eligible；缺失/`undefined`/其它任意非严格 `false` 值（含 `0`/`null`/`"false"`）一律视为 unknown → 拒绝。任何可降级 kind（含 `protocol_error`/`rate_limit`）在工具轮次中同名发生都会被同一屏障拦下，不再靠 kind 推断“干净”。`auth_error` 恒拒（不换引擎绕过）；未识别 kind 恒拒。
- **理由**：`kind` 只描述错误类别，不能证明副作用为零；同名错误可能发生于多轮 tool 过程，故屏障必须独立于 kind。拒绝即“如实停止”，不抛错、不消耗自动尝试、不产生 candidate 或请求效果。
- **新增/变更 reason**：`startup_error`/`protocol_error`/`rate_limit` 未经证明干净 → `unclean-side-effects`（新增统一 reason）；`timeout` 未经证明干净 → 保留 `timeout-dirty`；干净可降级 reason 不变（`startup-failure`/`protocol-failure`/`rate-limited`/`timeout-clean`）。

关键 diff 摘要（`classify`）：

```js
// r1：         startup_error / protocol_error / rate_limit 直接 eligible，不看标记
// r2：统一屏障
const DEGRADABLE_KINDS = new Map([
  ["startup_error", "startup-failure"], ["timeout", "timeout-clean"],
  ["protocol_error", "protocol-failure"], ["rate_limit", "rate-limited"],
]);
function classify(kind, hasProducedMessage, hasUsedTools) {
  if (kind === "auth_error") return { eligible: false, reason: "auth-failure" };
  const cleanReason = DEGRADABLE_KINDS.get(kind);
  if (cleanReason === undefined) return { eligible: false, reason: "uncertain-side-effects" };
  if (hasProducedMessage !== false || hasUsedTools !== false) {
    return { eligible: false, reason: kind === "timeout" ? "timeout-dirty" : "unclean-side-effects" };
  }
  return { eligible: true, reason: cleanReason };
}
```

### I03b-FB-F002（中/阻断）克隆/冻结不完整 → 已修复

- **问题**：r1 用宽松 `isPlainObject`（接受 `Date`/`Map` 等任何非空非数组对象），枚举 own keys 后 `Date` 静默变 `{}`；`cloneData` 只对原始值拒 function/symbol/bigint，数组用 `map`（保留空洞）、用 `copy[key] = …` 赋值（`__proto__` 原型污染风险）；结果只 `Object.freeze` 顶层 + marker，`turns[0].text` 可改。审计复现：`sourceTime: Date(1234)` 输出 `{}` 不报错；`turns[0]` 可改。
- **修复内容**：
  1. **严格拒非 JSON 类型**：新增 `isPlainJsonObject`（原型必须是 `Object.prototype` 或 `null`）用于上下文克隆；`cloneData` 现拒绝 `Date`/`Map`/`Set`/自定义原型、`undefined`、`NaN`/`Infinity`/`-Infinity`、`function`/`symbol`/`bigint`——出现即 `FallbackError("invalid-state")`，**不静默删字段**。
  2. **特殊键防护**：`__proto__`/`constructor`/`prototype` 为保留键，出现即拒；克隆改用 `Object.defineProperty`（不再用赋值），杜绝原型污染。
  3. **无静默丢弃**：拒绝 symbol 键属性、非枚举 own 属性、稀疏数组/带非索引属性的数组。
  4. **深克隆 + 深冻结整个输出**：`buildFallbackContext` 顶层改用 `isPlainJsonObject`，输出改为 `deepFreeze(copy)`（整图冻结，含 `turns[0]`、嵌套对象、数组元素），marker 亦冻结；异步候选切换间输出不可漂移；输入永不被修改。

关键 diff 摘要（`cloneData` / `buildFallbackContext`）：

```js
// r1： if (!isPlainObject(value)) fail(...);  ... map(...);  copy[key] = cloneData(...)
// r2：
if (type === "number" && !Number.isFinite(value)) fail(code, `... non-finite number ...`);
if (type === "undefined") fail(code, `... undefined ...`);
if (typeof value === "object") { // 拒 symbol 键 / 非枚举 / 稀疏数组 / 非plain / 保留键
  if (Object.getOwnPropertySymbols(value).length > 0) fail(code, "... symbol-keyed ...");
  if (Array.isArray(value) && Object.getOwnPropertyNames(value).length !== value.length + 1) fail(code, "... sparse ...");
  if (!isPlainJsonObject(value)) fail(code, "... non-plain object ...");
  if (Object.getOwnPropertyNames(value).length !== Object.keys(value).length) fail(code, "... non-enumerable ...");
  for (const key of Object.keys(value)) {
    if (RESERVED_KEYS.has(key)) fail(code, `... reserved key ...`);
    Object.defineProperty(copy, key, { value: cloneData(value[key], ...), enumerable: true, writable: true, configurable: true });
  }
}
// buildFallbackContext r2：
if (!isPlainJsonObject(originalContext)) fail("invalid-state", "originalContext must be a plain JSON object");
const copy = cloneData(originalContext, "originalContext", "invalid-state");
copy.fallback = Object.freeze({ from: fromRef, to: toRef, attempt, at: clock() });
return deepFreeze(copy);   // r1 为 return Object.freeze(copy);
```

- **理由**：上下文合同声明的输入是 JSON，`Date` 等不在合同内，应拒绝而非静默变形；冻结必须覆盖整图，否则溯源 marker 生成后嵌套内容仍可改，破坏“同一快照不可漂移”。

## 反向负例清单与原始结果摘要

新增用例（`tests/fallback-policy.test.mjs` 13–18，隔离合成，无网络/文件/真实 provider）：

- **13. 屏障矩阵**：4 个可降级 kind × {两标记 `false` 干净、msg `true`、tools `true`、两 `true`、两缺失、`undefined`、只给一个、`0`/`0`、`null`/`null`、`"false"`/`"false"`}。断言仅严格干净 eligible；其余全部 `stop`（`timeout-dirty` / `unclean-side-effects`），无 candidate，且 `toJSON().scopes.length === 0`（脏路径不消耗尝试预算）。
- **14. 审计复现翻转**：`{protocol_error|rate_limit|startup_error, hasProducedMessage:true, hasUsedTools:true}` → 全部 `eligible:false` / `stop` / `unclean-side-effects`（**原审计复现由 fallback 翻转为拒绝**）；缺两标记的 `protocol_error` 同样拒绝。
- **15. auth 与 multi-turn/unknown**：`auth_error` 在干净/缺失/脏三种标记下均 `auth-failure`；`mid_generation_failure`/`unknown`/`some_future_kind` **即使两标记为 `false`** 仍 `uncertain-side-effects`（结果可能处于多轮 tool 过程，标记不能救回）；全程无尝试消耗。
- **16. 非 JSON 值拒绝**：`Date`/`Map`/`Set`/自定义原型/`undefined`/`NaN`/`Infinity`/`-Infinity`/`function`/`symbol`/`bigint`，分别嵌套于对象与数组 → 均 `invalid-state`；`sourceTime: Date(1234)`（r1 复现）→ 拒绝；非 plain 顶层 → 拒绝。
- **17. 保留键/符号/非枚举/稀疏**：`__proto__`/`constructor`/`prototype`（经 `JSON.parse` 得到 own 键）、symbol 键属性、非枚举 own 属性、稀疏数组 → 均 `invalid-state`；断言 `Object.prototype.polluted === undefined`（无原型污染）。
- **18. 深克隆+深冻结+输入不变**：正常 JSON 全字段与来源保持；输出顶层/`turns`/`turns[0]`/嵌套对象/数组/数组元素全部 `Object.isFrozen`；改 `context.turns[0].text` 与 `push` 抛 `TypeError`；构建输出后 `JSON.stringify(输入)` 不变（输入未被修改）；再改输入不影响已冻结输出；`Object.create(null)` 合法 plain 对象被接受。

原 12 用例：**正例语义不回归**（仅因更严格合同，把可降级调用点补上 `hasProducedMessage:false, hasUsedTools:false`；断言值不变）。涉及用例 2/5/7/8/10/11/12（共 20 个调用点）。用例 3（干净 timeout 仍 eligible、脏 timeout 仍 `timeout-dirty`）、4（auth 拒）、6（unknown 拒）逐字未改。用例 9（全字段保持 + 拒绝已有 `fallback` 键）未改，仍通过。

命令与结果（仓库根）：

- `npm run test:fallback-policy` → **18/18 pass，fail 0，exit 0**（r1 为 12/12）
- 相邻回归：`npm run test:budget-policy` 13/13、`npm run test:provider-resolver` 12/12、`npm run test:context-assembler` 9/9，均 fail 0
- 隔离复现探针（`/tmp/personal-ai-os-fb-r2/probe.mjs`，指向固定 hash 修复版，非仓库工件）：`{"dirty-failure-still-falls-back":{"cases":[{"kind":"protocol_error","eligible":false,"action":"stop","reason":"unclean-side-effects"},{"kind":"rate_limit",…},{"kind":"startup_error",…}],"missingProtocolFlagsEligible":false},"fallback-context-clone":{"unsupportedDateRejected":true,"nestedCopyFrozen":true,"originalNotMutated":true}}`——与 r1 审计探针结论相反，证明两 Finding 场景已被拒绝/安全。

## 实现、自测与证据

| 要求/Case（V39/V38） | 当前实现 | 验证命令与 cwd | 退出码/断言/效果 | evidenceRef | 尚未覆盖 |
| --- | --- | --- | --- | --- | --- |
| FB-F001 副作用屏障统一 | 所有可降级 kind 前置“两标记严格 `false`”屏障；脏/未知 → `stop`（`unclean-side-effects`/`timeout-dirty`），不产 candidate | `npm run test:fallback-policy`（仓库根） | 用例 13/14/15 通过，18/18 exit 0 | 本文件 | 宿主侧真实 effect 账本/Request/Grant/期限绑定（接线层，见下） |
| FB-F002 严格 JSON + 深冻结 | 非 JSON 拒、保留键防污染、深克隆+深冻结整图、输入不改 | 同上 | 用例 16/17/18 通过 | 本文件 | 与 context-assembler 的真实接线 |
| 有界 fallback | MAX_AUTOMATIC_ATTEMPTS=1；第二次 → `fallback-exhausted`；reset 清周期 | 同上 | 用例 7/8 通过（未改） | 本文件 | 多级链 >1 候选预算语义 |
| auth 不重试（V38） | `auth_error` 恒 `auth-failure`，不消耗尝试、不猜凭据 | 同上 | 用例 4/15 通过 | 本文件 | — |
| 上下文来源保持 | 深克隆全字段 + `fallback` 溯源标记；已有 `fallback` 键 → 拒绝 | 同上 | 用例 9/18 通过 | 本文件 | — |
| 决策日志无秘密 + 快照往返 | 仅 ref/reason；`toJSON/fromJSON` 全验证 | 同上 | 用例 10/11/12 通过 | 本文件 | — |

- 真实模型/原文外呼/生产读写/原生会话/微信外发：**均未发生**；纯离线合成（临时 `now` 注入时钟）。
- 失败、部分结果和不明副作用：无。返工全部 fail-closed。
- 活动进程/job/handle：无。
- 数据守恒、回退和恢复方法：回退即把两文件还原到 r1（`f8a17519…` / `b113e8ae…`）；模块纯策略、无数据面。
- 状态分列：实现完成 ✅（本批范围）；自测通过 ✅（主 Agent 亲自复跑）；独立审计：⏳ 待审计 AI 复核 r2；部署/真机：未做。

## 要求审计方做什么

- 审计范围与重点：`runtime/fallback-policy.mjs`（`fb01ca66…bb7934`）与 `tests/fallback-policy.test.mjs`（`88e8a48c…0b14f`）。建议重点：① 屏障对“干净”的定义是否与 V39/桥侧 `session.ts:1400`（`!hasProducedMessage && !hasUsedTools`）语义一致；② 新增 `unclean-side-effects` reason 与 `timeout-dirty` 并存是否可接受；③ 严格 JSON 判据是否有误拒的正常宿主上下文；④ 深冻结是否覆盖全部输出路径。
- 已知不足/需决定的方案（与 r1 相同，未在本批处理）：多候选链（>2）预算语义；fallback 与 provider-resolver 的 `credentialRef` 联动；桥侧持久会话 id 永不跨 harness 恢复在接线层的表达。
- 等待期间将继续的无冲突独立任务：I02 剩余两项（活跃原生会话隐私重置、质量 UI）设计提案。
- 返工 revision：两 Finding 均已“已修 + 补负例”，无“拒绝修复”或“待决”项。

## 未覆盖项与诚实边界（不夸大）

- **“原预算与原上下文有效”**：本模块是**纯策略**，不持有请求/Grant/期限/效果账本。模块自身的“预算”是 `MAX_AUTOMATIC_ATTEMPTS=1`（未变），被拒路径不消耗；上下文有效性由 `buildFallbackContext` 的严格校验保证。审计全局注记要求的“宿主绑定原 request/Grant/期限/效果账本、不让模型 reset 或换 request ID 重放 unknown”属**接线层**职责，**本批未实现、未声称实现**。
- 严格 JSON 规则施加于**上下文克隆输出**（Finding 2 范围）；链候选/失败对象/决策记录的形状仍沿用各自的字段级校验（`isPlainObject` 宽松判定），本批未改其语义。
- 库尚未接入生产（`runtime/` 无消费者）；本批仅策略与测试，未做与 pi-adapter/桥侧/context-assembler 的真实接线。
- V38/V39 与真实 Kimi 等候选认证/联合上下文仍待验；`npm run test:fallback-policy` 的通过数是**合成负数**证据，不等于生产安全或已上线。
- 未执行任何 git 命令、未改 `package.json`、未触碰真实用户文件/生产 DB/服务/launchd、未真实外呼网络/模型/微信。
