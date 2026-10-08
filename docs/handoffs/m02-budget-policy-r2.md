# 执行交接包：M02/I03b runtime 预算/期限策略模块（r2）+ 时钟异常返工

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包为 r2 revision，逐条回应 [m02-budget-policy-r1 审计](../audits/m02-budget-policy-r1.md)（**CHANGES_REQUESTED**）；r1 失败证据与旧交接文件保留不覆盖。

## 批次身份与状态

- batchId / revision：m02-budget-policy / **r2**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；branch `feat/0.3.0-progress`；cwd `/Users/markus/ai-agent-cockpit`；返工由该会话 subagent（deepseek-flash）完成，主 Agent 定返工设计、亲自复跑
- 已读并确认协作协议：是。本批允许写入且实际写入：`runtime/budget-policy.mjs`、`tests/budget-policy.test.mjs`、`docs/handoffs/m02-budget-policy-r2.md`（新文件）。**未改** `package.json`（仅读取其 `test:budget-policy` script），未改 goal-store/pi-adapter，未新建/覆盖任何证据或旧交接文件
- 对应：M02 / I03b（第三切片）；验收 V31（预算耗尽/到期不能继续副作用、不能续期限、不能假装成功）的接口层 + 审计 Fail-closed 加强
- 本批目标：关闭 BP-F001（时钟异常后仍可使用预算）；明确不做：pi-adapter/goal-store 接线、并发 slot、生产、commit/push

## 固定来源（r2 新 hash）

- base HEAD：`e8c4317`（与 r1 审计同基线；未执行任何 git 命令）
- 变更文件（SHA256，2026-10-08）：
  - `runtime/budget-policy.mjs` `eb2ef936…08b7a1c`（原 r1 `96d15371…9d14a86`）
  - `tests/budget-policy.test.mjs` `5284614b…c2b2b3d`（原 r1 `7bc8eb07…1bcd33a`，**13 → 18 用例**）
  - `package.json` 未改（仍 `96d15371` 同批 script，r1 交接已注明其多批共享、不形成共同冻结版本）
- 完整 sha256：
  - `runtime/budget-policy.mjs` = `eb2ef936a94bf169d1df268f16db2adcd37f5ce92c9a36ac9a33ede8b08b7a1c`
  - `tests/budget-policy.test.mjs` = `5284614bc2c86dd1a0cad69c76f3b3faf25cbec18de4197c9036e2183c2b2b3d`
- 语义参照（只读未改）：`control-plane/goal-store.mjs:13-64,205-216`
- 依赖：无新依赖；纯 ESM、零副作用、注入时钟
- 自测前后 sourceRef 一致（见「验证」）

## Finding 逐条回答

### M02-BP-F001（中 / 阻断 fail-closed：时钟异常后仍可使用预算）→ 每次期限敏感调用前置校验时钟

**修复内容**：新增内部 `readClock()`，在 `grant` / `charge` / `assertActive` / `remaining` **每一次**期限敏感调用、且在**任何状态变动或效果授权之前**读取并校验时钟：

- `clock()` 抛异常 → 捕获，`BudgetError("clock-invalid")`；
- 返回非 `number`（字符串/`null`/`undefined`/布尔等）、非有限（`NaN`/`±Infinity`）、或负数 → `BudgetError("clock-invalid")`。
- `grant` 额外校验派生 `expiresAt`：必须有限、`<= Number.MAX_SAFE_INTEGER`、且严格 `> issuedAt`；否则 `BudgetError("invalid-grant")`，**不落库任何记录**。

**理由**：审计复现的根因是「clock 只验函数类型、不验实际值」——`NaN >= expiresAt` 为 `false`、`-Infinity` 比较为未到期，于是不可核对的期限被读成「仍在有效期内」。屏障放在读取处，比放在比较处（改 `>=` 语义）更彻底：任何派生量（`remainingMs`、到期判定）都建立在可信时钟之上。错误码用**独立的 `clock-invalid`** 而非复用 `budget-expired`，保持模块「错误码精确区分 unknown/settled/expired/exhausted」的既有设计价值，避免把「时钟故障」伪装成「已到期」。

**保持不变**：`unknown-budget`（未知 scope）与 `budget-settled`（已结算）仍在时钟校验**之前**判定，故 r1 的精确错误码不回归；金额/调用计数的确定性校验（`isFiniteNonNegative`、原子扣减）原样保留，未引入任何 Jev/概率判定。

### 关键 diff 摘要（`runtime/budget-policy.mjs`）

1. 新增 `readClock()`（约 L253-273）：try/catch 包裹 `clock()`，`typeof !== "number" || !Number.isFinite || < 0` → `fail("clock-invalid", …)`。
2. `remainders(record)` → `remainders(record, now)`：改为接收**已校验**的瞬时值，不再内部直接 `clock()`；`remainingMs = expiresAt - now`。
3. `grant`：`const issuedAt = readClock();`；新增派生期限溢出守卫（见上），`record.expiresAt` 用该受校验值。
4. `charge`：`settled` 判定后加 `const now = readClock();`，再比 `now >= expiresAt`，末尾 `remainders(record, now)`；原子扣减逻辑未动。
5. `assertActive`：同 `charge`，`now = readClock()` 前置，`remainders(record, now)`。
6. `remaining`：`remainders(requireRecord(scopeKey), readClock())`——纯查询下**也不把不可核对时钟当作可读结果**。
7. `normalizeRecord`：时间窗校验收紧为「`issuedAt` 为数值且 `>= 0`；`expiresAt` 为数值、有限、`<= Number.MAX_SAFE_INTEGER`、`> issuedAt`」（快照侧同类硬化）。
8. 头部契约注释同步更新（新增 clock 校验 bullet、`charge/assertActive/remaining` 的 `clock-invalid`、`fromJSON` 时间窗越界）。

## 反向负例清单与原始结果摘要

在 `tests/budget-policy.test.mjs` 追加 5 条固定负例（14–18），把审计复现路径固化。运行命令 `npm run test:budget-policy`（仓库根，Node v24.15.0）。

| # | 负例 | 断言要点 |
| --- | --- | --- |
| 14 | 有效 grant 后注入故障时钟零移动 | 审计复现：正常 clock=100 签出有效期(expiresAt=1100) budget 后，注入 `NaN/Infinity/-Infinity/-1/"100"/undefined/null/true` 及**抛异常** clock；`assertActive`/`charge`/`remaining` 均 `clock-invalid`，`toJSON()` 与故障前**逐字段相等**；恢复 clock=100 后行为与原始一致 |
| 15 | grant 时异常时钟 + expiresAt 溢出无记录 | 上述各故障值下 `grant` → `clock-invalid`，且 `remaining` → `unknown-budget`（未落库）；正常 clock 但 `maxDurationMs=Number.MAX_SAFE_INTEGER` 使派生 expiresAt 超安全整数 → `invalid-grant`，仍无记录；边界 `clock=0 + MAX_SAFE_INTEGER = MAX_SAFE_INTEGER` 允许 |
| 16 | 边界到期 + 故障非「到期」 | clock=5999 未到期(remainingMs=1)；clock=6000（===expiresAt）→ `budget-expired`；故障 clock=NaN → `clock-invalid`（非误报 expired/active）且零移动；恢复后冻结数字仍可审计 |
| 17 | 快照时间窗越界拒绝 | `fromJSON` 对 `issuedAt=-1`、`issuedAt="1000"`、`expiresAt=MAX_SAFE_INTEGER+1`、`expiresAt=Infinity` 均 `invalid-state` |
| 18 | 恢复后同样 fail-closed | 快照恢复后：正常 clock 与源 remainder/charge 逐项一致；恢复后注入 NaN → `charge/assertActive` 均 `clock-invalid`、零移动；重开正常 clock 后可用且一致 |

**修复后（本批源码）原始结果**：`tests 18 / pass 18 / fail 0`，exit 0。

**修复前（r1 语义）还原**：在自建 tmp 副本 `/tmp/bprepro`（自建合成夹具，本进程内构造，未改仓库、未 git）将 clock 值校验、grant 溢出守卫、`normalizeRecord` 时间窗三项**逆向还原为 r1 行为**后重跑同一测试：`tests 18 / pass 13 / fail 5`——**5 条新负例全部失败**，其中 #14 报 `AssertionError: Missing expected exception: expected BudgetError("clock-invalid")`，即 `assertActive` 在 NaN 时钟下**返回成功**（审计 `policy-probes.mjs` 观测 `activeAfterClockBroke:true / chargeAccepted:true / callsCharged:1` 被复现，随后被本修复反驳）。结论：负例确实捕获缺陷，而非仅正例通过。

## 验证

| 套件 | 结果 |
| --- | --- |
| test:budget-policy（`node --test tests/budget-policy.test.mjs`） | **18/18**，exit 0 |

- 原 r1 的 13 条正例**零回归**（逐条 pass）。
- 真实模型/原文外呼/生产 DB/服务/launchd/微信外发：**均未发生**。测试为纯模块合成夹具，时钟为注入函数；未 chmod、未修改任何真实用户文件。
- 失败、部分结果和不明副作用：无。sourceRef 复核：仅上列 2 个源文件按审计授权变更，`package.json` 及既有冻结文件零漂移。
- 活动进程/job/handle：无（返工前置还原测试在本进程内完成，无遗留进程）。
- 独立审计：⏳ 待审计 AI；部署/真机：未做。

## 要求审计方做什么

- 按 Finding ID 复核 r2 diff / 新 hash / 负例与还原结果；重点：① `readClock` 覆盖四点是否彻底，是否仍存在绕过路径；② `clock-invalid` 作为新错误码是否被接受（vs 复用 `budget-expired`）；③ grant 派生期限溢出边界（`<= MAX_SAFE_INTEGER` 的取舍）；④ `remaining` 在时钟故障时拒绝的**扩展**是否接受（见下）。
- 非返工前请确认：本包未触碰 `package.json`，V31 关闭仍需 P2 接线（见下）。

## 未覆盖项与诚实边界声明

- **仅纯模块**：未做 pi-adapter/goal-store 接线；本层是**请求预算元数据**，不是 Grant 授权系统或并发 slot。
- **`remaining` 行为变更（扩展，需审计裁决）**：审计原文点名 `grant/check/charge/assertActive`；本批将同一屏障也加在 `remaining`（纯查询）上，理由是不可核对的时钟会让 `remainingMs` 退化为 `NaN` 这类「无意义剩余期限」。代价：时钟故障时无法再读出冻结的 token/call 计数。若审计认为查询路径应保持只读可读，可退回只校验三入口——请裁决。
- **`clock-invalid` 是新增错误码**：既有消费方（尚未接线）需按新码处理，未在本批接线验证。
- **settle 重签语义未变**：settle 后再 grant 仍须宿主确认新授权周期，不等于自动续原 Goal；并发活跃数仍须独立 slot 计数/原调度器释放，不把累计 maxCalls 当并发限额（均超出本批范围）。
- **V31 不能仅靠这 13(+5) 项关闭**：P2 接线后须验证原 Goal 总预算/期限与本层**同时约束**。
- 未执行真实外呼/生产读写/微信外发/服务重启/git commit/push；未修改 package.json。
