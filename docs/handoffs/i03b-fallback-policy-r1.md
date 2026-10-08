# 执行交接包：I03b provider fallback 策略模块（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。

## 批次身份与状态

- batchId / revision：i03b-fallback-policy / r1
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；branch `main`；cwd `/Users/markus/ai-agent-cockpit`；实现由该会话 subagent（deepseek-flash）完成，主 Agent 设计契约、亲自复跑
- 已读并确认协作协议：是。允许写入：runtime/ 新模块、tests/、package.json script、docs/handoffs/、检查点与台账执行条目；vendor/wechat-acp 只参考未改
- 对应：I03b（第四切片，本包收尾）；验收 V39（有界 fallback、保留上下文来源、不换引擎重放）+ V38（auth 不重试风暴）的接口层
- 本批目标：fallback 失败分类/有界尝试/上下文溯源纯模块。明确不做：pi-adapter/桥侧接线、生产、commit/push

## 固定来源

- base HEAD：`e8c4317`；工作树含 0.3.0 在途历史未提交内容
- 本批文件（SHA256，2026-10-08 冻结）：
  - `runtime/fallback-policy.mjs`（新增）`f8a17519…08e6af`
  - `tests/fallback-policy.test.mjs`（新增，12 用例）`b113e8ae…645000`
  - `package.json`（新增 `test:fallback-policy` 一行）`b46f4bc9…518aaf`
- 规则参照（只读未改）：`vendor/wechat-acp/src/acp/session.ts:1034-1068,1374-1412`（桥侧现行候选链与超时降级条件）
- 依赖：无新依赖；纯 ESM、零依赖、无副作用
- 与前十六份交接包无文件交集
- 自测前后 sourceRef 一致

## 实现、自测与证据

| 要求/Case（V39/V38） | 当前实现 | 验证命令与 cwd | 退出码/断言/效果 | evidenceRef | 尚未覆盖 |
| --- | --- | --- | --- | --- | --- |
| 不换引擎重放 | 失败分类：mid_generation_failure/unknown/未识别 kind/timeout 脏（hasProducedMessage 或 hasUsedTools）→ stop uncertain-side-effects / timeout-dirty | `npm run test:fallback-policy`（仓库根） | 12/12 pass，exit 0 | 本文件 | 与 runtime 执行路径的接线（后续切片） |
| 有界 fallback | MAX_AUTOMATIC_ATTEMPTS=1（对齐桥侧"自动重试一次"）；第二次 → stop fallback-exhausted（如实停止不抛错）；scopeKey 独立计数、reset 显式清零 | 同上 | 测试 7/8 通过 | 同上 | 多级链的真实消耗策略（>1 候选时的顺序与预算） |
| auth 不重试风暴（V38） | auth_error → stop auth-failure，不换凭据猜测、不消耗自动尝试 | 同上 | 测试 4 通过 | 同上 | — |
| 保留上下文来源 | buildFallbackContext 深拷贝原上下文（persona/turns/facts 全保留有断言）+ fallback:{from,to,attempt,at} 溯源标记；原上下文已有 fallback 键 → 拒绝而非覆盖 | 同上 | 测试 9 通过 | 同上 | 与 context-assembler 的接线（同后续） |
| 诚实停止 | eligible 分类：startup_error/timeout 干净/protocol_error/rate_limit；每类 reason 明确 | 同上 | 测试 2/3/5/6 通过 | 同上 | — |
| 回归 | 相邻套件 | `npm run test:budget-policy` / `test:provider-resolver` | 13/13、12/12 pass | 本文件 | — |

- 真实模型/原文外呼/生产读写/原生会话/微信外发：**均未发生**；纯离线合成。
- 失败、部分结果和不明副作用：无。实现方 7 处自定决策均 fail-closed 并已审阅认可（未识别 kind 一律不 eligible、fallback 键冲突拒绝、上下文限 JSON 兼容、快照链必须与配置链一致等）。
- 活动进程/job/handle：无。
- 数据守恒、回退和恢复方法：删除两个新文件即完全回退；模块无数据面。
- 状态分列：实现完成 ✅（本批范围）；自测通过 ✅（主 Agent 亲自复跑）；独立审计：⏳ 待审计 AI；部署/真机：未做。

## 要求审计方做什么

- 审计范围与重点风险：`runtime/fallback-policy.mjs` 与测试。建议重点：① 失败分类矩阵与桥侧现行条件（session.ts:1400）的对齐度；② MAX_AUTOMATIC_ATTEMPTS=1 与桥侧 automaticRetryCount<1 的语义等价性；③ buildFallbackContext 的深拷贝/冻结完备性；④ 决策日志无秘密的证明。
- 已知不足/需决定的方案：多候选链（>2）的预算语义（每候选一次还是全局一次）；fallback 与 provider-resolver 的 credentialRef 联动（换候选时凭据引用如何跟随）；桥侧持久会话 id 永不跨 harness 恢复的约束如何在接线层表达。
- 等待期间将继续的无冲突独立任务：I02 剩余两项（活跃原生会话隐私重置、质量UI）设计提案。
- 非返工 revision（r1 为首次交接）。
