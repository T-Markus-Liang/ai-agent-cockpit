# 执行交接包：P5 / Wave 4 收尾 —— 驾驶舱 i18n 统一 + aria 补齐 + 导航收敛（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双 AI 协作协议](../plans/0.3.0-collaboration.md)。本包落实主 Agent 定稿的设计合同，完成 P5/B04 差距清单的**最后三项**：五个 Personal AI OS 驾驶舱模块的 i18n 统一（英文源串 + `t()` 中文映射）、交互元素的 aria 补齐（approvals 批准/拒绝按钮、Status/Pill/徽章）、以及导航收敛评估。纯前端只读呈现 + 合成 mock 单测覆盖。r1 交接为新建文件，不覆盖任何旧交接包。

## 批次身份与状态

- batchId / revision：p5-i18n-aria-nav / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行 AI：Kimi Code 会话（执行方，subagent deepseek-flash 实现）；branch `feat/0.3.0-progress`；cwd `/Users/markus/ai-agent-cockpit`；宿主工作区 `vendor/cezar/packages/web`
- 已读并确认协作协议：是。**本批实际写入**（均在前端 `packages/web/src` 与 docs 内）：
  - `vendor/cezar/packages/web/src/components/locale-provider.tsx`（**修改**：源串迁移 + 新增 `fill()` 插值助手）
  - `vendor/cezar/packages/web/src/routes/dashboard/continuous-goals.tsx`（**修改**：i18n）
  - `vendor/cezar/packages/web/src/routes/dashboard/control-plane-approvals.tsx`（**修改**：i18n + aria）
  - `vendor/cezar/packages/web/src/routes/dashboard/control-plane-tasks.tsx`（**修改**：i18n + aria/装饰图标）
  - `vendor/cezar/packages/web/src/routes/dashboard/control-plane-executions.tsx`（**修改**：i18n + aria/装饰图标）
  - `vendor/cezar/packages/web/src/routes/dashboard/system-connections.tsx`（**修改**：i18n + Status aria）
  - `vendor/cezar/packages/web/src/routes/dashboard/continuous-goals.test.tsx`（**修改**：zh-CN 适配 + en/aria 新用例）
  - `vendor/cezar/packages/web/src/routes/dashboard/system-connections.test.tsx`（**修改**：zh-CN 适配 + en 新用例）
  - `vendor/cezar/packages/web/src/routes/dashboard/control-plane-dashboard.test.tsx`（**修改**：zh-CN 适配 + en/aria 新用例）
  - `docs/handoffs/p5-i18n-aria-nav-r1.md`（本文件，**新增**）
- **未改**：`nav-items.ts`（**有意不改，见合同 (3)**）、仓库根 `package.json`、`vendor/cezar/package.json`、`vendor/cezar/packages/web/package.json`、`docs/audits/**`、`docs/plans/**`、任何服务端/生产文件、`routes/workflows/personal-ai-os-workflow.tsx`（不在本批对象）、`routes/settings/local-agents-section.tsx`（不在本批对象）。**未执行任何 `git` 命令**。**未新增任何依赖**。
- 对应：P5/B04 差距清单第 2 片——「硬编码中文不经 t()（locale 切换不一致）；approvals 按钮与 Status 组件缺 aria-label；核心导航需改 nav-items.ts」三项。

## 固定来源

- base HEAD：`11da6a39400f4cb48ee5b9b1f21e3b6f0b18d588`（读 `.git/HEAD` → `ref: refs/heads/feat/0.3.0-progress`，再读 `.git/refs/heads/feat/0.3.0-progress` 得到；**未执行任何 git 命令**）
- 变更文件（SHA256，2026-10-08）：
  - `vendor/cezar/packages/web/src/components/locale-provider.tsx` `fa71603bade59168d6d1ccde10b0b8364d56466d563136d06ce94bf0b2f4cf96`（119 → **299 行**）
  - `vendor/cezar/packages/web/src/routes/dashboard/continuous-goals.tsx` `757b55e70ca39510fcb68c18f4468e52733f1c3806157c2406eacee57a80a387`（172 → **177 行**）
  - `vendor/cezar/packages/web/src/routes/dashboard/control-plane-approvals.tsx` `54d3ee800cb1cf0f601d060d1d3b5373af2caec2b2f8008ee3d800c10d6ef05f`（41 → 41 行）
  - `vendor/cezar/packages/web/src/routes/dashboard/control-plane-tasks.tsx` `795c6d1844dfe176200376dc0ef614c110cfe8352b42789f486807115f381193`（43 → **45 行**）
  - `vendor/cezar/packages/web/src/routes/dashboard/control-plane-executions.tsx` `a4abc5feade0f571e3121838861cfb3f9686004c2cab40df8e957e433d013331`（164 → **171 行**）
  - `vendor/cezar/packages/web/src/routes/dashboard/system-connections.tsx` `e735346318cb7eac285b58bdc36442dce6aa152d82608700ec6ecc4060648bcb`（73 → **80 行**）
  - `vendor/cezar/packages/web/src/routes/dashboard/continuous-goals.test.tsx` `5d3757f6d62db6d75a63888be066eb3855b43bde6ae136ce52c49713140997dd`（228 → **272 行**；用例 **22 → 25**）
  - `vendor/cezar/packages/web/src/routes/dashboard/system-connections.test.tsx` `cb9c794d60132db2b109a41074570951ff4188dd100eefffb803da18a3ee0c78`（42 → **59 行**；用例 **2 → 3**）
  - `vendor/cezar/packages/web/src/routes/dashboard/control-plane-dashboard.test.tsx` `d01c67093f80bcb78fe1e9189bd5154c443e22215a27579ec7a7c9b00b0162ef`（178 → **212 行**；用例 **11 → 14**）
  - `docs/handoffs/p5-i18n-aria-nav-r1.md`（**新增**，本文件；其自身 sha256 因自引用不稳定，由执行方在回报中给出）
- 未改冲突面：`vendor/cezar/packages/web/src/components/nav-items.ts`（sha 未变）、`nav-items.test.ts`（sha 未变）、`routes/dashboard/index.tsx`（sha 未变）。

## 合同逐条回答

### (1) i18n 统一（英文源串 + `t()` 中文映射）

**根因与修法**：`locale-provider.tsx` 的机制是「英文源串 → `TRANSLATIONS` zh-CN 映射；`t(text)` 在 zh-CN 下查表、在 en 下原样返回」。此前 system-connections 的四行键值**用中文当键**（`'系统连接': '系统连接'` …），中文进中文出——这正是「locale 切换不一致」的实际病灶：en 下也只会显示中文。本批把五个模块的**全部用户可见中文**改为**英文源串作键**，`TRANSLATIONS` 补 zh-CN 值（**中文措辞逐字保持今天的产品语义**）。

- en 下渲染 = 英文源串；zh-CN 下渲染 = 与今天**逐字一致**的中文。
- **动态/含变量文案按「模板键 + `fill()` 插值」处理，不硬塞整句**。新增导出 `fill(template, values)`（`locale-provider.tsx`）：整句（含 `{name}` 占位）才是翻译键，中文表按自己的语序携带同占位符，避免拼接译文碎片导致的语序错误。例：
  - `fill(t('Attempt {attempt}'), { attempt: 2 })` → en「Attempt 2」/ zh-CN「第 2 次」
  - `fill(t('Check in ~{minutes} min'), { minutes })` → en「Check in ~5 min」/ zh-CN「约 5 分钟后检查」
  - `fill(t('{count} items'), { count })` → en「N items」/ zh-CN「N 个」
  - `fill(t('Local storage · {pending} pending · {retrying} retrying'), …)` → zh-CN「本地存储 · 待提炼 N · 重试 M」
- 域枚举（Goal 状态/阶段、Task 状态、Execution 八态、Evidence 七种 kind）的映射表改为**英文源**，在渲染点 `t(...)`；未知值回退原值（`t(LABELS[s] ?? s)`），卡片绝不臆造标签。
- 抛出的错误（`AuthError`/`ServiceError` 及 `connectError`/`editError`）改为**英文源串**，仅在渲染点 `t(...)` 一次；不再出现「set 时译一次、render 时再译一次」的双译。
- 表单默认值（标题/完成目标/检查名）亦本地化（用户可见内容）。

**zh-CN 逐字一致锚点举例**：`持续目标 · 自主验证`、`访问凭据（access token）`、`中断自恢复：已接续 1 / 3 次；先核对范围和检查点`、`第 2 次`、`复核子执行 · 父执行 execution_1`、`副本 artifact_ref_0123456789a…`、`执行状态：复核中`、`判定：通过`、`参数摘要 sha256:…`、`本地存储 · 待提炼 2 · 重试 1`、`微信主 Agent（配置）`、`已完成验收`、`待交付`、`Review 中`、`修复 add 函数，使正数、负数和零的加法测试通过；不要修改验收测试。`——均由既有/新增单测在 zh-CN 下**断言逐字**（见测试表）。

### (2) aria 补齐

- `control-plane-approvals.tsx`：**批准/拒绝按钮补 `aria-label`**，命名到「动作 + 目标」（`批准 cezar.dispatch · execution_1` / `拒绝 cezar.dispatch · execution_1`），摆脱同页重复的裸动词。徽章计数维持可见文本。
- `system-connections.tsx` 的 `Status` 组件：补 `role="img"` + `aria-label=<本地化状态>`（`已连接`/`可接入`/`Unavailable`），图标 `aria-hidden`。`role="img" + aria-label` 沿用本仓既有惯例（见 executions 的 verdict 点）。
- 五页**通盘扫过交互元素**：装饰性图标（ShieldCheck/Check/X、Activity、Loader/Alert、PackageCheck、Chevron、Refresh、CheckCircle/Help/X、ExternalLink）统一 `aria-hidden="true"`；既有 `aria-expanded`/`role="region"`/`role="status"`/`role="alert"`/`aria-label` 全部保留并按需本地化。**未过度添加**：无必要处不加 aria。
- 新增 aria 存在性断言：approvals 两按钮（zh + en）、continuous-goals 恢复徽章、control-plane 展开按钮（`Show evidence for execution execution_1`）。

### (3) 导航收敛（nav-items.ts）——**结论：现状已合理，本批不强行改（如实说明）**

读现状后判定 **`NAV_ITEMS` 不宜改动**，理由（可审计）：

1. 五个 Personal AI OS 模块**不是独立路由**，而是 `/dashboard` 单一表面内的子模块（`routes/dashboard/index.tsx` 里 `<SystemConnections/><ContinuousGoals/><ControlPlaneTasks/><ControlPlaneApprovals/>` 固定顺序渲染）。
2. `/dashboard` **已经是一级侧栏入口**：`app-shell.tsx` 的 `DashboardLink`（`t('Dashboard')` = 「仪表盘」，`data-slot="dashboard-link"`），且 `app-shell.test.tsx` 已有 `Dashboard active navigation` 用例固定其高亮行为。即计划要求的「核心导航含仪表盘」**已满足**，只是经专用门而非 `NAV_ITEMS` 承载。
3. **若硬把 `/dashboard` 加进 `NAV_ITEMS` 会打破既有机制**：`NAV_ITEMS` 的条目在 shell 里用**作用域化** `Link`（`@/lib/project-router`）渲染，会把 `/dashboard` 前缀成 `/p/<id>/dashboard`——那不是一条路由（多项目 spec 下 `/dashboard` 刻意在 `/p/:projectId` 之外，与 global settings 同理）。这正是 `DashboardLink` 用**非作用域** `NavLink` 的原因。强行加入需改造 shell 特例并冒双入口/坏链回归风险，正是 vendor `AGENTS.md`「改动已经能用的机制」所警示的。
4. `PAGE_TITLE_ROUTES`（`routes.tsx`）已含 `/dashboard → 'Dashboard'`；无缺漏。

综合：以**最小改动**为准，本批**不动** `nav-items.ts`，`nav-items.test.ts` 亦无需同步（保持 `is the nav from the spec, in mockup order` 不变、全绿）。**`/dashboard` 与 Personal AI OS 各页面的可发现性已由侧栏 Dashboard 门 + 命令面板承载**；把模块拆成一级导航（计划中的「对话/任务 · 运行与验收 · Agent/原生会话 · 设计工作流 · 日志/通知」）是更大的产品级改造，超出本「收尾」批次授权。**如需**，建议单列一波（含新增路由 + shell 双入口的取舍），而非塞进本批。

### (4) 测试与回归

- 既有测试适配：三处测试文件改为 `beforeEach(() => window.localStorage.setItem('cez-locale','zh-CN'))` + 用 `LocaleProvider` 包裹（沿用 locale-provider 的自动探测路径：localStorage 优先），使原先按中文断言的用例继续**逐字**校验中文；`afterEach` 清 `localStorage`。
- 新增用例：**locale=en 渲染英文源串**、**locale=zh-CN 逐字一致**、**aria-label 存在性**（见下表）。
- 全部为 **vitest jsdom + 全局 mock `fetch`**：**未起任何真实服务、未外呼真实网络、未执行写操作、未连 127.0.0.1:4324/4326/4322/8080**。仅用 `localStorage` 断言 locale 分支。

## 测试与验证（原始结果）

| 命令（cwd 见注） | 结果 |
| --- | --- |
| `npm run typecheck:web`（cwd `vendor/cezar`，`tsc --noEmit`） | ✅ exit 0，无报错 |
| `npm test -- packages/web/src/routes/dashboard`（cwd `vendor/cezar`） | ✅ **Test Files 26 passed（26）；Tests 192 passed（192）** |
| `npm test -- packages/web`（cwd `vendor/cezar`） | ✅ **Test Files 244 passed（244）；Tests 4438 passed（4438）** |
| `npm test -- src/components/nav-items.test.ts src/components/app-shell.test.tsx src/routes/dashboard/navigation.test.tsx`（cwd `vendor/cezar/packages/web`） | ✅ **Test Files 3 passed（3）；Tests 136 passed（136）**（nav-items 35 / app-shell 95 / navigation 6） |
| `npm test`（全 cockpit+server，cwd `vendor/cezar`） | ⚠️ **Tests 8 failed / 8832 passed / 5 skipped（8845）；Test Files 3 failed / 519 passed / 1 skipped（523）**——8 条失败**全部**位于 `\|server\|` 项目，**与本批零重叠**（详见下） |
| `npm run test:runtime-policy`（cwd 仓库根） | ✅ **39 / 39 pass，fail 0**（exit 0） |
| `npm run audit:secrets`（cwd 仓库根） | ✅ `PASS: 0 undispositioned credential-shaped hits.`（7 条已核销合成样例，均非真实凭据） |

新增/改写用例：

| 文件 | 用例 | 覆盖合同 | 结果 |
| --- | --- | --- | --- |
| continuous-goals.test.tsx | 既有 21 条（zh-CN 下逐字中文断言） | 回归 + zh 逐字一致 | ✅ |
| continuous-goals.test.tsx | renders the English source strings under locale=en | en 源串（New continuous goal / Connect / Access credential / Continuous goals · autonomous verification） | ✅ |
| continuous-goals.test.tsx | renders the same Chinese wording under locale=zh-CN | zh-CN 逐字（新建持续目标 / 连接 / 访问凭据 / 持续目标 · 自主验证） | ✅ |
| continuous-goals.test.tsx | exposes aria-labels on the recovery badges | aria 存在性 | ✅ |
| system-connections.test.tsx | 既有 2 条（zh-CN 下逐字中文断言） | 回归 + zh 逐字一致 | ✅ |
| system-connections.test.tsx | renders the English source strings under locale=en, keeping brand names | en 源串 + 品牌名不译（Kimi CLI 保留） | ✅ |
| control-plane-dashboard.test.tsx | 既有 11 条（zh-CN 下逐字中文断言） | 回归 + zh 逐字一致 | ✅ |
| control-plane-dashboard.test.tsx | labels each approval decision button with its action and target | aria 存在性（批准/拒绝按钮，zh） | ✅ |
| control-plane-dashboard.test.tsx | renders English source strings under locale=en | en 源串 + en 展开按钮 aria | ✅ |
| control-plane-dashboard.test.tsx | labels approval buttons in English under locale=en | en aria（Approve/Reject …） | ✅ |

`npm test` 的 8 条失败（**均为改动前既有、环境相关，且本批未触碰任何 server 文件**）：
- `|server| src/server/tracker/connections.test.ts`（5 条）：temp 目录下 `.env` 的 `ENOENT` 与深比较不一致，属并发临时目录/文件系统环境噪声；
- `|server| src/workspace/dashboard-forge-git.test.ts`（2 条）：真实 git remote 读取行为；
- `|server| src/core/copilot-acp-runner.test.ts`（1 条）：`/private/var/folders/…` 与 `/var/folders/…` 的 macOS `realpath` 符号链接差异。

本批改动**仅限** `packages/web/src/` 九个文件（+ 本文档），上述 server 用例不可能受其影响；`packages/web` 侧用例在 `npm test` 中**全部通过**（244 文件 / 4438 用例）。

## 要求审计方做什么

- 按 **P5/B04 第 2 片**复核本批九个源码/测试文件的新 hash、diff 与新用例。重点：
  1. **zh-CN 逐字一致**：抽查 `TRANSLATIONS` 的中文值是否与改动前渲染**逐字相同**（尤其含 `·`/`：`/`（）`/空格的句子与模板占位符语序）；
  2. **模板键 vs 硬塞整句**：含变量处是否一律走 `fill()` + 模板键，未把整句（带具体值）塞进 `TRANSLATIONS`；
  3. **en 源串**：en 下是否干净英文、无残留中文（品牌名除外）；
  4. **aria**：approvals 批准/拒绝按钮是否命名到「动作 + 目标」；`Status` 是否 `role="img" + aria-label`；装饰图标是否 `aria-hidden`；有无过度添加；
  5. **导航收敛**：认可「`NAV_ITEMS` 不改、`/dashboard` 由专用非作用域门承载、不塞进作用域化 `NAV_ITEMS`」的判定与理由（合同 (3)）。
- 非返工前请确认：未触碰任一 `package.json`、`docs/audits/**`、`docs/plans/**`、`nav-items.ts`；未执行任何 git 命令；未新增依赖。

## 未覆盖项与诚实边界声明

- **导航收敛为「如实不改」**：按合同「如果现状已合理，如实说明不强行改」。计划中更完整的核心导航重构（多一级入口 + 新路由）**不在本批**，见合同 (3)。
- **未跑 `npm run build` / `npm run test:package`**：按批次约定，本批只跑 `typecheck:web` + vitest + 仓库根两道门；**未产出/校验打包 tarball，未跑 e2e**。如需可另行补跑。
- **真浏览器 / 手机实页属 T07 Markus 抽验**：本批只有 jsdom 合成测试，**未在真实浏览器渲染、未验响应式/暗色/移动端 safe-area、未验真机上的 locale 切换观感**。视觉与交互需 Markus 在真机抽验。
- **未切换服务运行态**：本批为前端源码 + 合成测试，运行中的驾驶舱仍执行旧代码；新 UI 生效需另行构建部署（`packages/cezar/web/dist`），不属本批授权。**生产未重启/未部署**。
- **`npm test` 的 8 条 server 失败为既有环境问题**：见上；本批未改任何 server 文件，且这些用例在改动前即失败（macOS `realpath`、temp 目录、真实 git）。**未**用 git 做基线对比（本批禁止 git），判断依据是改动范围与失败性质。
- **本批对象边界**：仅 `routes/dashboard/` 的五个 Personal AI OS 模块 + `locale-provider.tsx`。`routes/workflows/personal-ai-os-workflow.tsx` 与 `routes/settings/local-agents-section.tsx` 同含硬编码中文，**不属本批对象**（前者是工作流页、后者是设置页），留待各自批次。
- 未执行真实外呼/生产读写/launchd/服务重启/git；未改任一 `package.json`；未新增依赖。

---

## r1 增补：两文件收尾（D60 登记的两个非本批对象文件）

D60 合同「本批对象边界」明确登记 `routes/workflows/personal-ai-os-workflow.tsx` 与 `routes/settings/local-agents-section.tsx` 同含硬编码中文、留待各自批次。本节即该收尾：两文件的**用户可见中文**改为英文源串 + `t()`，`TRANSLATIONS` 补 zh-CN 映射（措辞逐字不变），含变量处走 `fill()` 模板键。纯前端；未起服务、未外呼、未执行任何 git、未改任何 `package.json` / `docs/audits/**` / `docs/plans/**`、未新增依赖。

### 本批实际写入

- `vendor/cezar/packages/web/src/routes/workflows/personal-ai-os-workflow.tsx`（**修改**：i18n）sha256 `f0319422f0e778c717cdd5038e52584940c95ea616f3bf443f887576860aee4d`（36 → **42 行**）
- `vendor/cezar/packages/web/src/routes/settings/local-agents-section.tsx`（**修改**：i18n + 装饰图标 `aria-hidden`）sha256 `149c25fc03c96eae1c1a4f53a636b57764793c7a4e8e7cd9ea373e84723b5aac`（58 → **65 行**）
- `vendor/cezar/packages/web/src/routes/workflows/personal-ai-os-workflow.test.tsx`（**修改**：zh-CN 适配 + en 新用例）sha256 `64fe11ca6cdc337383c41a5cfb66a834f2bb0f961795d0bedff397d3bc42e4a3`（17 → **40 行**；用例 **1 → 3**）
- `vendor/cezar/packages/web/src/routes/settings/local-agents-section.test.tsx`（**新增**：zh-CN 逐字 + en 源串 + 未知状态）sha256 `241531a1aebce1b95d94794d0b5a3c1b964270dbcffb8392a36ccb2921d91643`（**58 行**；用例 **0 → 4**）
- `vendor/cezar/packages/web/src/components/locale-provider.tsx`（**修改**：仅追加 zh-CN 映射）sha256 `245c9ad38b28f8c9709598ce2f40c876f9dac27e1364f0e74334c027cd0967fc`（299 → **331 行**）
- `docs/handoffs/p5-i18n-aria-nav-r1.md`（本文件，**追加本节**；其自身 sha256 因自引用不稳定，由执行方在回报中给出）
- **未改**：仓库根 `package.json`、`vendor/cezar/package.json`、`vendor/cezar/packages/web/package.json`、`docs/audits/**`、`docs/plans/**`、任何服务端/生产文件、`nav-items.ts`。**未执行任何 `git` 命令**。**未新增依赖**。

### TRANSLATIONS 键数

- 键数：**359 → 386**（**+27**，全部为本次两文件新增）。脚本逐字核对：`duplicates = []`，`cjk keys = []`。
  > 口径说明：任务简报所记「D60 后 286 键」与文件实测不符；本次改动前对 `locale-provider.tsx` 的 `TRANSLATIONS` 字面量用状态机逐字符解析，实测为 **359** 键（D60 后、本批前）。本节以实测为准。
- **复用的既有键**（未新增、无重复）：`WeChat primary agent (configured)`、`Shared Mem0 memory`、`Long-term retrieval is unavailable; WeChat keeps using local context`、`Connected`、`Available`、`Unavailable`、`Local agents`。
- **含变量的模板键（走 `fill()`，不拼碎片）**：`Connected · {pending} pending · {retrying} retrying` → zh-CN「已连接 · 待提炼 {pending} · 重试 {retrying}」。
- **品牌/命令/缩写名不入表，`t` 原样返回**：`Chief`、`Feature Map + Router`、`Task / Execution`、`Reviewer + Verification`、`Approval / Completion Gate`、`Codex`、`Kimi CLI`、`GUI-only`、`codebuddy --acp`、`kimi --session` 等。

### 合同逐条

1. **英文源串 + `t()`**：两文件全部用户可见中文改为英文源串、渲染点 `t()`；zh-CN 值逐字等于今天。覆盖 `NODES` 标题/详情、`ADAPTERS` 注记、状态徽章、Mem0 卡片标题/描述、内存队列行、Qdrant 脚注、`statusFor` 的「微信主 Agent（配置）」前缀（复用既有键，` · ` 为语言中立分隔符，沿用 D60 的拼接惯例）。
2. **aria 补齐**：两文件**无**缺可访问名的交互元素（`personal-ai-os-workflow` 无交互元素；`local-agents-section` 的外链 `<a>` 有可见 URL 文本即其可访问名）。仅将**装饰图标**补 `aria-hidden="true"`：`TerminalIcon`、`ExternalLinkIcon`；`personal-ai-os-workflow` 的 `WorkflowIcon`/`ArrowDownIcon`/`ShieldCheckIcon` 与 `→` 分隔符本就 `aria-hidden`。**未过度添加**。
3. **无重复键、无残留中文键**：见上（386 键，`duplicates=[]`，`cjk keys=[]`）。

### 测试与验证（原始结果）

| 命令（cwd） | 结果 |
| --- | --- |
| `npm test -- packages/web/src/routes/workflows/personal-ai-os-workflow.test.tsx packages/web/src/routes/settings/local-agents-section.test.tsx`（cwd `vendor/cezar`） | ✅ **Test Files 2 passed（2）；Tests 7 passed（7）** |
| `npm test -- packages/web/src/routes`（cwd `vendor/cezar`） | ✅ **Test Files 127 passed（127）；Tests 2262 passed（2262）** |
| `npm test -- packages/web`（cwd `vendor/cezar`） | ✅ **Test Files 245 passed（245）；Tests 4444 passed（4444）**（较 D60 基线 244 / 4438：文件 **+1**，用例 **+6**） |
| `npm run typecheck:web`（cwd `vendor/cezar`，`tsc --noEmit`） | ✅ exit 0，无报错 |
| `npm run test:runtime-policy`（cwd 仓库根） | ✅ **39 / 39 pass，fail 0** |
| `npm run audit:secrets`（cwd 仓库根） | ✅ `PASS: 0 undispositioned credential-shaped hits.` |

新增/改写用例：

| 文件 | 用例 | 覆盖 | 结果 |
| --- | --- | --- | --- |
| personal-ai-os-workflow.test.tsx | 架构阶段渲染（zh-CN，原用例适配） | 回归 + zh 逐字 | ✅ |
| personal-ai-os-workflow.test.tsx | node 标题/详情 zh-CN 逐字一致 | zh 逐字 | ✅ |
| personal-ai-os-workflow.test.tsx | locale=en 渲染英文源串 | en 源串 | ✅ |
| local-agents-section.test.tsx | 通道 + 已配置主 Agent + 共享记忆队列（zh-CN） | zh 逐字 + 前缀 | ✅ |
| local-agents-section.test.tsx | 记忆不可用回退说明（zh-CN） | zh 逐字 | ✅ |
| local-agents-section.test.tsx | locale=en 英文源串 + 品牌名保留 | en 源串 | ✅ |
| local-agents-section.test.tsx | 未知状态标为「已发现/待验证」而非臆造就绪 | 状态徽章 | ✅ |

全部为 vitest jsdom + 全局 mock `fetch`：**未起任何真实服务、未外呼真实网络、未执行写操作、未连 127.0.0.1:4324/4322/8080**。locale 强制方式学 `continuous-goals.test.tsx`（`localStorage['cez-locale']` 优先）+ `LocaleProvider` 包裹。

### 越界中文残留（grep `packages/web/src/routes/` 与 `.../components/`）

改动后**两目标文件已无中文残留**。其余命中：

- **非本批对象、仍为真实硬编码中文（新发现，D60 与本批均未登记）**：`routes/settings/wechat-section.tsx` —— **9 处**用户可见中文：标题「微信连接」、描述「通过本机微信桥接器接收任务和发送 Agent 回复。」、「已连接」、「点击生成二维码，用微信扫码并确认登录。」、「生成中…」/「生成微信二维码」、iframe title「微信登录二维码」、「已扫码，请在微信中确认登录。」、`微信控制服务不可用：${error}`、「二维码和登录令牌只在本机回环服务处理，不会提交到 Git 仓库。」。**建议单列批次**。
- **仅注释、非用户可见**：`routes/dashboard/continuous-goals.tsx:49`（代码注释中的「待唤醒」，D60 文件）。
- **测试文件（按设计在 zh-CN 断言中文）**：`routes/dashboard/continuous-goals.test.tsx`、`routes/dashboard/system-connections.test.tsx`、`routes/dashboard/control-plane-dashboard.test.tsx`、`routes/workflows/personal-ai-os-workflow.test.tsx`、`routes/settings/local-agents-section.test.tsx`。
- **`components/locale-provider.tsx`**：命中即 zh-CN 映射值本身，预期。

### 未覆盖项与诚实边界

- 仅 jsdom 合成测试；**未在真实浏览器渲染、未验响应式/暗色/移动端 safe-area、未验真机 locale 切换观感**——需 Markus 真机抽验。
- 未跑 `npm run build` / `npm run test:package` / e2e；未产出/校验打包 tarball。
- 未切换服务运行态：运行中的驾驶舱仍执行旧代码，新 UI 生效需另行构建部署（`packages/cezar/web/dist`），不属本授权。
- 只有前端源码 + docs 变更；**未起服务、未外呼、未执行 git、未改 `package.json`、未新增依赖**。

---

### r1 增补（二）：wechat-section.tsx 收尾

上一小节「越界中文残留」第 1 项（`routes/settings/wechat-section.tsx` 的 9 处用户可见中文）已按同口径收尾：英文源串 + `t()`，`TRANSLATIONS` 补 zh-CN 逐字映射，含变量的错误文案走 `fill()` 模板键，iframe `title` 经 `t()` 本地化，装饰图标补 `aria-hidden`（`MessageCircleIcon`/`CheckCircle2Icon`/`RefreshCwIcon`）。**该文件此前无测试，本节新增 `wechat-section.test.tsx`。**

- `vendor/cezar/packages/web/src/routes/settings/wechat-section.tsx`（**修改**：i18n + iframe title + 装饰图标 `aria-hidden`）sha256 `0683155b3bba3865c2c4e9f352f74d9eecf98dcb200d44e9b13351220b01a4ed`（72 → **76 行**）
- `vendor/cezar/packages/web/src/routes/settings/wechat-section.test.tsx`（**新增**：zh-CN 逐字 + en 源串 + iframe title + 错误文案 + 已连接/已扫码）sha256 `9a508692d05508e67b0de61d8379d50dda51122dd48000510dbb54008a06c4ce`（**57 行**；用例 **0 → 6**）
- `vendor/cezar/packages/web/src/components/locale-provider.tsx`（**修改**：仅追加 zh-CN 映射）sha256 `c44c4a27c0fed87c7f598b09932a6c28f82ee47e1e32fc42d37dd9cb0dce37f3`（331 → **344 行**）
- `docs/handoffs/p5-i18n-aria-nav-r1.md`（本文件，**追加本小节**；其自身 sha256 因自引用不稳定，由执行方在回报中给出）

**TRANSLATIONS 键数**：**386 → 395（+9）**；脚本逐字核对 `duplicates = []`、`cjk keys = []`。新增键：`WeChat connection`、`Receive tasks and send Agent replies through the local WeChat bridge.`、`Click to generate a QR code, then scan it in WeChat and confirm the login.`、`Generating…`、`Generate WeChat QR code`、`WeChat login QR code`、`Scanned; confirm the login in WeChat.`、`WeChat control service is unavailable: {error}`（`fill()` 模板，zh-CN「微信控制服务不可用：{error}」）、`The QR code and login token are handled only by the local loopback service, and are never committed to the Git repository.`。「已连接」**复用既有键** `Connected`，未新增、无重复。

**合同逐条**：(1) 9 处用户可见中文全改英文源串 + 渲染点 `t()`，zh-CN 逐字不变；`refresh` 的 `useCallback` 依赖由 `[]` 补为 `[t]`（locale 变化时重建，2s 轮询内自然重渲染，无 stale 文案）。(2) aria：装饰图标 `aria-hidden`；iframe `title` 经 `t()` 本地化（即可访问名）；`Button` 有可见文本即其可访问名；**无过度添加**。(3) 无重复键、无中文键。

**测试与验证（原始结果）**

| 命令（cwd） | 结果 |
| --- | --- |
| `npm test -- packages/web/src/routes/settings/wechat-section.test.tsx`（cwd `vendor/cezar`） | ✅ **Test Files 1 passed（1）；Tests 6 passed（6）** |
| `npm test -- packages/web/src/routes`（cwd `vendor/cezar`） | ✅ **Test Files 128 passed（128）；Tests 2268 passed（2268）** |
| `npm test -- packages/web`（cwd `vendor/cezar`） | ✅ **Test Files 246 passed（246）；Tests 4450 passed（4450）**（较上节 245 / 4444：文件 **+1**，用例 **+6**） |
| `npm run typecheck:web`（cwd `vendor/cezar`，`tsc --noEmit`） | ✅ exit 0 |
| `npm run test:runtime-policy`（cwd 仓库根） | ✅ **39 / 39 pass，fail 0** |
| `npm run audit:secrets`（cwd 仓库根） | ✅ `PASS: 0 undispositioned credential-shaped hits.` |

**残留中文终检（grep `packages/web/src/routes/` 与 `.../components/`）**：**用户可见硬编码中文已清零**。仅余：

- `components/locale-provider.tsx` —— 命中即 zh-CN 映射值本身（翻译表，预期）；
- `routes/dashboard/continuous-goals.tsx:49` —— **代码注释**中的「待唤醒」，非用户可见；
- 测试文件（按设计在 zh-CN 断言中文）：`dashboard/continuous-goals.test.tsx`、`dashboard/system-connections.test.tsx`、`dashboard/control-plane-dashboard.test.tsx`、`workflows/personal-ai-os-workflow.test.tsx`、`settings/local-agents-section.test.tsx`、`settings/wechat-section.test.tsx`。

**未覆盖项与诚实边界**：仅 jsdom 合成测试（mock `fetch`），**未起服务、未外呼、未在真实浏览器渲染、未验响应式/暗色/移动端**；未跑 `build`/`test:package`/e2e、未部署、未引入服务运行态；**未执行 git、未改 `package.json`/`docs/audits/**`/`docs/plans/**`、未新增依赖**。真机 locale 切换观感需 Markus 抽验。
