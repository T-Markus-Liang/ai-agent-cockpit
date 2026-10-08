# M02 runtime ownership r1 审计：CHANGES_REQUESTED

审计日期：2026-10-08。对象：[执行交接 m02-runtime-ownership-r1](../handoffs/m02-runtime-ownership-r1.md)。

结论：**需修改，不接受本批 ownership/取消能力为完整通过**。五套件 62 项全部通过，但主审专项复现 3 个运行时缺陷。它们阻断 V11/V12 的对应子项与 G2；V10 的真实长后台证据另缺，不能由合成等待测试替代。不冻结其他无冲突工作。

## 身份、版本与范围

- Reviewer：本线程 Codex 主审，未实现本批 ownership delta 或新增 ownership 测试。共享工具/预检等历史参与限制见 [M01 审计](m01-migration-r1.md)。不对所有相邻组件作独立签字。
- 执行方交接声明：Kimi Code、`main`、`/Users/markus/ai-agent-cockpit`，已 ACK 协作协议。没有自动跨 App 消息通道或持续运行 handle 的审计证据。
- base HEAD：`e8c4317201d70e75cabe279da5e7736a9aab20a0`。固定副本位于 `/tmp/personal-ai-os-review-r1.bgwgKU/input`；捕获前后、捕获副本及审结核心文件 hash 均一致，完整清单见 [sourceRef](evidence/2026-10-08-r1/source-ref.sha256)。
- `contracts.mjs`：`d86a2588a88bed900260ddcad771229ec710362f448b2272f06360d18a0dc9f6`。
- `pi-adapter.mjs`：`81ebd8422fcdfa477d38c93074aaa94e685121b6262c9a7a18e6516b0f2037f6`。
- ownership 测试：`deac3ec7518f19284abb3c2370f04b02bce32fa6c58c505aa42b1e9463b492b6`。
- `package.json` 捕获为 `4285d1f0…f508d`，最终核对为 `ff260825…06647`，不等于交接 `003866d0…661990`。M01/M02 均修改该文件，M02 的“无文件交集”不准确。实际用绝对 node/test 路径，不为 live npm 脚本签字；最终完整清单见 [live-final](evidence/2026-10-08-r1/live-final.sha256)。
- 阅读：contracts、pi-adapter、owner/full-sqlite、chief-tools、ownership 与相邻 runtime 测试，以及 SDK 取消/放置边界。未审核所有新 M02 组件、真实模型、全产品 wiring 或真实微信。
- 复测全部是 fauxProvider、真实 SDK/OwnedStorage 加私有合成目录；OS 沙箱拒网络和真实用户目录读写。没有服务重启、生产写入、原生会话操作、微信外发、Git commit/push。
- 原生两路子代理启动失败，没有任何通过结果；本报告是主审实质审查与并行隔离复测，不冒称多位独立 Reviewer 或 Terra 签字。

## 已取得的证据

| 核验 | 实际结果 | 证据 |
| --- | --- | --- |
| Node 所有权/合同/恢复/owner/tools 五套件 | exit 0；62/62，零失败/跳过 | [原始输出](evidence/2026-10-08-r1/runtime-suite.log) |
| 主审 M02 专项缺陷探针 | exit 0；3 个缺陷断言成立 | [探针](evidence/2026-10-08-r1/m02-repros.mjs)、[结果](evidence/2026-10-08-r1/probe-results.json) |

完整命令/沙箱见 [证据说明](evidence/2026-10-08-r1/README.md)。专项 probe exit 0 意味着 r1 的错误已复现，不意味功能成功。

可保留的限定正面证据：无 ownership 的旧记录兼容、ownership drift 请求冲突、独立 conversation 的有绑定 Execution 取消、等待者取消不直接停止 faux 生成，以及 owner/recovery 回归。它们不能覆盖下列缺陷或升级为整批接受。

## 必须修复的 Findings

### M02-F001 — 高 / 阻断：停止活跃前台后，后台队列不再推进

定位：`pi-adapter.mjs:340` 至 `:358` 的 run-task 取消；`:626` 至 `:634` 的前台筛选和返回。

复现顺序：同 owner/conversation，前台先成为 active run，显式有绑定后台随后 queued；取消 conversation 前台。结果 `abortResult=aborted`、前台 `unanswered`、后台仍 `queued`；给后台 500ms 等待窗口超时，faux model callCount 保持 1。后台预置的是可立即完成的短答复，没有后续输入来唤醒队列。

影响：保留后台 row 不等于后台任务能继续。现有 V11 测试只覆盖“后台 active、前台 queued”的相反顺序（ownership 测试 `:195`），漏掉常见前台先跑路径。手册披露 SDK 限制是诚实的，但不能因此认定要求满足。本轮证明合成窗口内停滞，不声称已观察无限时长生产卡死。

返工：将显式后台置于独立 durable execution/conversation ownership，或在适配器单 owner 下补经过证明的 queued 恢复/推进机制。保留同一 Submission/映射/效果键，不能以新请求重派已完成或不明任务。

补测：前台先 active / 后台先 active 两顺序；多条后台队列；取消后无后续消息仍能终态；取消与 close/recover 交错；已完成步骤效果不增加、未取消后台按原授权继续。

### M02-F002 — 高 / 阻断：混合 run 返回已停止，前台实际继续

定位：`pi-adapter.mjs:353` 检出 outside inputs 后不 abort run；`:356` 跳过 run 中的单独 Submission；`:634` 无条件返回 `aborted`（Execution 路径 `:618` 亦返回相同结果）。

复现顺序：使用 `followUpMode='all'`；seed 后台运行时排入前台和另一后台；seed 完成后两者被放入同一 active run。取消 conversation，返回 `aborted`，前台仍为 `placed`，随后前台和后台都正常 `done`。

影响：接口报告成功停止但目标未停止，V11 的“前台子树取消”不成立。测试未运行产品副作用工具，不声称实际发生了越权写入；确定结论是目标模型工作继续，且返回值错误。

返工：用与 SDK 实际任务图对应的隔离 ownership/turn 边界实现目标取消。若某组合暂不能精确取消，必须返回显式 unsupported/partial/still-running 及可核对原因，不得写产品 cancelled 或报告成功；这只是诚实降级，不足以关闭完整 V11/V12。不能为了停前台误伤显式后台。

补测：同 run 混合前后台、两个 Execution 混合、目标已完成/未 placed/已 placed 三状态；scope cancel 的返回值与实际终态逐项一致；非目标持续、取消目标不得继续生成/派发副作用。

### M02-F003 — 高 / 阻断：无 Execution 绑定的后台可进入，却无法按支持范围停止

定位：`contracts.mjs:80` 允许 background executionId/goalId 全部缺失；`:89` 至 `:97` 原样归一；`pi-adapter.mjs:600` 只按 nested ownership.executionId 筛选，不按每个请求必需的顶层 executionId。

实际复现：`ownership={kind:'background'}` 且顶层有 required executionId 被接受并运行。用该顶层 ID 执行取消得到 `unknown-execution`；Submission 取消得到 `already_placed`；conversation 取消返回 `aborted` 但忽略后台。状态一直为 `placed`，直至测试主动释放 faux gate。

影响：产生运行中无可用 scoped cancel 绑定的工作。缺 binding 应在 admission 前拒绝，不能让调用方后来才发现无法取消。

返工：后台须由受信宿主提供明确有效 Execution ownership；对缺失/顶层与 nested 不一致的绑定 fail-closed，或按经过校验的唯一顶层 ID 安全归一。宿主仍须验证真实 Task/Execution/Goal/Grant 关联，元数据自身不是授权。旧记录默认 foreground 的兼容保持。

补测：缺 Execution、仅 goal、nested/top-level 不一致、伪造宿主关联、旧记录、恢复后 scope 绑定；非法输入在模型调用/建 row 之前拒绝，合法后台有准确单 Execution 取消，不扩大到无关任务。

## 缺证据，不是可豁免的需求

- `M02-E001`：V10 固定矩阵要求 L 类真实长后台超交互 cap。当前名为 V10 的测试实际是 U/I 类短 faux wait cancel（本次约 23ms）；只能证明一个等待子断言，不能给真实长任务、预算/期限或 G3 背书。
- `M02-E002`：当前回合级取消、全 Goal owned graph、产品 store cancel wiring、工具授权恢复、真实进展/期限及微信新路径仍未完整实现/核验。已在交接部分披露；保留 I03a/P3/P4 和原 V09–13/16/31/37，不通过改名称或减 case 关门槛。
- `M02-E003`：交新 revision 时修正共享 package 文件交集、列完整 dependencies/hash 与真实执行入口。core hash 未漂移，所以上述缺陷结论仍有效。

## 最小返工与并行建议

- r2 先确定 durable ownership 边界，关闭 F001/F002，随后收紧 F003 admission。避免在同一个活跃 run 上堆更复杂的返回值掩盖 SDK 粒度缺口。
- 每条 finding 给修复 diff、反向负例、实际 SDK 状态与效果计数；异常/未知不填成功，旧失败证据保留。
- provider/context/route 等可继续独立推进，但若写到本批 contracts/pi-adapter，必须交新 hash/revision。本线程不抢写 peer 功能或测试，也不代做产品层接线。
- 生产迁移、真实长任务/微信、服务重启与上线仍按原授权及门槛；本报告不是新的 Grant/Approval。

Jev 只辅助合成措辞越界检测，没有参与本报告工程验收；记录见 [证据说明](evidence/2026-10-08-r1/README.md)。
