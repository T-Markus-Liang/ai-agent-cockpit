# 执行交接包：P5 / Wave 4 第二片 —— 持续目标卡片徽章层（nextWakeAt 下一检查 + recovery outcome）（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双 AI 协作协议](../plans/0.3.0-collaboration.md)。本包落实主 Agent 定稿的设计合同：在 Personal AI OS 驾驶舱的**持续目标卡片**（`continuous-goals.tsx`）上补一层**只读徽章**——**下一检查**（`nextWakeAt`）与**恢复 outcome**（`needsRecovery` / `recoveryCount` / `reason`）（P5/B04 差距清单之「预算/nextWakeAt/recovery outcome/投递分层 badge」中的两项）。纯前端只读，mock fetch 单测覆盖。r1 为新建文件，不覆盖任何旧交接包。

## 批次身份与状态

- batchId / revision：p5-goal-badges / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行 AI：Kimi Code 会话（执行方，subagent deepseek-flash 实现）；branch `feat/0.3.0-progress`；cwd `/Users/markus/ai-agent-cockpit`；宿主工作区 `vendor/cezar/packages/web`
- 已读并确认协作协议：是。**本批允许写入且实际写入**：
  - `vendor/cezar/packages/web/src/routes/dashboard/continuous-goals.tsx`（修改：类型 + 徽章层）
  - `vendor/cezar/packages/web/src/routes/dashboard/continuous-goals.test.tsx`（修改：新增 8 条用例）
  - `docs/handoffs/p5-goal-badges-r1.md`（本文件，新增）
- **未改**：仓库根 `package.json`、`vendor/cezar/package.json`、`vendor/cezar/packages/web/package.json`、`docs/audits/**`、`docs/plans/**`、任何服务端/生产文件、`control-plane/**`、`gateway/**`。**未执行任何 `git` 命令**。**未新增任何依赖**（复用既有 `@tanstack/react-query`、shadcn `Card`/`Button`、`Pill`/`StatusDot`，无新 import 包）。
- 对应：P5/B04 第二片。明确不做：**投递分层**（见「未覆盖项」——无可靠数据源）、i18n 统一、真机/真浏览器实页验收、生产重启/部署、任何写操作。
- vendor 说明：`vendor/cezar/` 有自己的 `AGENTS.md`，**已读并遵守**：React 19 + Vite + Tailwind v4 + shadcn、TanStack Query、vitest **经 npm 跑（不 `npx`）**、保持主题与既有测试惯例、设计系统「单一着色载体」（颜色落小圆点，行/徽章文字中性）。

## 固定来源

- base HEAD：`be3baf2c9028a6c9067c057f55471ba13e994bb8`（读 `.git/HEAD` → `ref: refs/heads/feat/0.3.0-progress`，再读 `.git/refs/heads/feat/0.3.0-progress` 得到；**未执行任何 git 命令**。注：较上一批固定来源 `526d0972…` 已前进，上一批成果已入库）
- 变更文件（SHA256，2026-10-08）：
  - `vendor/cezar/packages/web/src/routes/dashboard/continuous-goals.tsx` `4f77583496123dfcfc2cc2e229eb0382185569e96c96357e99236dbdd336e96d`（134 行 → **170 行**）
  - `vendor/cezar/packages/web/src/routes/dashboard/continuous-goals.test.tsx` `2e515d8c9a3e0f57dccbaabe036b7812015b079130ff5597a96625435f6eef18`（143 行 → **219 行**；用例 **13 → 21**）
- 数据源契约（只读，未改）——已确认 `/api/goals` 列表**实际携带**下列字段：
  - `gateway/goals.mjs:121` — `GET /api/goals` → `{ goals: await goals.list(), paused, version: '0.2.2' }`
  - `control-plane/goal-store.mjs:134` — `list()` 对每个 goal 做 `copy`（`structuredClone`），因此**记录上出现过的字段原样返回**（含 `nextWakeAt` / `needsRecovery` / `recoveryCount` / `reason` 等，缺失的字段则不带该键）
  - `nextWakeAt`（毫秒时间戳）写入点：`goal-store.mjs:143`（`resume-all`）、`:155`（`grant`）、`:167`（`control resume`）、`:232`（`settle`）、`:251`（`recover` 自动恢复）——故 `ready` / `waiting` / `running` / `complete` 及被 `pause` 前的残留值都可能带此字段
  - `needsRecovery`（布尔）写入点：`:203`（`interrupt`）、`:243`（`recover` 探测到执行中断）；清除点：`:182`（`revise`）、`:224`（`settle`）、`:251`/`:252`/`:262`
  - `recoveryCount`（整数）写入点：`:251`（`recover` 成功自动恢复 +1）
  - `reason`（字符串）写入点：`:155`（grant 清空）、`:196`（claim 到达上限）、`:203`（interrupt）、`:232`（settle）、`:243`（执行中断）、`:251`/`:252`（recover）
- 依赖：无新依赖

## 合同逐条 / Finding 回答

**(1) Goal 类型与徽章（`continuous-goals.tsx`）**

- 类型 `Goal` 补 `nextWakeAt?: number`、`needsRecovery?: boolean`；`reason?: string`、`recoveryCount?: number` **确认已在原类型里**（本批未重复声明）。
- 每卡片新增**徽章行** `GoalBadges`（渲染在标题/状态行之后），全部**只读、中文、带 `aria-label`**：

  | 徽章 | 触发条件 | 文案 | 点色（`StatusDotTone`） | aria-label |
  | --- | --- | --- | --- | --- |
  | 下一检查（近） | `nextWakeAt` 存在且 `0 < 剩余 < 60 分钟` | `约 N 分钟后检查`（N=`max(1, round(剩余/60000))`） | `pending` | `下一检查：约 N 分钟后检查` |
  | 下一检查（远） | `nextWakeAt` 存在且 剩余 ≥ 60 分钟 | `HH:MM 检查`（本地时钟） | `pending` | `下一检查：HH:MM 检查` |
  | 待唤醒 | `nextWakeAt` 已过期且 status ≠ `running`（且非终态） | `待唤醒` | `pending` | `下一检查：待唤醒` |
  | 待恢复 | `needsRecovery === true` | `待恢复` | **`danger`（醒目）** | `恢复状态：待恢复` |
  | 已自动恢复 | `recoveryCount > 0` | `已自动恢复 N 次` | `success` | `恢复状态：已自动恢复 N 次` |

- **字段缺失 → 不渲染该徽章（不伪造）**：`nextWakeAt` 为空/非有限数 → 无「下一检查」徽章；三个条件都不成立时 `GoalBadges` 直接返回 `null`（不产出空 div）。
- **诚实性护栏（在合同「已过期且非 running → 待唤醒」之上再收一道，避免对不可能发生的唤醒说谎）**：
  1. `status === 'running'` 且 `nextWakeAt` 已过期 → **不渲染**下一检查徽章（本次唤醒已经触发，`running` 期间的 `nextWakeAt` 是旧值）；
  2. `status` 为终态（`complete` / `cancelled`）→ **不渲染**下一检查徽章（终态目标不会再被唤醒，此时若显示「待唤醒」即是与事实相悖的伪造）。
  - 其余非 `running` 状态（`ready` / `waiting` / `paused` 等）按合同显示「待唤醒」。
- **颜色只落 `StatusDot`/`Pill` 载体，文字中性**：徽章一律用 `<Pill dot={tone}>`（`Pill` 内文字为 `text-muted-foreground`），色仅由 `dot` 承载。**纯文本载体仅截断显示 reason**（见 (2)）。
- **不改既有创建/暂停/恢复操作的行为**：所有 `Button`、`mutate.mutate(...)`、`edit(...)`、连接/断开与查询逻辑逐字未动。

**(2) 恢复 outcome 之 reason 截断（有界）**

- `goal.reason` 存在时在原位置显示，**截断到 160 字符**（`truncate(reason, 160)`，超出补 `…`），`title` 挂全量原文。
- 为落实合同「文字中性」，该行由原 `text-warning` 改为 `text-muted-foreground`（**这是本批对既有渲染的唯一样式改动**；原因文本本身与触发逻辑未变，仅长度有界、颜色中性；告警语义由同排的「待恢复」`danger` 徽章与状态标签承载）。短 reason 原样显示、不截断。

**(3) 不做投递分层（如实声明）**

- 「完成 / 投递 / 已读」三态的可靠数据源在**桥侧 outbox**；控制面缓存与 `GET /api/goals` 列表**均不暴露**该三态（已核 `gateway/goals.mjs` 与 `goal-store.mjs`）。本批**不做**投递分层 badge。后续切片需先由桥侧提供**只读状态合同**（见「未覆盖项」）。

## 关键 diff 摘要

1. `continuous-goals.tsx`（134 → 170 行）：
   - 新增 import：`Pill`（`@/components/pill`）、类型 `StatusDotTone`（`@/components/status-dot`）。
   - `Goal` 类型追加 `nextWakeAt?: number; needsRecovery?: boolean;`。
   - 新增纯函数 `truncate(value, max)`、`clock(ms)`（`HH:MM`）与 `nextCheck(goal, now)`（返回 `{ label, tone } | null`，含上文两条诚实性护栏），以及组件 `GoalBadges({ goal })`（有徽章才渲染，`aria-label` 齐备）。
   - 卡片 JSX：在标题/状态行后插入 `<GoalBadges goal={goal} />`；`reason` 行改为 `truncate(goal.reason, 160)` + `title={goal.reason}` + `text-muted-foreground`。**其余卡片结构、按钮、`details` 明细逐字未改。**
2. `continuous-goals.test.tsx`（143 → 219 行）：追加 8 条用例（见下），**既有 13 条一条未改**。

## 测试与验证（原始结果）

测试全部为 **vitest jsdom + 全局 mock `fetch`**（沿用本文件既有 `setup(status, extra)` 模式，`extra` 合并进 `/api/goals` 返回的 goal）：**未起任何真实服务、未外呼真实网络、未执行写操作、未连 127.0.0.1:4326**。

新增用例（8 条）：

| 用例 | 覆盖合同 | 结果 |
| --- | --- | --- |
| shows a relative next-check badge for a wake due within the hour | `nextWakeAt` 未来（近）→ `约 5 分钟后检查` + aria-label | ✅ |
| shows a clock-style next-check badge for a wake more than an hour away | `nextWakeAt` 未来（远，+2h）→ `HH:MM 检查` + aria-label | ✅ |
| labels an overdue wake as 待唤醒 for a goal that is not running | `nextWakeAt` 过期 + 非 running → `待唤醒` + aria-label | ✅ |
| omits the next-check badge for a running goal whose wake has already fired | running + 过期 → 无下一检查徽章（诚实性护栏 1） | ✅ |
| omits the next-check badge when nextWakeAt is missing rather than inventing a schedule | `nextWakeAt` 缺失 → 无徽章（不伪造） | ✅ |
| shows a prominent 待恢复 badge when the goal needs recovery | `needsRecovery` → `待恢复` + aria-label | ✅ |
| shows an automatic-recovery count badge and bounds the displayed reason | `recoveryCount=2` → `已自动恢复 2 次`；300 字 reason 截断为 160+`…`，`title` 挂全量，全量文本不出现 | ✅ |
| shows a short reason unchanged, without truncation | 短 reason 原样、不截断 | ✅ |

命令与结果（cwd 见各行；均经 npm）：

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck:web`（cwd `vendor/cezar`，`tsc --noEmit`） | ✅ exit 0，无报错 |
| `npm test -- packages/web/src/routes/dashboard/continuous-goals.test.tsx`（cwd `vendor/cezar`） | ✅ **Test Files 1 passed（1）；Tests 21 passed（21）** |
| `npm test -- packages/web/src/routes/dashboard`（cwd `vendor/cezar`） | ✅ **Test Files 26 passed（26）；Tests 184 passed（184）**（基线 176 → **184**，+8） |
| `npm run test:runtime-policy`（cwd 仓库根） | ✅ **tests 39 / pass 39 / fail 0**（exit 0） |
| `npm run audit:secrets`（cwd 仓库根） | ✅ `PASS: 0 undispositioned credential-shaped hits.`（7 条已核销合成样例，均非真实凭据） |

**回归红的可证性说明（未用 git）**：本批禁止任何 `git` 命令，故**未**用 `git stash` 做「去掉修复后新测试应变红」的对照。逻辑上，新增用例断言的是**本批新引入的 DOM**——`约 N 分钟后检查` / `HH:MM 检查` / `待唤醒` / `待恢复` / `已自动恢复 N 次` 五类徽章文案与 `aria-label`，以及 reason 的 160 字截断——这些文本与属性在改动前的 `continuous-goals.tsx` 中**完全不存在**（改动前仅有 `text-warning` 的无界 reason 行），因此这 8 条断言在改动前必然为红。此结论基于改动范围，非工具对照。

## 要求审计方做什么

- 按 **P5/B04** 复核本批两个文件的 hash、diff 与新用例。重点：
  1. 「下一检查」三态（未来近/未来远/过期）与「字段缺失不渲染」是否符合合同，且**无任何伪造**；
  2. 两条**诚实性护栏**（running 且过期不显示；终态不显示）是否被正确实现且不误伤合法态；
  3. 「待恢复」是否**醒目 tone**（`danger`）、「已自动恢复 N 次」/reason 截断是否**有界**、全量是否只出现在 `title`；
  4. 徽章是否**全部** `aria-label`、颜色是否**只落小圆点**、徽章文字是否中性；
  5. 是否真的**只读**（无任何写/变更接口调用），且**未改**既有创建/暂停/恢复/改方向操作；
  6. reason 行由 `text-warning` 改为 `text-muted-foreground`（本批对既有的唯一样式改动）是否可接受——如坚持恢复警示色，需与「文字中性」合同另行裁决。
- 非返工前请确认：未触碰任一 `package.json`、`docs/audits/**`、`docs/plans/**`、`control-plane/**`、`gateway/**`；未执行任何 git 命令；未新增依赖。

## 未覆盖项与诚实边界声明

- **投递分层（完成/投递/已读三态）本批不做，且当前无可靠数据源**：该三态在**桥侧 outbox**，控制面缓存与 `GET /api/goals` 列表均不暴露。**后续切片需先落地桥侧「只读状态合同」**（一个可被驾驶舱直连读取的稳定只读接口/字段），否则任何投递分层 UI 都只能靠猜——本批拒绝伪造，故不做。
- **未跑 `npm run build` / `npm run test:package` / `npm run test:e2e`**：按本批约定（vendor `AGENTS.md` 的完整验证序列在本批范围过重），只跑 `typecheck:web` + vitest + 仓库根两道门；**未产出/校验打包 tarball，未跑 e2e，未跑 `npm test` 全量（含 server 项目）**。
- **真浏览器 / 手机实页属 Markus T07 抽验**：本批只有 jsdom 合成测试，**未在真实浏览器渲染、未验响应式/暗色/移动端 safe-area、未验徽章换行与长 reason 的视觉折行**。视觉与交互需 Markus 在真机抽验（T07 明确「组件测试不等于实页」）。
- **i18n 未统一**：新串按既有 `continuous-goals.tsx` 惯例**硬编码中文**，未迁入 `locale-provider.tsx` 的 `TRANSLATIONS`。统一 i18n 为后续独立步骤（需在同一批内一次性迁移 control-plane 系列 + continuous-goals 的硬编码串）。
- **`paused` 态语义（已由主 Agent 裁决并落实）**：paused 目标只能手动 resume 唤醒，显示「待唤醒」是误导——已加护栏：`nextCheck` 对 `status === 'paused'` 直接不渲染下一检查徽章（`continuous-goals.tsx`），并新增回归用例「paused 且 wake 过期也不显示待唤醒」（`continuous-goals.test.tsx`）。
- **未覆盖「预算」徽章**：B04 差距清单里的「预算」项在持续目标卡片上**已有既存 UI**（`第 N / M 轮 · token X / Y` 与恢复上限行），本批未新增预算徽章（避免重复呈现）；预算的**runtime budget-policy 接线**不在本批。
- **生产未重启/未部署**：本批为前端源码 + 合成测试，运行中的驾驶舱仍执行旧代码；新 UI 生效需另行构建部署（`packages/cezar/web/dist`），不属本批授权。
- 未执行真实外呼/生产读写/launchd/服务重启/git；未改任一 `package.json`；未新增依赖。
