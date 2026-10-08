# 执行交接包：M02 runtime ownership r2（按审计 Finding 返工）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包为 r2 revision，回应 [m02-runtime-ownership-r1 审计](../audits/m02-runtime-ownership-r1.md)（CHANGES_REQUESTED）；r1 失败证据保留不覆盖。

## 批次身份与状态

- batchId / revision：m02-runtime-ownership / **r2**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；返工由该会话 subagent（deepseek-flash）完成，主 Agent 定返工设计、亲自复跑
- base HEAD：`e8c4317`（与 r1 审计同基线）

## r2 固定来源（新 hash）

- `runtime/contracts.mjs` `750d9035…d734ed`（原 r1 `d86a2588…`）
- `runtime/pi-adapter.mjs` `8699bf38…376a98`（原 r1 `81ebd842…`）
- `tests/runtime-ownership.test.mjs` `ea12f77a…5854fd`（原 r1 `deac3ec7…`，+10 用例共 21）
- 审计已指出 package.json 多批共享、不形成共同冻结版本，本包不再为其单独背书；测试以 `node --test tests/runtime-ownership.test.mjs` 固定路径执行

## Finding 逐条回答

### M02-F001（前台取消后后台队列停滞）→ 诚实降级修复

- **SDK 调查结论（关键证据）**：`@earendil-works/pi-durable` 无受支持的队列推进 API——queued 输入只在 generation final boundary 被放置（`submissions.js:114-172`、`inbox.js:42-48`），abort handler 不跑 boundary（`generation.js:182-194`），Harness 公共面无驱动队列方法（`types.d.ts:493-527`）；同 requestId 重提交命中早返回不放置（`submissions.js:117-123`）。
- 按主 Agent 设计走**诚实降级**：`observe()` 对无 live run 的 queued submission 如实报 `stalled`（reason `sdk-queue-not-advanced`）；`#cancelSubmissions` 后做 stranded 扫描并把精确 stalled 状态持久化到 mapping（`queueState`，供 recover 对账）；效果计数不增、不新建请求、不返回假成功。
- 新测试：`stopping an active foreground reports queued background submissions as stalled`、`a background already active keeps running when the foreground queues behind it`、`cancellation then recover keeps the exact stalled state durably`。
- **如实声明**：这是诚实降级，SDK 粒度下无法真正"完成"被滞留后台——V11/V12 完整子项仍为开放项（审计已注明降级不足关闭）。

### M02-F002（混合 run 返回 aborted 但前台仍完成）→ 返回值等于实际终态

- `#cancelSubmissions`：run 混合目标与非目标时不 abortTask（不误伤显式后台），run 内 placed 目标如实记 `still-running`；返回结构化 `{result, cancelled, stillRunning, reason}`——完全取消才返回历史串 `"aborted"`，否则 `partial` / `unsupported`（`mixed-run-not-cancellable`）/ `still-running`；execution scope 同规则聚合。
- 新测试：`a placed foreground inside a mixed run is reported still-running, never aborted`、`two executions placed in one mixed run resist a single-execution stop`、`a queued target is withdrawn exactly and a settled target reports aborted`。
- 审计探针镜像（r2）：probe2 返回 `{result:"unsupported", stillRunning:[placed]}`，不再误报 aborted。

### M02-F003（无 Execution 绑定的后台可进入）→ admission 前 fail-closed

- `normalizeOwnership(ownership, topLevelExecutionId)`：background 必须有可解析 executionId——nested 缺失且顶层恰有一个 → 安全归一并记 `executionIdSource:"top-level"`；nested 与顶层不一致 → `ownership-execution-conflict`；均缺 → `missing-execution-binding`；仅 goalId 拒绝。pi-adapter submit 前置 `#assertBackgroundBinding`；旧记录默认 foreground 兼容保持。
- 新测试：`no resolvable execution binding is refused before any effect`、`nested contradicting top-level is refused`、`nested missing is normalized to top-level and is cancellable`、`legacy records stay foreground`。
- 审计探针镜像（r2）：probe3 归一后按顶层 id 取消返回 `"aborted"`，r1 的 unknown-execution 洞已关闭。

## 验证（主 Agent 亲自复跑）

| 套件 | 结果 |
| --- | --- |
| test:runtime-ownership | 21/21（+10 新用例） |
| test:runtime-contract | 14/14 |
| test:runtime-recovery | 4/4 |
| test:runtime-owner | 14/14 |
| test:runtime-tools | 19/19 |

共 72 项零失败。sourceRef 复核：27 个既有冻结文件零漂移（本轮仅上述 3 个文件按审计授权变更）。

## 偏差与保留项（如实）

- F001/F002 为诚实降级非完整关闭：SDK 无推进 API，queued 后台停在 stalled；mixed-run 内 placed 目标无法精确取消（整体 abortTask 会误伤非目标，故选择不取消）。**V11/V12 完整子项与 V10 真实长后台证据（M02-E001）仍为开放项**，需 SDK 能力或 durable 独立 ownership 设计（建议单列后续工作包）。
- 5 个 r1 测试 fixture 因 F003 契约（nested 须与顶层一致）改为一致值；审计原探针 fixture 若原样复跑需同步该值。
- r1 已写入的无 executionId 历史记录仍可读回但不可按 execution 取消（历史缺口，新 admission 已封堵）。
- request 记录新增可选 `queueState` 字段（recover 对账用），旧文档兼容。

## 要求审计方做什么

- 按 Finding ID 复核 r2 diff/hash/负例与探针镜像结果；裁决诚实降级是否满足"返回值诚实"子项（F002）与"如实报告"子项（F001），以及 V11/V12 完整关闭所需的 durable ownership 设计归属。
