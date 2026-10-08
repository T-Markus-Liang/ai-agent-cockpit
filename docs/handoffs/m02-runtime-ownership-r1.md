# 执行交接包：M02/I03a runtime foreground/background ownership 与取消范围（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。

## 批次身份与状态

- batchId / revision：m02-runtime-ownership / r1
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；branch `main`；cwd `/Users/markus/ai-agent-cockpit`；实现由该会话 subagent（deepseek-flash）完成，主 Agent 设计契约、diff 抽查与五套件亲自复跑
- 已读并确认协作协议：是。允许写入：runtime/ 源码、tests/、package.json script、docs/handoffs/、检查点与台账执行条目
- 对应：M02 / I03a；验收矩阵 V09（回归）、V10、V11、V12（部分）、V16（fail-closed 部分）
- 本批目标：runtime 层 ownership 契约 + 三类取消作用域语义 + 全合成测试。明确不做：control-plane 产品层接线（store/goal-runtime 不动）、"当前回合"级取消（SDK 粒度限制，单列后续）、真实模型/生产、commit/push

## 固定来源

- base HEAD：`e8c4317`；工作树含 0.3.0 在途历史未提交内容
- 本批文件（SHA256，2026-10-08 冻结）：
  - `runtime/contracts.mjs`（修改）`d86a2588…0dc9f6`
  - `runtime/pi-adapter.mjs`（修改）`81ebd842…2037f6`
  - `tests/runtime-ownership.test.mjs`（新增，11 用例）`deac3ec7…492b6`
  - `package.json`（新增 `test:runtime-ownership` 一行；叠加在 M01 批次改动之上）`003866d0…661990`
- 直接依赖（未修改）：`runtime/owner-sqlite.mjs`、`runtime/full-sqlite.mjs`、`tests/runtime-contract.test.mjs` 等既有 runtime 套件（历史共享内容）
- 依赖/运行环境：Node 24、`@earendil-works/pi-*@1.0.4`（既有 pin）；无新依赖
- 自测前后 sourceRef 一致（hash 于复跑后冻结）
- 与 M01 批次（m01-migration-r1）无文件交集；两批可独立审计

## 实现、自测与证据

| 要求/Case | 当前实现 | 验证命令与 cwd | 退出码/断言/效果 | evidenceRef | 尚未覆盖 |
| --- | --- | --- | --- | --- | --- |
| ownership 契约 | `REQUEST_FIELDS` 增可选 `ownership`；`assertOwnership`/`normalizeOwnership`/`effectiveOwnership`（旧记录读侧回填 foreground，不改写存储形状） | `npm run test:runtime-ownership`（仓库根） | 11/11 pass，exit 0 | 本文件 | ownership 不进 computeDigest（复用键语义不变；漂移由冲突检查拦截） |
| V10 父等待不杀显式后台 | wait 取消只拒等待者（既有），background 门控长生成跑到 done | 同上 | `V10-wait-cancel-keeps-background-running` 通过 | 同上 | — |
| V11 前台子树取消不杀后台 | conversation scope abort 仅撤 foreground submissions；background 不受影响 | 同上 | `V11-conversation-abort-cancels-foreground-not-background` 通过 | 同上 | SDK 粒度限制：`abortSubmission` 只撤 queued；placed run 含混合输入时不整体清扫（代码内注释披露）；queued-background 在 placed-foreground 被撤后不会被 SDK 重新放置（SDK 行为，已在测试构造中披露） |
| 单 Execution 取消（runtime 打通） | `ABORT_SCOPE_KINDS` 增 `execution`；`abort({kind:"execution",executionId})` 仅撤绑定该 id 的 background submissions；未知 id → `unknown-execution` fail-closed；裸 `{kind:"execution"}` → `unsupported-scope`（保持既有回归）；goal-wide 仍显式拒绝 | 同上 | `execution-abort-cancels-only-bound-id` / `unknown-execution-fails-closed` / `goal-wide-refused` / `execution-abort-after-reopen` 通过 | 同上 | 产品 store 的 Execution cancel 状态机与 adapter 的接线（属 P3/P4 跨层，不在本批） |
| 回归 | 既有四套件 | `npm run test:runtime-contract` / `test:runtime-recovery` / `test:runtime-owner` / `test:runtime-tools` | 14/4/14/19 全 pass，exit 0 ×4 | 本文件 | — |
| "当前回合"级取消 | **未实现**（SDK 仅 conversation 级 abort 与 run-task 粒度） | — | — | — | 需 SDK 能力或 turn 边界设计，建议单列 I03a 后续切片 |

- 真实模型/原文外呼/生产读写/原生会话/微信外发：**均未发生**；全部 fauxProvider + 临时目录 + OwnedStorage 合成环境。
- 失败、部分结果和不明副作用：无；偏差（SDK 粒度限制两处、unsupported-scope 兼容、digest 不含 ownership、读侧回填）已如实登记。
- 活动进程/job/handle：无。
- 数据守恒、回退和恢复方法：mapping 只增可选字段、旧记录形状不变（有测试锁）；拒绝路径 fail-closed 不改写既有记录；recover 后 execution abort 可用（有测试）。
- 日志/私有 artifact 位置：无。
- 状态分列：实现完成 ✅（本批范围）；自测通过 ✅（主 Agent 亲自复跑五套件）；独立审计：⏳ 待审计 AI；部署/真机：未做。

## 要求审计方做什么

- 审计范围与重点风险：`runtime/contracts.mjs` 与 `runtime/pi-adapter.mjs` 的 diff、`tests/runtime-ownership.test.mjs`。建议重点：① conversation abort 的作用域过滤是否可能误伤 background；② `#cancelSubmissions` 的 run-task abort 条件（仅当 run 全为目标 inputs）；③ 未知 executionId 的 fail-closed；④ ownership 归一/回填对旧 mapping 的兼容；⑤ 同 requestId 不同 ownership 的 `request-conflict`。
- 已知不足/需决定的方案："当前回合"级取消的 SDK 能力缺口怎么补；queued-background 在 placed-foreground 撤消后不被重新放置的 SDK 行为是否需要在适配器层补偿；execution abort 与产品 store cancel 的接线归属（建议放 P3）。
- 等待期间将继续的无冲突独立任务：I03b（正式 provider/凭据引用解析、fallback、统一 ContextAssembler）源码与合成测试，与 runtime/contracts/pi-adapter 有少量同文件风险——若审计对本批提出改写要求，会先交 r2 再继续。
- 非返工 revision（r1 为首次交接）。
