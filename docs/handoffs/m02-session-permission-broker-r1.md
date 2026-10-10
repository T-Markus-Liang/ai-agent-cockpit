# 执行交接包：M02/I03d 会话级 ACP 权限桥（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。

## 批次身份与状态

- batchId / revision：m02-session-permission-broker / r1
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；branch `main`；cwd `/Users/markus/ai-agent-cockpit`；实现由该会话 subagent（deepseek-flash）完成，主 Agent 设计契约、裁决偏差、亲自复跑
- 已读并确认协作协议：是。允许写入：control-plane/ 新模块、tests/、package.json script、docs/handoffs/、检查点与台账执行条目；acp-permission-broker.mjs / store.mjs 只 import 未改
- 对应：M02 / I03d（第二切片）；验收 V47（缺/过期/错 digest/未知选项不默认 allow）、V24（审批不可伪造，findApprovalId 可信宿主解析）
- 本批目标：真实 SessionManager 可调用的会话级权限裁决层。明确不做：vendor SessionManager 接线（后续切片）、OS exec 沙箱、生产、commit/push

## 固定来源

- base HEAD：`e8c4317`；工作树含 0.3.0 在途历史未提交内容
- 本批文件（SHA256，2026-10-08 冻结）：
  - `control-plane/session-permission-broker.mjs`（新增）`3df31722…82c6db`
  - `tests/session-permission-broker.test.mjs`（新增，14 用例）`73c312d4…f669db`
  - `package.json`（新增 `test:session-permission-broker` 一行）`9007432b…5abc7c`
- 直接依赖（只 import 未改）：`control-plane/acp-permission-broker.mjs`（D07）、`control-plane/store.mjs`
- 依赖：无新依赖（node:crypto 内置）；测试注入确定性 now/random + 合成 Approval store
- 与前八份交接包无文件交集
- 自测前后 sourceRef 一致

## 实现、自测与证据

| 要求/Case | 当前实现 | 验证命令与 cwd | 退出码/断言/效果 | evidenceRef | 尚未覆盖 |
| --- | --- | --- | --- | --- | --- |
| V47 不默认 allow | 裁决链 fail-closed：unknown-session → session-closed → replay → unsupported-options（非恰为单元素 allow_once）→ unknown-tool-kind → no-approval；任何一环不过即 denied，不选首项不默认放行 | `npm run test:session-permission-broker`（仓库根） | 14/14 pass，exit 0 | 本文件 | 真实 ACP `session/request_permission` 流程的端到端验证（vendor 接线切片） |
| V24 审批不可伪造 | 委托 D07：approvalId 只经注入 findApprovalId（可信宿主解析，模型给的永不采用）+ consumeApproval requireOperator；无有效审批 → no-approval 且 store 逐字节不变 | 同上 | 测试 5/11 通过 | 同上 | — |
| 一次性语义/防探测 | 同 (session, toolCallId) 任何裁决（含 denied）即烧掉，重放 → denied replay 且不触碰 store；主 Agent 裁决：烧全部裁决而非仅 allow——防"换 options 形状反复探测" | 同上 | 测试 4 通过（consumeApproval 计数不增） | 同上 | — |
| 会话生命周期 | registerSession（8 字段逐校验，字段名以 D07 的 ownerId/accountId/profileId 为规范，接受别名归一）、closeSession（保留审计）、关闭后 denied | 同上 | 测试 1/3/8 通过 | 同上 | — |
| 决策日志 | digest 级（parametersDigest，不存 rawInput 原文）、可按 session 过滤、序列化往返完整、恢复后重放仍拒 | 同上 | 测试 9/10 通过 | 同上 | 日志持久化到磁盘（接线切片决定归属） |
| 回归 | 既有身份/权限套件 | `npm run test:runtime-policy` / `test:identity-pairing` | 27/27、13/13 pass | 本文件 | — |

- 真实模型/原文外呼/生产读写/原生会话/微信外发：**均未发生**；全合成。
- 失败、部分结果和不明副作用：无。主 Agent 裁决记录：① binding 字段名以 D07 的 ownerId/accountId/profileId 为规范（契约文本与 D07 实际字段不一致，实现方别名归一正确）；② 任何裁决（含 denied）都烧 toolCallId（fail-closed 防探测）。
- 活动进程/job/handle：无。
- 数据守恒、回退和恢复方法：删除两个新文件即完全回退；denied 路径零 store 副作用（有测试锁）。
- 状态分列：实现完成 ✅（本批范围）；自测通过 ✅（主 Agent 亲自复跑）；独立审计：⏳ 待审计 AI；部署/真机：未做。

## 要求审计方做什么

- 审计范围与重点风险：`control-plane/session-permission-broker.mjs` 与测试。建议重点：① 裁决链的顺序与每环的零副作用保证；② replay 判定覆盖所有裁决类型的取舍；③ 与 D07 委托边界的完整性（是否有路径绕过 findApprovalId/consumeApproval）；④ 决策日志 digest 是否可逆推敏感内容。
- 已知不足/需决定的方案：vendor SessionManager 接线点（`vendor/wechat-acp/src/acp/client.ts` 的 requestPermission 调用本层）涉及 vendor 改动，建议单独切片+专项审计；决策日志的持久化归属（内存 vs 控制面事件流）；roles 统一（HTTP/MCP agent 角色不一致）仍未排期。
- 等待期间将继续的无冲突独立任务：I03d 剩余最大项——native OS exec 沙箱（V25）设计探索，或 M02 联合回归汇总。
- 非返工 revision（r1 为首次交接）。
