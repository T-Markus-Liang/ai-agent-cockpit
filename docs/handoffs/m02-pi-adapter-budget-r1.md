# 执行交接包：M02 pi-adapter 预算接线（V31 跨 runtime 预算，模块级接线 r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包把 `runtime/budget-policy.mjs`（M02/I03b，r2 已定稿）作为**注入端口**接进 `runtime/pi-adapter.mjs` 的 `submit()` 准入路径。**源码 + 合成测试，不接生产。**

## 批次身份与状态

- batchId / revision：m02-pi-adapter-budget / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行AI / branch / cwd：Kimi Code 会话（执行方）；`feat/0.3.0-progress`；`/Users/markus/ai-agent-cockpit`；主 Agent 定稿设计合同，subagent（deepseek-flash）施工、自跑验证
- 已读并确认协作协议：是。本批**允许写入且实际写入**：
  - **改** `runtime/pi-adapter.mjs`
  - **改** `tests/runtime-ownership.test.mjs`（适配既有构造点 + 新增预算准入用例）
  - **改** `tests/runtime-contract.test.mjs`（既有构造点适配）
  - **改** `tests/runtime-settings.test.mjs`、`tests/runtime-tools.test.mjs`（既有构造点适配，见下「为何超出设计点名的两套」）
  - **改** `scripts/runtime-adapter-canary.mjs`、`scripts/runtime-tools-canary.mjs`（fake 模式构造点适配）
  - **新** `docs/handoffs/m02-pi-adapter-budget-r1.md`（本文件）
  - **未改** `package.json`（复用既有套件脚本，未新增测试脚本行）、`runtime/budget-policy.mjs`、`runtime/contracts.mjs`、`control-plane/goal-store.mjs`，**未碰** `docs/audits/**`、`docs/plans/**`，**未碰** `vendor/cezar/packages/cezar/src/core/secret-redaction.test.ts`（他人未提交改动）
- 对应：M02 跨 runtime 预算接线；验收 **V31**（预算耗尽/到期不能继续副作用、不能续期限、不能假装成功）在**适配器准入层**的落实（模块层见 budget-policy r2）
- 本批目标：把 budget-policy 作为端口接入 submit 准入并要求预算；明确不做：Goal 总预算向 exec/task scope 的**摊派**、token 维度结果路径记账、budget 跨重启持久化、并发 slot、生产/commit/push

## 固定来源（sha256，2026-10-08）

- base HEAD / commit：**未执行任何 git 命令**，故本批无法自证 HEAD；沿用 [m02-budget-policy-r2 交接](m02-budget-policy-r2.md) 记录的基线 `e8c4317` 作参照（不可由本批核实）
- 变更/新增文件（SHA256）：
  - `runtime/pi-adapter.mjs` = `24e563dd57861906345670936a222b76bd182b048c0f6809cd99678b1356821c`
  - `tests/runtime-ownership.test.mjs` = `1b9476bf14d8f56bb4a1d6eeb98e8e9a555541da9a6c9166112fb608f039afa4`（**21 → 35 用例**）
  - `tests/runtime-contract.test.mjs` = `2a930192c94e8138d25ec77603a0cd150e18b5f42ccc2b82d4bf010810b0ba72`（14 用例，仅构造点适配）
  - `tests/runtime-settings.test.mjs` = `3c98d4a84369ef7cfcf9c1c0ce2ba0194cde67640e213fc68f4fe0f89fe67481`（27 用例，仅构造点适配）
  - `tests/runtime-tools.test.mjs` = `1e6d638d5f037c9f50b96a330f3c11ae99b9ff733c32597e93b0cb9fd7ceec5f`（19 用例，仅构造点适配）
  - `scripts/runtime-adapter-canary.mjs` = `be2b5a8445f3d9c8457f2f243c53cdefbfd214c4c78b7a36fb9d0a2ad284ffc0`（仅 fake 模式构造点适配）
  - `scripts/runtime-tools-canary.mjs` = `f27213c66409ca7f8eb19e33d54664ea5eb08bca1ada311dbda29aeac1827c9e`（仅 fake 模式构造点适配）
  - `docs/handoffs/m02-pi-adapter-budget-r1.md`（本文件，hash 见文末主 Agent 报告）
- 只读未改（语义参照）：`runtime/budget-policy.mjs` = `eb2ef936a94bf169d1df268f16db2adcd37f5ce92c9a36ac9a33ede8b08b7a1c`（与 budget-policy r2 交接逐字节一致，**未漂移**）；`runtime/contracts.mjs`；`control-plane/goal-store.mjs`
- `package.json`（未改）= `1018caf317eb07bdac7aeb6a68d6d89c8385044246dd77b2f2a9f7f3024e1d24`
- 依赖 / lock / 运行 bundle：无新依赖、无 lock 变更；纯 ESM，无 network / 无生产 DB / 无 launchd / 无真实用户文件

## 合同逐条落实

### 1. 预算端口与 fail-closed 默认

- `PiRuntimeAdapter.open(owned, { …, budgetPolicy, allowUnbudgeted })` 新增两个构造选项，存入私有字段，`submit()` 准入时使用。
- **fail-closed 默认**：`budgetPolicy` 未配置且未显式 `allowUnbudgeted: true` → `submit()` 拒绝 `ContractRejected("budget-unconfigured")`。`allowUnbudgeted` 是**显式、可 grep 的开发/测试逃生门**（构造时可见选择，非静默默认）；且仅字面量 `true` 生效，非布尔值在构造时拒绝 `invalid-allow-unbudgeted`。
- `budgetPolicy` 构造时校验端口形状（必须暴露 `assertActive` 与 `charge`），形状非法拒绝 `invalid-budget-policy`；校验发生在 `Harness.open` **之前**，非法端口零落库副作用。
- **scopeKey 派生**（`budgetScopeFor(request)`）：有 `executionId` → `exec:<executionId>`；否则有 `productTaskId` → `task:<productTaskId>`；两者皆无 → 拒绝 `ContractRejected("budget-scope-missing")`。Goal 级总预算如何摊到 exec/task scope 是**宿主接线职责**（见未覆盖项）。
- **诚实偏差（需主 Agent 知悉）**：`contracts.mjs` 的 `validateRequest` 把 `executionId` 与 `productTaskId` 同时列为 `REQUIRED_REFERENCES`，因此**经 `submit()` 的合法请求必然解析出 `exec:` scope**，`task:` 分支与 `budget-scope-missing` 分支在当前契约下**不可达**，以**防御纵深**形式保留。为让该守卫可被验证，派生逻辑以纯函数 `budgetScopeFor` 导出，负例直接钉其三路契约（见下 T3、T14）。

### 2. 准入计费语义

- 顺序：`validateRequest`（schema/digest/binding）→ `#assertBudgetAdmission`（`assertActive` 只读检查，不变状态）→ `harness.commit`。**均在任何副作用之前**。
- 仅**新建 admission 分支**在映射落定（`doc.requests[requestKey]` 写毕）后 `charge(scopeKey, { calls: 1 })` 一次。
  - **existing 幂等重用分支不计费**（提前 `return { reused: true }`）。
  - **request-conflict 拒绝不计费**（在 commit 内 conflict 检测处抛 `RequestConflict`，早于 charge）。
- `charge` 为**准入尝试**计数，不是成功计数：后续 Pi 提交失败**不退款**（如实记账，见未覆盖项「charge=尝试的取舍」）。
- **预算拒绝零准入副作用**：`budget-exhausted` / `budget-expired` / `budget-settled` / `unknown-budget` / `clock-invalid` 由 `assertActive` 在 commit 前抛出 → 无 conversation、无映射、无 SDK 调用（负例用真实 Harness 断言 `owners/requests/tasks` 均 0、faux `callCount` 0）。
- **charge 在 commit 内失败** → 异常上抛、事务回滚，**该 admission 不报告成功**（负例 T13 断言零效果）。
- **结果路径（`wait()`/完成）token 记账**：`pi-durable` 的 `submission.wait()` 返回 `SettledSubmissionRecord`（仅 `status`/`entry`/`answer`/`reason`），**不携带 usage/token**；`harness.usage()` 仅会话级聚合，无法可靠归因到单次 scopeKey。故**本批只做 call 维度**，token 记账待接线（见未覆盖项）。

### 3. 不引入第二调度/持久层

- budget-policy 仍是**注入端口**；适配器**不自建预算存储、不做自动 settle/regrant**；不新增调度器/状态机/持久层。仅在 `submit()` 内调用端口的 `assertActive`/`charge`。

### 4. 测试

- 既有套件适配：`openAdapter`/`openAdapterWith`（ownership）、`openAdapter` 与各直接构造点（contract）、settings、tools、两个 canary 脚本的构造点，统一补 `allowUnbudgeted: true`（这些套件主题是 ownership/contract/settings/tools，与预算正交，逃生门是最小且语义不缩水的适配）。**语义零缩水**：既有断言逐条保留，仅新增构造选项。
- **为何超出设计点名的两套**：新增「准入要求预算」为 fail-closed 默认，任何调用 `PiRuntimeAdapter.open(...).submit(...)` 的套件都会被 `budget-unconfigured` 打断。仅适配设计点名的 ownership/contract 会**使 settings(27)/tools(19) 及两个 canary 的 fake 模式整批转红**。为遵守「保持全绿、不回归」，一并做了**每处一行的最小构造点适配**并全跑验证（见「验证」）。若主 Agent 认为 settings/tools/canary 不在本批授权范围，请裁决——但代码层面不适配即回归。
- 新增用例（放 adapter 主套件 `tests/runtime-ownership.test.mjs`，共 14 条，原 21 → 35）。

## 负例原始结果

命令 `node --test tests/runtime-ownership.test.mjs`（仓库根，Node v24.15.0）。新增用例与断言要点：

| # | 用例 | 断言要点 |
| --- | --- | --- |
| T1 | 未配置预算拒绝 | 无 `budgetPolicy` 且无 `allowUnbudgeted` → `budget-unconfigured`；零 owner/request/task/call |
| T2 | 逃生门可用 | `allowUnbudgeted:true`（无端口）→ 正常准入、`wait` done、`callCount` 1 |
| T3 | scope 派生 | `budgetScopeFor`：`exec:` / `task:` / `{}`→`undefined` / `undefined`→`undefined` |
| T4 | 非法端口构造拒绝 | `{}`/半端口/字符串/数字 → `invalid-budget-policy`；`allowUnbudgeted:"yes"` → `invalid-allow-unbudgeted` |
| T5 | unknown scope | 有端口但 scope 未签 → `unknown-budget`；零副作用 |
| T6 | 过期 | 注入时钟越过 `expiresAt` → `budget-expired`；零副作用 |
| T7 | 耗尽 | `maxCalls:1` 已用满 → `budget-exhausted`；零副作用 |
| T8 | 已结算 | `settle` 后 → `budget-settled`；零副作用 |
| T9 | 时钟故障 | 有效签出后注入 `NaN` 时钟 → `clock-invalid`；零副作用 |
| T10 | 有效准入只计 1 次 | `remainingCalls` 5→4、`toJSON().grants[0].chargedCalls===1`、`chargedTokens===0`、`wait` done、`callCount` 1 |
| T11 | 幂等重放不重复计费 | 第二次 `reused:true`、`chargedCalls` 仍 1、`callCount` 1 |
| T12 | conflict 不计费 | 同请求 id 改 body → `request-conflict`、`chargedCalls` 仍 1、`callCount` 1 |
| T13 | charge 失败不谎报成功 | 端口 `assertActive` 通过但 `charge` 抛 → `submit` 拒绝且**零副作用**（事务回滚） |
| T14 | 无 scope 早于准入被拒 | 去掉 `executionId` → schema 先拒 `invalid-request-field`（说明 `budget-scope-missing` 为防御纵深）；零副作用 |

**修复后（本批源码）原始结果**：`tests 35 / pass 35 / fail 0`，exit 0。

**接线前语义还原（反驳实验）**：在自建副本 `/tmp/wireprobe`（rsync 全树、`node_modules` 软链，**未改仓库、未 git**）把 `pi-adapter.mjs` 的 submit 时接线移除（`#assertBudgetAdmission` 调用 → `undefined`；删除 `charge` 行；保留构造期端口校验与纯函数导出）后重跑同一文件：`tests 35 / pass 25 / fail 10`——**10 条准入负例全部失败**，其余 4 条（纯函数/构造期）仍通过。代表报错：`AssertionError [ERR_ASSERTION]: Missing expected rejection.`（T1 `budget-unconfigured` 未发生，即无预算也放行）。证明新增负例**捕获接线缺陷**而非仅正例通过。（`/tmp/wireprobe` 已删除。）

## 验证

| 套件 | 命令 | 结果 |
| --- | --- | --- |
| runtime-ownership | `npm run test:runtime-ownership` | **35/35**，exit 0 |
| runtime-contract | `npm run test:runtime-contract` | **14/14**，exit 0 |
| budget-policy | `npm run test:budget-policy` | **18/18**，exit 0 |
| runtime-canary | `npm run test:runtime-canary` | **9/9**，exit 0 |
| runtime-owner | `npm run test:runtime-owner` | **14/14**，exit 0 |
| runtime-settings（回归） | `node --test tests/runtime-settings.test.mjs` | **27/27**，exit 0 |
| runtime-tools（回归） | `node --test tests/runtime-tools.test.mjs` | **19/19**，exit 0 |

- 真实模型/原文外呼/生产 DB/服务/launchd/微信外发/live 脚本：**均未发生**。全部为合成夹具（真实 `Harness` + 真实 `OwnedStorage` + 公共 faux provider + 注入时钟），无网络、无生产读写、无真实用户文件、未 chmod。
- 失败、部分结果和不明副作用：无。sourceRef 复核：仅上列文件按合同变更；`runtime/budget-policy.mjs`、`contracts.mjs`、`goal-store.mjs`、`package.json` 零漂移；未执行 git。
- 活动进程/job/handle：无（反驳实验副本已删；无遗留进程）。
- 实现完成、自测通过、独立审计、部署/真机：分别为 完成 / 通过 / ⏳ 待审计 / 未做（不合并成「全部完成」）。

## 未覆盖项与诚实边界声明

- **Goal 总预算摊派（宿主接线）**：本层只提供**请求级** scope（`exec:` / `task:`）准入与 call 计费。把某个 Goal 的 `maxTokens/maxDurationMs` 总预算**摊派**到这些 scope、以及多 scope 汇总，属宿主/产品接线职责，**本批未做**。
- **token 维度记账状态**：**未接线，仅 call 维度**。原因：`submission.wait()` 结果不携带 usage（见合同 2），会话级 `usage()` 无法可靠归因到单 scopeKey。待后续接线（需在结果路径按 scopeKey 归因 token，并定义并发归因语义）。
- **budget 跨重启持久化**：**未接线**。`budgetPolicy` 是注入端口，适配器不持久化预算；进程重启后预算状态由宿主负责（端口支持 `toJSON`/`fromJSON` 但本批未在适配器接线）。
- **并发 slot 分离**：**未做**。`maxCalls` 是累计计数，**不是并发限额**；并发活跃数须用独立 slot 计数/调度器释放（与 budget-policy r2 及 [M02-BP-F001 审计](../audits/m02-budget-policy-r1.md) 一致）。
- **charge = 准入尝试的取舍**：`charge` 在映射落定时按「准入尝试」计 1 次 call；**后续 Pi 提交失败（`conversation.submit`/等待失败）不退款**。这是**如实记账**的取舍（宁可多记不可漏记），代价是「尝试」与「成功」不同口径——若产品需要成功口径，需在结果路径补退款/成功计费（本批未做，且 budget-policy 无退 API，「不能续期限」语义亦不允许回退）。
- **V31 不由本批单独关闭**：本批是**模块级接线**。V31 完整关闭仍需：① 生产 Goal/产品路径按 scope 实签预算；② 结果路径 token 记账；③ budget 持久化；④ 并发 slot 分离；⑤ 与 `goal-store` 原 Goal 总预算/期限**同时约束**的联合验证。审计方须按此边界裁决，不得据本批的 35+14 项即判定 V31 关闭。
- **构造点适配超出设计点名范围**（settings/tools/canary）：理由见「合同逐条落实 4」；请主 Agent 裁决是否接受该最小扩展。
- 未执行真实外呼/生产读写/微信外发/服务重启/git commit/push；未改 `package.json`。

## 要求审计方做什么

- 重点复核：① `submit()` 顺序（assertActive 在 commit 前、charge 仅在新建分支）是否彻底零副作用；② 幂等重用/conflict 不计费路径是否确如 T11/T12；③ `charge` 失败事务回滚（T13）是否真回滚；④ `budget-scope-missing` 作为防御纵深 + `budgetScopeFor` 导出的取舍；⑤ 既有 4 套构造点加 `allowUnbudgeted:true` 的语义不缩水；⑥ 未覆盖项（Goal 摊派/token/持久化/slot/V31）是否表述诚实。
- 非返工前请确认：本包未碰审计/计划目录与 `secret-redaction.test.ts`，未执行 git，`package.json` 未改。
