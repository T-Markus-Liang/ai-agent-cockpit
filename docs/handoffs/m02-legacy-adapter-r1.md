# 执行交接包：M02/I03c 有期限 legacy adapter 壳（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。

## 批次身份与状态

- batchId / revision：m02-legacy-adapter / r1
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；branch `main`；cwd `/Users/markus/ai-agent-cockpit`；实现由该会话 subagent（deepseek-flash）完成，主 Agent 设计契约、亲自复跑
- 已读并确认协作协议：是。允许写入：runtime/ 新模块、tests/、package.json script、docs/handoffs/、检查点与台账执行条目；四个冻结文件只 import 未改
- 对应：M02 / I03c（第三切片，本包收尾）；固定验收"先存 intent 再 effect、未知 native 启动不重派、不永久双活"全覆盖
- 本批目标：RuntimePort 形状的 legacy adapter 壳 + driver 注入 + 绑定/持久化集成。明确不做：真实 ACP driver（后续切片）、桥侧接管、产品层接线、生产、commit/push

## 固定来源

- base HEAD：`e8c4317`；工作树含 0.3.0 在途历史未提交内容
- 本批文件（SHA256，2026-10-08 冻结）：
  - `runtime/legacy-adapter.mjs`（新增，545 行）`1bb734cc…9332c6`
  - `tests/legacy-adapter.test.mjs`（新增，14 用例）`8042a7b2…fd9023`
  - `package.json`（新增 `test:legacy-adapter` 一行）`7816a59d…25a8da`
- 直接依赖（冻结未改，只 import）：`runtime/route-binding.mjs a5eb6fde…`、`runtime/route-binding-store.mjs 1a5fc542…`
- 依赖：无新依赖（node:sqlite 内置）；测试全 mkdtemp + FakeDriver
- 与前六份交接包无文件交集
- 自测前后 sourceRef 一致

## 实现、自测与证据

| 要求/Case | 当前实现 | 验证命令与 cwd | 退出码/断言/效果 | evidenceRef | 尚未覆盖 |
| --- | --- | --- | --- | --- | --- |
| 先存 intent 再 effect | submit 固定顺序：store.bind → store.planEffect →（幂等短路）→ mapping 落 running → driver.startSession → prompt；测试 1 断言 driver 首次调用前 binding+intent 已持久 | `npm run test:legacy-adapter`（仓库根） | 14/14 pass，exit 0 | 本文件 | 真实 ACP driver 的同一顺序验证（接线切片） |
| 有期限/限定旧待办 | identity 级 expiresAt/allowedTaskIds：scope 外 `legacy-scope-violation`、过期 `binding-expired`，两种拒绝 driver 调用计数均为 0 | 同上 | 测试 2/3 通过 | 同上 | 旧待办实际 drain（P6） |
| 未知启动不重派 | driver 抛错 → intent 已持久、submission=uncertain、抛 `driver-failure`；recover 对 running/uncertain 逐条 driver.status：alive 保留、gone→uncertain；全程 prompt 计数不增 | 同上 | 测试 5/9 通过 | 同上 | uncertain 的人工核对通道（P3/P6） |
| 不永久双活 | 共享同一 store：同 requestKey 已有 pi-durable 绑定时 legacy submit 在 bind 步 `binding-conflict`，driver 零调用 | 同上 | 测试 12 通过 | 同上 | 生产切换现场（T08） |
| V01 执行计数 1 | 幂等：同 requestKey+effectKey 重复 submit 返回同一 submission，startSession/prompt 计数恒 1 | 同上 | 测试 4/11 通过 | 同上 | — |
| abort 作用域 | 仅 `{kind:"submission"}`（driver.kill+cancelled）；goal-wide/execution/conversation → `unsupported-scope`（归属注释写明 pi 侧/goal-runtime） | 同上 | 测试 7/8 通过 | 同上 | — |
| 持久化 | adapter 自有 mapping DB（0600/0700，schema_version=1 fail-closed）；重开完整恢复；createdAt 经 store.resolve 保持稳定（幂等重绑字节一致） | 同上 | 测试 10/14 通过 | 同上 | symlink 防护（同 store 批，后续） |
| 回归 | 相邻套件 | `npm run test:route-binding-store` / `test:route-binding` | 10/10、12/12 pass | 本文件 | — |

- 真实模型/原文外呼/生产读写/原生会话/微信外发：**均未发生**；FakeDriver 全合成。
- 失败、部分结果和不明副作用：无。偏差如实登记：mapping 行先落 running 再调 driver（主 Agent 认可：比契约原文更符合 intent-before-effect）；recover 对非 alive 一律 fail-closed 为 uncertain；测试 9 的悬挂 pending submit 无后续 DB 写。
- 活动进程/job/handle：无。
- 数据守恒、回退和恢复方法：删除两个新文件即完全回退；DB 语义由 SQLite 事务保证。
- 状态分列：实现完成 ✅（本批范围）；自测通过 ✅（主 Agent 亲自复跑）；独立审计：⏳ 待审计 AI；部署/真机：未做。

## 要求审计方做什么

- 审计范围与重点风险：`runtime/legacy-adapter.mjs` 与测试。建议重点：① submit 固定顺序的每个失败出口是否都 driver 零调用或止于 uncertain；② createdAt 稳定化逻辑是否可能被利用绕过 binding-conflict；③ recover 的 fail-closed 边界；④ adapter 自有 DB 与 store DB 的双文件一致性（两个 SQLite 文件，崩溃窗口是否有"store 有 binding、mapping 无行"的孤儿——当前设计：mapping 在 bind/planEffect 之后落，崩溃于两步之间会产生孤儿 binding+intent，这是否可接受，还是需要单库同事务）。
- 已知不足/需决定的方案：上述④的双库原子性是本批最大的设计待定项（选项：并入 store 同一 DB、或接受孤儿 binding 由 recover/drain 核对）；真实 ACP driver 的接口形状建议在下一切片前评审。
- 等待期间将继续的无冲突独立任务：I03d（严格身份/配对/SessionManager broker）探索，或 M02 收尾的联合回归汇总。
- 非返工 revision（r1 为首次交接）。
