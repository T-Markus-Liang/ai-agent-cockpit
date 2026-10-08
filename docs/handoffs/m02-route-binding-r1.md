# 执行交接包：M02/I03c 唯一 route binding 与有期限 legacy 绑定（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。

## 批次身份与状态

- batchId / revision：m02-route-binding / r1
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；branch `main`；cwd `/Users/markus/ai-agent-cockpit`；实现由该会话 subagent（deepseek-flash）完成，主 Agent 设计契约、裁决偏差（fromJSON 时钟无关校验）、亲自复跑
- 已读并确认协作协议：是。允许写入：runtime/ 新模块、tests/、package.json script、docs/handoffs/、检查点与台账执行条目；`runtime/contracts.mjs` 与 `runtime/pi-adapter.mjs` 处于待审计冻结状态，本批未触碰
- 对应：M02 / I03c（第一切片）；验收矩阵 V01/V02（幂等与冲突）、V08（旧待办限定的接口层）、V18/V49（单 owner/不双活的接口层）
- 本批目标：唯一 route binding + 有期限 legacy 绑定 + 完整性字段 + intent 骨架的纯函数库。明确不做：真实路由接管、持久化适配、legacy adapter 本体、产品层接线、生产、commit/push

## 固定来源

- base HEAD：`e8c4317`；工作树含 0.3.0 在途历史未提交内容
- 本批文件（SHA256，2026-10-08 冻结）：
  - `runtime/route-binding.mjs`（新增）`a5eb6fde…63ea16`
  - `tests/route-binding.test.mjs`（新增，12 用例）`7a410c21…632e54`
  - `package.json`（新增 `test:route-binding` 一行；叠加在前批之上）`30f53b93…8bb6c5`
- 依赖：无新依赖；纯 ESM、零副作用、无 IO/网络/文件读写（grep 验证无 import/process/fs/fetch）
- 与前四份交接包无文件交集
- 自测前后 sourceRef 一致

## 实现、自测与证据

| 要求/Case | 当前实现 | 验证命令与 cwd | 退出码/断言/效果 | evidenceRef | 尚未覆盖 |
| --- | --- | --- | --- | --- | --- |
| 唯一绑定/不双活（V49/V18 接口层） | 同 requestKey 二次绑定：全同→幂等返回既有记录（V01）；任一字段不同（含 runtime 不同）→ `binding-conflict`，既有记录不变（V02） | `npm run test:route-binding`（仓库根） | 12/12 pass，exit 0 | 本文件 | 生产 owner/fence 现场（T08，P6） |
| 有期限 legacy（V08 接口层） | legacy 必须有 expiresAt（缺→`legacy-expiry-required`）与非空 allowedTaskIds（缺→`legacy-scope-required`）；resolve 过期→`binding-expired`（不切换不删除）；planEffect 仅放行 scope 内 taskId（外→`legacy-scope-violation`） | 同上 | 对应用例通过 | 同上 | 旧待办的实际 drain 与路由接管（P6） |
| 完整性字段（upgrade.md:103） | codeVersion/interfaceVersion/modelRef/profileId/cwd/authorizationDigest/effectKey 必填且逐项校验；cwd 必须绝对路径 | 同上 | 字段逐项缺失用例通过 | 同上 | 真实代码版本的注入源（接线切片） |
| intent 骨架（先存 intent 再 effect 的接口层） | planEffect 产出 `EffectIntent`（`requiresApproval:true, sideEffects:false` 仿 RoutePlan）；effectKey 不符→`effect-conflict`；同 requestKey+effectKey 重复→幂等同一份（计数恒 1） | 同上 | intent 幂等与冲突用例通过 | 同上 | intent 持久化与 effect 执行（后续切片） |
| 序列化与冻结 | toJSON/fromJSON 往返稳定；篡改拒绝；binding/intent 深冻结；冲突/过期不改注册表。主 Agent 裁决：fromJSON 校验时钟无关——过期是 resolve 读取门不是记录合法性，否则过期后注册表无法恢复 | 同上 | 序列化与冻结用例通过 | 同上 | — |
| 回归 | 相邻套件 | `npm run test:provider-resolver` / `test:runtime-ownership` | 12/12、11/11 pass | 本文件 | — |

- 真实模型/原文外呼/生产读写/原生会话/微信外发：**均未发生**；纯内存合成（含生产状态只读参照：当前 5 个未完成 Task 4 blocked+1 draft，无 uncertain，见探索记录）。
- 失败、部分结果和不明副作用：无。主 Agent 裁决记录：fromJSON 时钟无关校验（保留过期记录的可恢复性与审计线索，读取门在 resolve 处 fail-closed）。
- 活动进程/job/handle：无。
- 数据守恒、回退和恢复方法：无状态模块，无数据面；删除两个新文件即完全回退。
- 状态分列：实现完成 ✅（本批范围）；自测通过 ✅（主 Agent 亲自复跑）；独立审计：⏳ 待审计 AI；部署/真机：未做。

## 要求审计方做什么

- 审计范围与重点风险：`runtime/route-binding.mjs` 与测试。建议重点：① binding-conflict 的逐字段深比较是否完备（嵌套 modelRef/legacyScope 数组）；② 过期语义（`now() >= expiresAt` 的边界）；③ fromJSON 时钟无关校验的取舍是否认可；④ intent 去重键设计；⑤ 与 upgrade.md:101 映射表链路的字段对齐度（runtimeBinding→submissionId→productTaskId… 的后续接线空间）。
- 已知不足/需决定的方案：legacy adapter 本体（包装桥侧现行执行路径）与 route-binding 的持久化适配属后续切片；"旧待办"清单的权威来源（生产 control-plane.json 只读快照 vs 运行时枚举）需在 P6 设计时定。
- 等待期间将继续的无冲突独立任务：I03c 后续切片的现状细化，或转 I03d（严格身份/Goal grant 与 Pi/native OS 环境接线、真实 SessionManager broker、正式配对/撤销）探索。
- 非返工 revision（r1 为首次交接）。
