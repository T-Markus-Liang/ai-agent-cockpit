# 执行交接包：M02/I03b 统一 ContextAssembler 纯模块（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。

## 批次身份与状态

- batchId / revision：m02-context-assembler / r1
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；branch `main`；cwd `/Users/markus/ai-agent-cockpit`；实现由该会话 subagent（deepseek-flash）完成，主 Agent 设计契约、决策偏差、亲自复跑
- 已读并确认协作协议：是。允许写入：runtime/ 新模块、tests/、package.json script、docs/handoffs/、检查点与台账执行条目
- 对应：M02 / I03b（第一切片）；验收矩阵 V34（关键值保持部分）、V39（保留上下文来源部分）；修剪 C06（不重复摘要）前置
- 本批目标：纯装配模块 + 合成测试。明确不做：桥侧（`enrichPromptWithMemory`）与 runtime 侧接线、provider/凭据 resolver、真实模型/生产、commit/push

## 固定来源

- base HEAD：`e8c4317`；工作树含 0.3.0 在途历史未提交内容
- 本批文件（SHA256，2026-10-08 冻结）：
  - `runtime/context-assembler.mjs`（新增）`46292658…d944ad`
  - `tests/context-assembler.test.mjs`（新增，9 用例）`f5bec859…9f6654`
  - `package.json`（新增 `test:context-assembler` 一行；叠加在 M01/M02 批次之上）`4285d1f0…9f508d`
- 依赖：无新依赖；纯 ESM、零副作用、无网络/DB/凭据
- 参照（只读未改）：`vendor/wechat-acp/src/bridge.ts:916-931`、`vendor/wechat-acp/src/storage/memory.ts:222-271`
- 与 m01-migration-r1、m02-runtime-ownership-r1 无文件交集
- 自测前后 sourceRef 一致

## 实现、自测与证据

| 要求/Case | 当前实现 | 验证命令与 cwd | 退出码/断言/效果 | evidenceRef | 尚未覆盖 |
| --- | --- | --- | --- | --- | --- |
| 单一注入（C06 前置） | 每类 block 至多一个；conversation 块内 `Earlier excerpt` 段在前、`[Local conversation history]` 逐轮段在后（与桥内 buildLocalContext 同形状）；meta.summaryCount 恒 0/1 | `npm run test:context-assembler`（仓库根） | 9/9 pass，exit 0 | 本文件 | — |
| 关键值保持（V34 部分） | turns 超 maxTurns 丢最旧保最新；含姓名/数值的最新轮次完整；单轮超 turnChars 尾部截断带标记 | 同上 | `key-value retention` 用例通过 | 同上 | 真实语义召回（U/L 级，属 P1/P3 真实验证，不在本批） |
| 来源贯通（V39 部分） | facts 每条保留 `source` 原样 | 同上 | `source passthrough` 用例通过 | 同上 | fallback 场景上下文保持（待 provider resolver 切片） |
| 有界/确定性/校验 | 各段限额 + `…[truncated]` 标记 + meta.truncated/droppedTurns；同输入深度相等；非法输入 TypeError | 同上 | 对应用例通过 | 同上 | — |
| 回归 | 相邻套件 | `npm run test:runtime-contract` / `test:control-plane` | 14/14、21/21 pass | 本文件 | — |

- 真实模型/原文外呼/生产读写/原生会话/微信外发：**均未发生**；纯离线合成。
- 失败、部分结果和不明副作用：无。主 Agent 决策记录：conversation 块内部顺序定为"摘录在前、轮次在后"（与桥内现行形状一致，保证未来接线时 prompt 布局不变）。
- 活动进程/job/handle：无。
- 数据守恒、回退和恢复方法：无状态模块，无数据面；删除两个新文件即完全回退。
- 状态分列：实现完成 ✅（本批范围）；自测通过 ✅（主 Agent 亲自复跑）；独立审计：⏳ 待审计 AI；部署/真机：未做。

## 要求审计方做什么

- 审计范围与重点风险：`runtime/context-assembler.mjs` 与测试。建议重点：① 摘要不重复的结构性保证是否可能被输入绕过；② 截断边界与标记语义；③ 与 `memory.ts` 形状对齐的忠实度；④ DEFAULT_LIMITS 与桥内现行边界（12000/6000 等）是否一致。
- 已知不足/需决定的方案：接线方案（桥侧单入口替换 `enrichPromptWithMemory` vs 包装）建议放下一切片；provider/凭据 resolver 紧随其后。
- 等待期间将继续的无冲突独立任务：I03b 第二切片 provider/凭据引用 resolver 纯模块 + 合成测试（独立新文件，不碰 pi-adapter/contracts）。
- 非返工 revision（r1 为首次交接）。
