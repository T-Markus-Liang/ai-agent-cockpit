# 执行交接包：P3 / Wave 2.4 `/消息` 六类显示补齐（r1）——"验收中"显示层派生

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双 AI 协作协议](../plans/0.3.0-collaboration.md)。本包逐条回应 [p3-readiness-r1](p3-readiness-r1.md) 第 33 行识别的 **`/消息` 六类显示 3.5/6：缺"后台"与"验收"两类**，其中"后台"类已在上一批（Wave 2.3）备好数据源并加了 label，本批补齐**"验收"类**（显示层派生，不改收件 record schema）。

## 批次身份与状态

- batchId / revision：p3-message-six-categories / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行 AI：Kimi Code 会话（执行方）；branch `feat/0.3.0-progress`；cwd `/Users/markus/ai-agent-cockpit`；subagent（deepseek-flash）实现，主 Agent 定稿设计合同、亲自复跑
- 已读并确认协作协议：是。本批允许写入且实际写入：`vendor/wechat-acp/src/bridge.ts`、`vendor/wechat-acp/tests/bridge-message-reviewing.test.ts`（新文件）、`docs/handoffs/p3-message-six-categories-r1.md`（新文件）。**未改** `package.json`（仓库根与 vendor）、`docs/audits/**`、`docs/plans/**`、`control-plane/**`、任何生产服务/launchd/真实用户文件；**未执行任何 git 命令**；**未新增任何依赖**
- 对应：B02/P3；p3-readiness-r1:33 / :45（"`/消息` 六类显示"缺"验收"）
- 本批目标：在 `/消息` 显示层补齐"验收中"一类。明确不做：真实微信收发、起真实控制面服务、生产重启/部署、**新增状态持久化**（不改 inbox record schema）、`/acp-more` 或其它 handler 改动、任何 git 操作
- vendor 说明：`vendor/wechat-acp/` 目录**无**自己的 `AGENTS.md`，故遵循仓库根 `AGENTS.md`；使用 vendor 自带测试 runner `node --import tsx/esm --test 'tests/**/*.ts'`，不新增依赖

## 固定来源

- base HEAD：`0067a284639da90e81e1884085d7617c34149acb`（读 `.git/HEAD` 与分支 ref 得到；**未执行任何 git 命令**）
- 变更文件（SHA256，2026-10-08）：
  - `vendor/wechat-acp/src/bridge.ts` `4358e999f13ef8f43acc36e505bc55dbdbeaf85008ba47d78002320d33cc9c6f`（2486 行 → 2520 行；仅新增 1 个 import 类型 + `/消息` handler 3 行改 + 新增私有方法 `resolveReviewingReceiptIds`）
  - `vendor/wechat-acp/tests/bridge-message-reviewing.test.ts` `4ead14748134c0e21d3d617d28361cc5db244a677c7ddd73185aaf66cf1897bc`（新文件，247 行，**10 个 test（含 3 个子用例）全绿**）
  - `docs/handoffs/p3-message-six-categories-r1.md`（本文件，新）
- `control-plane/store.mjs` **确认为只读核对**：task 状态枚举中"验收"两类确切字符串为 **`verifying`**、**`reviewing`**（store.mjs:18 `ACTIVE_EXECUTION_STATUSES`；:22-23 `TRANSITIONS` verifying→reviewing→succeeded/failed/blocked；:464-465 依 execution 状态回写 `task.status = 'verifying' | 'reviewing'`）。本批**未改**该文件
- `package.json`（仓库根与 vendor）均**未改**；复用既有脚本：`test:runtime-policy` = `npm --prefix vendor/wechat-acp run build && node --test tests/request-authority.test.mjs …`；vendor `test` = `node --import tsx/esm --test 'tests/**/*.ts'`
- 依赖：无新依赖（仅复用既有 `fetch` + `AbortSignal.timeout`，与 `reconcileLinkedTask` 同款）
- 构建产物：按要求跑了 `npm --prefix vendor/wechat-acp run build`（`tsc`，strict），exit 0；`vendor/wechat-acp/dist/` 为既有构建步骤产物（非源码改动）
- 自测前后 sourceRef 一致；只有上列 2 个源/测试文件按授权变更（`bridge.ts` 逆向变异实验已字节级还原并校验 SHA256）

## 六类口径映射表（P3 六类 + 新增两类）

P3 地图（p3-readiness-r1:33）原文六类口径：**running / uncertain / failed / reply_pending / queued / retry_wait**；本波新增 **后台（background）/ 验收（verifying+reviewing）** 两类。`/消息` 现有 label 与它们的映射如下：

| P3 口径 | `/消息` 现有 label（bridge.ts:570） | 数据源 | 本批变化 |
| --- | --- | --- | --- |
| queued | `queued: '排队'` | receipt.status | 未改 |
| running | `running: '处理中'` | receipt.status | 未改 |
| retry_wait | `retry_wait: '等待自动重试'` | receipt.status | 未改 |
| uncertain | `uncertain: '中断/待核对'` | receipt.status | 未改 |
| failed | `failed: '未能处理/待核对'` | receipt.status | 未改 |
| reply_pending | `reply_pending: '对话已结束/回复待补发'` | receipt.status | 未改 |
| **后台（新增，Wave 2.3）** | `background: '后台执行中'` | receipt.status（Wave 2.3 起有数据源） | 本批未改（已存在） |
| **验收（本批新增）** | 追加 `，任务验收中`（**显示层派生，无持久化状态**） | 控制面 task.status ∈ {`verifying`,`reviewing`} | **本批新增** |
| （非六类，辅助态） | `received: '已保存'`、`done: '对话已结束'`、`buffered: '缓冲'`、`cancelled: '已取消'` | receipt.status | 未改 |

**语义重叠如实说明**（写入审计）：
- `uncertain`（中断/待核对）与 `failed`（未能处理/待核对）两 label 均含"待核对"字样，语义高度重叠，均为"不确定终态"；本批未动，若要拆分请单列。
- `reply_pending`（对话已结束/回复待补发）与 `done`（对话已结束）共享"对话已结束"字样。
- **"验收中"不是第六条持久化状态**，而是叠加在任一 base label 之上的显示层覆盖（可同时出现在 running / background / reply_pending / uncertain 等任意行的行尾）。这与"六类互斥"的直觉不同，属**有意设计**：验收与否由**控制面 task 状态**决定，而非 receipt 自身状态决定，故 receipt 状态机不新增枚举、schema 不变（合同第 1 条"不引入新状态持久化"）。

## 合同逐条

### (1) "验收中"数据源 —— 显示层派生

- **插入点**：`bridge.ts` `/消息` handler（改前 :568-575）。渲染最近 5 条记录**之前**：
  - `const displayed = records.slice(-5);`
  - `const reviewing = await this.resolveReviewingReceiptIds(displayed);`
  - 每行追加：`${labels[record.status] ?? record.status}${reviewing.has(record.id) ? '，任务验收中' : ''}`
- **匹配键**：`record.execution?.groupIds?.[0] ?? record.id`（与 `reconcileLinkedTask`（改前 :924）完全一致的 `sourceRequestId` 口径）。
- **判定**：`GET {controlPlaneUrl}/api/control-plane/tasks?sourceRequestId=<id>&limit=50`，对返回 `tasks[]` 中 `sourceRequestId === 查询键` 的子集，**任一** task `status === 'verifying' || 'reviewing'` → 该 record 行显示"验收中"。
- **completed → 维持现有 label**：判定只认 verifying/reviewing；`completed`、`failed`、`blocked`、`cancelled`、`draft`、`planned` 等一律**不**触发"验收中"。完成态由既有 `reconcileLinkedTask` 补发路径负责，`/消息` 不重复。
- **无关联任务 → 维持现有 label**：`tasks[]` 为空或全部 `sourceRequestId` 不匹配 → 不改 label。
- **去重 + 有界预算**：按 `sourceRequestId` 归并为 `Map`，`slice(0, 5)` 上限 → 单次渲染最多 5 次 query；展示已 slice(-5)，故天然 ≤5。每 query 带 `limit=50`。
- **失败静默降级**：复用 `reconcileLinkedTask` 三件套——**loopback 白名单**（`['127.0.0.1','localhost','[::1]'].includes(base.hostname)`，非 loopback 直接返回空集、不发起请求）、`AbortSignal.timeout(3000)`、**`try/catch` 失败即不改 label**。查询失败/超时/非 2xx/JSON 畸形 → 该 record 按原 label 显示，**绝不伪造验收状态**。
- **无新持久化**：`resolveReviewingReceiptIds` 只返回 `Set<string>`（本渲染需要追加 label 的 record id），不写任何文件、不改 `MessageInboxRecord`/`ExecutionCheckpoint` schema、不加 receipt 状态枚举。

### (2) 六类口径核对
见上"六类口径映射表"。

### (3) 测试
见"反向负例清单"与"验证"。

### (4) 交接包
本文件。

## 关键 diff 摘要

1. `vendor/wechat-acp/src/bridge.ts`
   - import（:54）：`import { MessageInbox, type MessageInboxStatus } from …` → 追加 `type MessageInboxRecord`。
   - `/消息` handler（:568-576）：`records.slice(-5).map(...)` 拆为 `displayed` + `await this.resolveReviewingReceiptIds(displayed)` + 行尾追加 `'，任务验收中'`。`labels` 表、`outgoing`/`blocked` 补发段文案、`sendReply` 调用**逐字未动**。
   - 新增私有方法 `resolveReviewingReceiptIds(records: MessageInboxRecord[]): Promise<Set<string>>`，紧随 `reconcileLinkedTask` 之后（:946-970），与 `flushReplyOutbox` 之间。含上述判定/去重/loopback/超时/降级逻辑。
   - 行尾：`bridge.ts` 为**既有混合行尾**（文件级 1814 处 CRLF + 672 处 LF）。本批 `/消息` handler 与 `reconcileLinkedTask` 邻域**本就是 LF**，插入行采用 LF，与该区域一致；**未整文件改写行尾**（避免噪声 diff）。`tsc` strict 与运行时均无影响。
2. `vendor/wechat-acp/tests/bridge-message-reviewing.test.ts`（新）：进程内假 HTTP 控制面 + `fs.mkdtemp` 合成收件箱；10 test 覆盖 7 场景（见下）。`ProbeBridge` 覆写 `sendTextSegment` 在网络边界捕获 `/消息` 回复文本；`config.inbound.enabled=true`+`config.recovery=undefined` 使桥有真 `MessageInbox` 但无 `ReplyOutbox`，`/消息` 回复直通捕获点。

## 反向负例清单与原始结果摘要

新增用例覆盖（全为 tmp 合成夹具 + 进程内假控制面，**未接真实微信、未起真实控制面服务、无网络外发**）：

| 场景 | 假控制面返回 | 断言 |
| --- | --- | --- |
| verifying | task.status=`verifying` | 显示含"任务验收中"；恰好 1 次 query；query 键=receipt id |
| reviewing | task.status=`reviewing` | 同上 |
| completed | task.status=`completed` | **不**显示"任务验收中"；仍保留"处理中" |
| 无任务 | tasks=[] | 不显示；保留"处理中"；query 仍发生 1 次 |
| 控制面不可达 | loopback 端口已关闭 | 不显示；保留"处理中"；不伪造 |
| 控制面超时 | 服务端延迟 5000ms（>3s 预算） | 不显示；保留"处理中"；不伪造 |
| 非 loopback | `http://example.invalid:4324` | 不显示；**完全不发起请求**（白名单短路） |
| 未配置控制面 | `controlPlaneUrl=undefined` | 不显示；**请求数=0** |
| 批量去重 | 两条 receipt 共享 `sourceRequestId`（`execution.groupIds=[primary, secondary]`） | **仅 1 次 query**；两行**都**显示"任务验收中" |

**承重验证（逆向变异）**：为证明新负例**承重**而非仅正例通过，对 `vendor/wechat-acp/src/bridge.ts` 做**一处逆向变异**（先把原文件复制到 `/tmp/bridge.ts.bak` 作字节级备份，改后从备份还原并核对 SHA256 一致——**未使用 git**）：把 `resolveReviewingReceiptIds` 内判定 `task.status === 'verifying' || task.status === 'reviewing'` 替换为 `task.status === 'MUTANT_never'`（即"永不判定验收中"），重跑 `tests/bridge-message-reviewing.test.ts`：

| 变体 | 变异 | 结果（同一测试文件） |
| --- | --- | --- |
| original（本轮源码） | 无 | **10 tests / 10 pass / 0 fail** |
| mutant | 判定 → `=== 'MUTANT_never'` | **6 pass / 4 fail** |

mutant 下失败的 4 条（原始断言输出）：

- `verifying` → `AssertionError [ERR_ASSERTION]: scenario=verifying reply=20:11:44：处理中`
- `reviewing` → `AssertionError [ERR_ASSERTION]: scenario=reviewing reply=20:11:44：处理中`
- `… deduplicates sourceRequestId queries …` → `AssertionError: both receipt lines show 验收中: 20:11:47：处理中`
- 父用例 `/消息 shows 验收中 for verifying and reviewing linked tasks, and not for completed` 随之失败

结论：verifying/reviewing/去重 3 组正例精确捕获"验收判定被移除"这一回归；completed/无任务/不可达/超时/非 loopback/未配置 6 组负例在 mutant 下仍通过（符合预期——它们断言的是"不显示/不请求"）。还原后 `bridge.ts` SHA256 与备份逐字一致（`4358e999…c9c6f`），无 `MUTANT` 残留。

## 验证

| 要求/Case | 实现 | 验证命令与 cwd | 结果 |
| --- | --- | --- | --- |
| verifying/reviewing → "验收中" | 判定 verifying∪reviewing + 行尾追加 | `node --import tsx/esm --test tests/bridge-message-reviewing.test.ts`（vendor） | ✅ 2 子用例通过 |
| completed → 维持原 label | 判定不认 completed | 同上 | ✅ 子用例通过 |
| 无任务 → 原 label | tasks=[] 不追加 | 同上 | ✅ 用例「…keeps the original label when no linked task exists」 |
| 不可达/超时 → 不伪造 | `try/catch` + 3s 超时 | 同上 | ✅ 2 用例（含 3033ms 超时用例） |
| 非 loopback / 未配置 → 不请求 | 白名单/空值短路 | 同上 | ✅ 2 用例（断言请求数=0） |
| 多记录批量去重 | `Map` 归并 + slice(0,5) | 同上 | ✅ 用例「…deduplicates sourceRequestId queries…」（hit=1、两行均显示） |
| 单测零回归 | — | `node --import tsx/esm --test tests/bridge-message-reviewing.test.ts` | ✅ **10/10 pass** |
| vendor 整包零回归 | — | `node --import tsx/esm --test 'tests/**/*.ts'`（vendor） | ✅ **tests 366 / pass 365 / fail 0 / skipped 1**（改前 356；+10） |
| vendor 类型构建 | `tsc` strict | `npm --prefix vendor/wechat-acp run build`（仓库根） | ✅ exit 0 |
| 仓库运行时策略门（含 vendor build） | — | `npm run test:runtime-policy`（仓库根） | ✅ **39/39**，exit 0 |
| 仓库密钥扫描门 | — | `npm run audit:secrets`（仓库根） | ✅ **PASS: 0 undispositioned credential-shaped hits** |
| 逆向变异承重 | mutant 重跑 | 见"反向负例" | ✅ 4 条正例在 mutant 下精确失败；还原 SHA256 一致 |

- 真实模型/原文外呼/生产读写/launchd/微信收发/真实外发/真实控制面服务：**均未发生**。全部为进程内假 HTTP server + tmp 合成夹具；未 chmod 任何真实用户文件。
- 失败、部分结果和不明副作用：无。sourceRef 复核：仅上列 2 文件按授权变更；`bridge.ts` 变异实验已还原并校验 SHA256。
- 活动进程/job/handle：测试 `t.after` 统一 `bridge.stop()` + `server.close()` + `fs.rm` 临时目录，无遗留定时器。
- 状态分列：实现完成 ✅（本批范围）；自测通过 ✅；独立审计：⏳ 待审计 AI；部署/真机：**未做**（生产服务仍跑旧代码）。

## 要求审计方做什么

- 按 **p3-readiness-r1:33/:45 "缺'验收'类"** 复核本批 diff / 新 hash / 负例与反向变异结果。重点：① 判定是否**只**认 `verifying`/`reviewing`（`completed` 不触发验收中，避免与既有补发路径重复）；② 是否复用 `reconcileLinkedTask` 的 **loopback-only + AbortSignal.timeout(3000) + 失败静默降级** 三件套，且任何异常都不伪造验收状态；③ `sourceRequestId` 口径是否与补发路径一致（`groupIds?.[0] ?? id`）；④ 去重与「≤5 query」预算是否落实；⑤ **确实未引入新持久化**（无 schema 变更、无新状态枚举）。
- 非返工前请确认：本包未触碰 `package.json`、`docs/audits/**`、`docs/plans/**`、`control-plane/store.mjs`；`/消息` 既有 label 表与补发段文案未改。
- 等待期间继续的无冲突独立任务：p3-readiness 中"派发窗口"等其它 T 项。

## 未覆盖项与诚实边界声明

- **真实微信抽验属 Markus/B02 验收**：本批只改代码 + 合成测试，**未**接真实微信、未发真实消息、**未起真实控制面服务**。"验收中"在真实微信 + 真实控制面上的端到端显示效果**未经真机验证**，需 Markus/B02 在验收环境抽验。
- **生产未重启/未部署**：已在跑的服务仍执行旧代码；本轮为源码 + 合成测试，生产重启/部署另批，本包 READY 不授予该权限。
- **"验收"是显示层派生、非持久状态**：控制面不可达时，即使某 task 实际正处于 verifying/reviewing，`/消息` 也会按原 label 显示（宁缺毋滥、绝不伪造）。这是有意的 fail-closed 行为，但意味着**离线/故障窗口内"验收中"可能不漏出**。
- **"验收通知主动推送"不在本批**：本批只在用户主动发 `/消息` 时派生显示，**不**新增"任务进入验收即主动推给用户"的通道；后者需任务/权限接线，另批（p3-readiness 的其它 T 项）。
- **超时边界**：判定预算为单 query 3s；若控制面/网络在高负载下 >3s 未答，该行按原 label 显示（与 `reconcileLinkedTask` 同款降级，语义一致）。
- **语义重叠未消解**：见"六类口径映射表"——`uncertain`/`failed` 的"待核对"重叠、`reply_pending`/`done` 的"对话已结束"重叠均为既有文案，本批**未**改动，如需收敛请单列。
- **行尾**：`bridge.ts` 为既有混合行尾，本批插入行为 LF，未整文件归一化；如后续有行尾统一策略，请单列。
- 未执行真实外呼/生产读写/launchd/微信外发/服务重启/git；未改 `package.json`。
