# 执行交接包：M02/I03b runtime 预算/期限策略模块（r1）+ M02 联合回归

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。

## 批次身份与状态

- batchId / revision：m02-budget-policy / r1
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；branch `main`；cwd `/Users/markus/ai-agent-cockpit`；实现由该会话 subagent（deepseek-flash）完成，主 Agent 设计契约、裁决重签语义、亲自复跑并主持 M02 联合回归
- 已读并确认协作协议：是。允许写入：runtime/ 新模块、tests/、package.json script、docs/handoffs/、检查点与台账执行条目；goal-store.mjs 只参考未改
- 对应：M02 / I03b（第三切片）；验收 V31（预算耗尽/到期不能继续副作用、不能续期限、不能假装成功）的接口层
- 本批目标：runtime 请求级预算/期限策略纯模块 + 合成测试 + 全量联合回归。明确不做：pi-adapter/goal-store 接线、生产、commit/push

## 固定来源

- base HEAD：`e8c4317`；工作树含 0.3.0 在途历史未提交内容
- 本批文件（SHA256，2026-10-08 冻结）：
  - `runtime/budget-policy.mjs`（新增）`96d15371…9d14a86`
  - `tests/budget-policy.test.mjs`（新增，13 用例）`7bc8eb07…1bcd33a`
  - `package.json`（新增 `test:budget-policy` 一行）`c6aa6516…6bbc47`
- 语义参照（只读未改）：`control-plane/goal-store.mjs:13-64,205-216`
- 依赖：无新依赖；纯 ESM、零副作用、注入时钟
- 与前九份交接包无文件交集
- 自测前后 sourceRef 一致

## 实现、自测与证据

| 要求/Case（V31） | 当前实现 | 验证命令与 cwd | 退出码/断言/效果 | evidenceRef | 尚未覆盖 |
| --- | --- | --- | --- | --- | --- |
| 耗尽不能继续副作用 | charge 检查与扣减原子一体：超额 → `budget-exhausted` 且计数器零变化；达上限后 assertActive 拒 | `npm run test:budget-policy`（仓库根） | 13/13 pass，exit 0 | 本文件 | pi-adapter 的预算准入接线（后续切片） |
| 不能续期限 | 模块无任何 extend/renew/increase API（反射断言导出面恰为 grant/charge/assertActive/remaining/settle/toJSON/fromJSON）；同 scopeKey 未 settle 重复 grant → `invalid-grant` | 同上 | 测试 7 通过 | 同上 | — |
| 到期 fail-closed | `budget-expired`（注入 now 越过 expiresAt），到期后 charge/assertActive 均拒 | 同上 | 测试 5 通过 | 同上 | — |
| 不假装成功 | 错误码精确区分 unknown/settled/expired/exhausted；错误消息只含 scopeKey 与数值 | 同上 | 测试 6/12 通过 | 同上 | — |
| 审计与重签 | settle 保留记录；已 settle 可重签为新授权周期且**旧记录完整保留**（主 Agent 裁决，修正了初版"取代"语义）；lookup 活跃优先；同 scope 多条未 settle → `invalid-state` | 同上 | 测试 13 通过 | 同上 | — |
| 隔离与序列化 | 多 scopeKey 互不影响；toJSON/fromJSON 往返、篡改拒绝 | 同上 | 测试 9/10 通过 | 同上 | — |

### M02 联合回归（主 Agent 本批主持，2026-10-08，全量复跑）

| 套件 | 结果 | 套件 | 结果 |
| --- | --- | --- | --- |
| Python memory 联合（memory_*test.py） | 132/132 OK | runtime-recovery | 4/4 |
| memory-service | 85/85 OK | runtime-ownership | 11/11 |
| eval:control-plane | 7/7 | context-assembler | 9/9 |
| test:goals | 60/60 | provider-resolver | 12/12 |
| test:control-plane | 21/21 | route-binding | 12/12 |
| runtime-canary | 9/9 | route-binding-store | 10/10 |
| runtime-owner | 14/14 | legacy-adapter | 14/14 |
| runtime-contract | 14/14 | identity-pairing | 13/13 |
| runtime-settings | 27/27 | session-permission-broker | 14/14 |
| runtime-tools | 19/19 | native-sandbox（真实执法） | 13/13 |
| runtime-policy（含 vendor build） | 27/27 | budget-policy | 13/13 |

Node 合计 316 项、Python 132 项、eval 7 项，全部通过，零失败。覆盖 I03a–d 全部十批交付与既有 D01–D12 组件，无跨批干扰。

- 真实模型/原文外呼/生产读写/原生会话/微信外发：**均未发生**（native-sandbox 的真实 sandbox-exec 仅作用于临时目录与回环）。
- 失败、部分结果和不明副作用：无。主 Agent 裁决记录：已 settle 可重签为新周期，旧 settle 记录必须完整保留（实现修正+测试 13 锁定）。
- 活动进程/job/handle：无。
- 状态分列：实现完成 ✅（本批范围）；自测通过 ✅（主 Agent 亲自复跑全部 21 个套件）；独立审计：⏳ 待审计 AI；部署/真机：未做。

## 要求审计方做什么

- 审计范围与重点风险：`runtime/budget-policy.mjs` 与测试。建议重点：① 原子扣减的边界（> vs >= 的刻意差异）；② 重签语义与审计保留；③ fromJSON 对多记录 scope 的校验完备性。
- 联合回归的使用：本批回归结果可作为前九批联合无干扰的辅助证据；正式审计仍请逐批按 sourceRef 核对。
- 等待期间将继续的无冲突独立任务：I02/P1 记忆生命周期剩余项（更正/冲突/永久擦除）探索，或等审计结论后做接线切片。
- 非返工 revision（r1 为首次交接）。
