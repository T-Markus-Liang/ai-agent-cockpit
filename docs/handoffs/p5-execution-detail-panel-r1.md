# 执行交接包：P5 / Wave 4 首片 —— 驾驶舱 Execution 列表/详情 + completion-plan 面板（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双 AI 协作协议](../plans/0.3.0-collaboration.md)。本包落实主 Agent 定稿的设计合同：在 Personal AI OS 驾驶舱的控制面 Task 卡片里补上 **Execution 列表/详情 + Evidence 展开 + completion-plan 面板**（P5/B04）。纯前端只读，mock fetch 单测覆盖。r1 交接为新建文件，不覆盖任何旧交接包。

## 批次身份与状态

- batchId / revision：p5-execution-detail-panel / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行 AI：Kimi Code 会话（执行方，subagent deepseek-flash 实现）；branch `feat/0.3.0-progress`；cwd `/Users/markus/ai-agent-cockpit`；宿主工作区 `vendor/cezar/packages/web`
- 已读并确认协作协议：是。**本批允许写入且实际写入**：
  - `vendor/cezar/packages/web/src/routes/dashboard/control-plane-executions.tsx`（**新增**）
  - `vendor/cezar/packages/web/src/routes/dashboard/control-plane-tasks.tsx`（修改：加选中态 + 挂载详情）
  - `vendor/cezar/packages/web/src/routes/dashboard/control-plane-dashboard.test.tsx`（修改：新增用例）
  - `docs/handoffs/p5-execution-detail-panel-r1.md`（本文件，新增）
- **未改**：仓库根 `package.json`、`vendor/cezar/package.json`、`vendor/cezar/packages/web/package.json`、`docs/audits/**`、`docs/plans/**`、任何服务端/生产文件。**未执行任何 `git` 命令**。**未新增任何依赖**（复用既有 `@tanstack/react-query`、`lucide-react`、shadcn `Button`、`StatusDot`、`Pill`）。
- 对应：P5/B04 首片。明确不做：真实完成（`POST /complete`）、任何写操作、i18n 统一、真机/真浏览器验收、生产重启/部署。
- vendor 说明：`vendor/cezar/` 有自己的 `AGENTS.md`，**已读并遵守**：React 19 + Vite + Tailwind v4 + shadcn、TanStack Query、vitest **经 npm 跑（不 `npx`）**、保持主题与既有测试惯例。

## 固定来源

- base HEAD：`526d09727b59f0a7baefd6d60b7f009dc72438ef`（读 `.git/HEAD` → `ref: refs/heads/feat/0.3.0-progress`，再读 `.git/refs/heads/feat/0.3.0-progress` 得到；**未执行任何 git 命令**）
- 变更文件（SHA256，2026-10-08）：
  - `vendor/cezar/packages/web/src/routes/dashboard/control-plane-executions.tsx` `5b9d865f25d7aa8fe857b541ccd0594d48ca601217b8efd08286a56c7dbd4962`（**新增**，164 行）
  - `vendor/cezar/packages/web/src/routes/dashboard/control-plane-tasks.tsx` `ffe3b64a40a93c7f78982d3c19ccbb3ebcdd210cc873c4a6e2599adc3eda667c`（31 行 → **43 行**）
  - `vendor/cezar/packages/web/src/routes/dashboard/control-plane-dashboard.test.tsx` `8ebb5b3362351baf8ce42e905ff53206af4c93ef7a0fee86662631fc952e714b`（46 行 → **178 行**；用例 **2 → 11**）
- 数据源契约（只读，未改）：
  - `gateway/control-plane.mjs:160` — `GET /api/control-plane/tasks/:id` → `store.getTask(taskId)`
  - `gateway/control-plane.mjs:161-162` — `GET /api/control-plane/tasks/:id/completion-plan` → `store.completionPlan(taskId)`
  - `control-plane/store.mjs:335-345` — `getTask` 返回 `{ task, executions, evidence }`
  - `control-plane/store.mjs:242-291 / 347-350` — `#completionPlanState` / `completionPlan`，返回 `{ action, target, parameters, parametersDigest, ready, reasons }`（`reasons` 已是中文）
  - `control-plane/contracts.mjs:19-27` — `EXECUTION_STATUSES`（八态）；`:178` — `createEvidence` 的 `kind` 枚举
- 依赖：无新依赖

## Finding 逐条回答 / 合同逐条

**(1) Execution 列表/详情（新增 `control-plane-executions.tsx`，挂载于 `control-plane-tasks.tsx`）**
- 宿主页面新增**选中态** `selectedId`：每条 Task 行由 `<div>` 改为 `<button type="button" aria-expanded=… aria-label="展开/收起任务 <id> 的执行详情">`；点击该行即拉取并渲染该 Task 的详情，再点收起。**默认不选中**（不自动拉取，保持既有首屏行为与既有断言不变）。仅渲染 `tasks.slice(0,5)` 的 5 条，故只有这 5 条可被选中。
- 详情组件 `ControlPlaneTaskDetail({ taskId })` 用两个独立 `useQuery`（`refetchInterval: 10_000`、`retry: false`，与 `control-plane-approvals.tsx` 同范式）直连：
  - `GET /api/control-plane/tasks/:id` → 渲染 Execution 列表。
  - `GET /api/control-plane/tasks/:id/completion-plan` → 渲染完成条件面板。
- 每条 Execution 显示：`workerId`、状态八态中文标签 + 色彩语义（**色在小圆点、字保持中性**，遵循设计系统单一着色载体约定，用 `Pill` + `StatusDot`）、`attempt`（`第 N 次`）、`artifactRef`（有则截断 24 字符显示，`title` 挂全量）、`parentExecutionId`（有则标注 `复核子执行 · 父执行 <id12>`，即 review 子执行）。八态映射：

  | 状态 | 中文 | 点色 | pulse |
  | --- | --- | --- | --- |
  | queued | 排队中 | pending | 否 |
  | running | 执行中 | pending | 是 |
  | verifying | 验证中 | pending | 是 |
  | reviewing | 复核中 | violet | 是 |
  | succeeded | 已成功 | success | 否 |
  | failed | 失败 | danger | 否 |
  | blocked | 已阻塞 | danger | 否 |
  | cancelled | 已取消 | neutral | 否 |

- 每条 Execution 有「证据 N」按钮（`aria-expanded` + `aria-label="展开/收起执行 <id> 的证据"`），展开后按 `executionId` 过滤展示该执行的 Evidence 列表：`kind` 中文标签、`exitCode`（有则显示 `退出码 N`）、`verdict`（`通过`/`失败`，带 success/danger 点）、`summary`（截断 160 字符）、`capturedAt`（`YYYY-MM-DD HH:MM:SS`）。**Evidence kind 以 `control-plane/contracts.mjs:178` 实际枚举为准，是 7 类**（`command` 命令 / `test` 测试 / `diff` 差异 / `log` 日志 / `screenshot` 截图 / `review` 复核 / `message` 消息），非任务描述里写的“六类”——本批按 7 类全量映射，未知 kind 回退显示原值。
- **全部只读**；无任何写接口调用。

**(2) completion-plan 面板**
- `ready === false`：标题「尚不满足完成条件：」，`reasons[]` **逐条原样中文呈现**（缺终态 / 缺 succeeded root worker / 缺 artifactRef / 缺 exitCode=0 且 artifactRef 匹配的 test|command / 仍有失败验证 / 缺独立 review 等，均由 gateway 给出）。`reasons` 为空但 `ready=false`（防御）时回退文案「控制面未给出具体原因，请查看该任务的执行记录。」
- `ready === true`：**只陈述**「满足固定验收条件：全部 Execution 已进入终态，存在 succeeded 的 root worker，且 artifactRef 与独立 review 证据齐备。完成操作需另行审批，本页不会触发。」**不加任何完成 CTA**（本批不做 `POST /complete`）。
- `parametersDigest` 截断 32 字符显示（`title` 挂全量）。
- 不可完成时**绝不显示任何“可通过”的假暗示**。

**(3) 中文与 aria**
- 页面文案**硬编码中文**，风格与 `continuous-goals.tsx` 一致（该文件亦硬编码中文）。i18n 统一（把新串迁入 `locale-provider.tsx` 的 `TRANSLATIONS`）留作**后续独立步骤**（见“未覆盖项”）。
- aria：Task 行选中按钮 `aria-expanded` + `aria-label`（展开/收起）；Execution 证据按钮 `aria-expanded` + `aria-label`；状态 badge `aria-label="执行状态：<中文>"`（`Pill`），verdict 点 `role="img" aria-label="判定：通过/失败"`；两个面板 landmark `<section role="region" aria-label="Execution 列表">` 与 `aria-label="完成验收条件"`；证据列表 `<ul aria-label="证据列表">`、未满足条件 `<ul aria-label="未满足的完成条件">`。装饰性图标均 `aria-hidden="true"`。

**(4) 诚实三态**
- 详情拉取失败（reject / 非 2xx）：显示「控制面暂不可达，无法读取该任务的执行详情」+「重试」按钮（`query.refetch()`），**无任何编造数据**。
- completion-plan 拉取失败：显示「完成条件暂不可达，无法判断该任务是否可以完成」+「重试」，**不会谎报 ready**。
- 空 `executions` → 「该任务暂无 Execution。」；某 Execution 无 Evidence → 「该执行暂无证据。」

## 关键 diff 摘要

1. **新增** `control-plane-executions.tsx`（164 行）：只读详情面板。常量 `API = 'http://127.0.0.1:4324/api/control-plane'`（与既有 control-plane-* 组件同源）；两个读取函数 `readTaskDetail` / `readCompletionPlan`（`cache: 'no-store'`，非 2xx 抛错）；`EXECUTION_STATUS_LABELS` / `EXECUTION_STATUS_TONES` / `EVIDENCE_KIND_LABELS` 三张映射表（8 态 / 7 kind）；`truncate`/`shortId`/`stamp` 三个纯函数；子组件 `ExecutionStatusBadge` / `EvidenceRow` / `ExecutionRow`；导出 `ControlPlaneTaskDetail`。未引入任何第三方新依赖。
2. `control-plane-tasks.tsx`（31 → 43 行）：`import { useState }`、`import { ControlPlaneTaskDetail }`；`ControlPlaneTasks` 内加 `const [selectedId, setSelectedId] = useState<string | null>(null)`；Task 行 `div` → `button`（`aria-expanded` / `aria-label` / `onClick` 切换选中），选中时渲染 `<ControlPlaneTaskDetail taskId={task.id} />`。**头部、加载/错误/空态、`slice(0,5)`、`STATUS_LABELS` 均逐字未改。**

## 测试与验证（原始结果）

测试全部为 **vitest jsdom + 全局 mock `fetch`**（模式学 `control-plane-dashboard.test.tsx` / `continuous-goals.test.tsx`）：**未起任何真实服务、未外呼真实网络、未执行写操作、未连 127.0.0.1:4324**。`stubFetch()` 用正则 `/\/api\/control-plane\/tasks\/[^/?]+$/` 区分列表与详情，并对详情/完成条件分别可注入 `dStatus`/`planStatus`/`plan`/`executions`。

新增/改写用例（`control-plane-dashboard.test.tsx`，共 11 条）：

| 用例 | 覆盖合同 | 结果 |
| --- | --- | --- |
| renders live control-plane task state（原用例保留） | 回归：既有 Task 列表 | ✅ |
| renders pending approval and sends a decision through the API（原用例保留） | 回归：审批模块不受影响 | ✅ |
| does not fetch the detail until a task is selected | 默认不拉详情（无 `/completion-plan`、无 `/tasks/:id` 请求） | ✅ |
| lists executions with the eight-state Chinese labels, attempts and the review child marker | 8 态中文标签（已成功/复核中/失败）、`第 2 次`、`复核子执行 · 父执行 execution_1`、artifactRef 截断（`副本 artifact_ref_0123456789a…`）×2、region landmark | ✅ |
| expands an execution to reveal its evidence with kind, exit code, verdict and a bounded summary | kind 中文（测试/命令）、`退出码 0/1`、verdict 通过/失败、summary 有界截断（160 字+`…`，全量不出现） | ✅ |
| shows the review child its own evidence when expanded | 展开 review 子执行拿到其独立证据（复核/独立复核通过） | ✅ |
| reports an honest empty state when the task has no executions or evidence | 空 executions → 「该任务暂无 Execution。」 | ✅ |
| reports an execution with no evidence honestly when expanded | 空证据 → 「该执行暂无证据。」 | ✅ |
| lists every unmet completion reason and truncates the parameters digest | `ready=false` 逐条 reasons、region landmark、digest 截断（全量不出现） | ✅ |
| states the fixed acceptance condition when ready without any completion call-to-action | `ready=true` 陈述文案、无 reasons、**无任何 /完成/ 按钮** | ✅ |
| shows an unreachable notice with a retry and never fabricates executions when the detail fails | 500 → 双「不可达」文案 + 2 个「重试」按钮 + 无假数据（`worker-a` 不出现） | ✅ |

命令与结果（cwd = `/Users/markus/ai-agent-cockpit/vendor/cezar`，均经 npm）：

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck:web`（`tsc --noEmit`） | ✅ exit 0，无报错 |
| `npm test -- packages/web/src/routes/dashboard` | ✅ **Test Files 26 passed（26）；Tests 176 passed（176）** |
| `npm test`（全 cockpit + server vitest） | ⚠️ **Tests 8 failed / 8816 passed / 5 skipped（8829）；Test Files 3 failed / 519 passed / 1 skipped（523）**——8 条失败**全部**位于 `|server|` 项目，且**与本批改动零重叠**（详见“未覆盖项/诚实边界”） |
| `npm run test:runtime-policy`（cwd 仓库根） | ✅ **39 / 39 pass，fail 0**（exit 0） |
| `npm run audit:secrets`（cwd 仓库根） | ✅ `PASS: 0 undispositioned credential-shaped hits.`（7 条已核销的合成样例，均非真实凭据） |

`npm test` 的 8 条失败（**均为改动前既有、环境相关，且本批未触碰任何 server 文件**）：
- `|server| src/server/tracker/connections.test.ts`（5 条）：temp 目录下 `.env` 的 `ENOENT` 与深比较不一致，属并发临时目录/文件系统环境噪声；
- `|server| src/workspace/dashboard-forge-git.test.ts`（2 条）：真实 git remote 读取行为；
- `|server| src/core/copilot-acp-runner.test.ts`（1 条）：`/private/var/folders/…` 与 `/var/folders/…` 的 macOS `realpath` 符号链接差异。

本批改动**仅限** `packages/web/src/routes/dashboard/` 三个文件，上述 server 用例不可能受其影响；`packages/web` 侧用例在 `npm test` 中**全部通过**。

## 要求审计方做什么

- 按 **P5/B04** 复核本批三个源码/测试文件的新 hash、diff 与新用例。重点：
  1. 八态 status 映射与色彩语义是否符合设计系统「色在点、字中性」约定；
  2. Evidence 是否按 **contracts 实际 7 类 kind**（非“六类”）全量映射，`summary`/`artifactRef`/`parametersDigest` 三处截断是否“有界”且不泄露全量（全量仅在 `title` 属性）；
  3. `ready=false` 是否**逐条**原样呈现中文 reasons、`ready=true` 是否**无**任何完成 CTA；
  4. 诚实三态：失败时是否显示「不可达」+ 可重试且**零编造数据**；空态是否如实；
  5. 是否真的**只读**（无 `POST /complete`、无任何写调用）。
- 非返工前请确认：未触碰任一 `package.json`、`docs/audits/**`、`docs/plans/**`；未执行任何 git 命令；未新增依赖。
- 等待期间可继续的无冲突独立任务：P5 其余片（预算/`nextWakeAt`/投递分层 badge 等）。

## 未覆盖项与诚实边界声明

- **未跑 `npm run build` / `npm run test:package`**：按批次约定（vendor AGENTS.md 的完整验证序列在本批范围过重），本批只跑 `typecheck:web` + vitest + 仓库根两道门；**未产出/校验打包 tarball，未跑 e2e**。如需可另行补跑。
- **真浏览器 / 手机实页属 T07 Markus 抽验**：本批只有 jsdom 合成测试，**未在真实浏览器渲染、未验响应式/暗色/移动端 safe-area**。视觉与交互需 Markus 在真机抽验。
- **i18n 未统一**：新串按既有 `continuous-goals.tsx` 惯例**硬编码中文**，未迁入 `locale-provider.tsx` 的 `TRANSLATIONS`。统一 i18n 为后续独立步骤，需在同一批内一次性迁移 control-plane 系列 + continuous-goals 的硬编码串。
- **下一片范围**：预算上限、`nextWakeAt`、投递分层 badge 等 Execution 扩展字段**不在本批**；本批只呈现 contracts 已稳定暴露的字段（workerId/status/attempt/artifactRef/parentExecutionId 与 Evidence 七字段）。
- **未做真实完成**：completion-plan 面板**只读呈现**，`POST /api/control-plane/tasks/:id/complete` 及其审批链**不在本批**，面板刻意不给完成按钮。
- **生产未重启/未部署**：本批为前端源码 + 合成测试，运行中的控制面/驾驶舱仍执行旧代码；新 UI 生效需另行构建部署（`packages/cezar/web/dist`），不属本批授权。
- **`npm test` 的 8 条 server 失败为既有环境问题**：见“验证”表下方说明；本批未改任何 server 文件，且这些用例在改动前即失败（macOS `realpath`、temp 目录、真实 git）。**未**用 git 做基线对比（本批禁止 git），判断依据是改动范围与失败性质。
- 未执行真实外呼/生产读写/launchd/服务重启/git；未改任一 `package.json`；未新增依赖。
