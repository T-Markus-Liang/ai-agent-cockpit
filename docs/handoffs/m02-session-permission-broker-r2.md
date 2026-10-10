# 执行交接包：M02 session permission broker r2（按审计 Finding 返工）

回应 [m02-session-permission-broker-r1 审计](../audits/m02-session-permission-broker-r1.md)（CHANGES_REQUESTED）；r1 失败证据保留不覆盖。

## 批次身份与固定来源

- batchId / revision：m02-session-permission-broker / **r2**；状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；返工由 subagent（deepseek-flash）完成，主 Agent 定返工设计、亲自复跑
- 新 hash：`control-plane/session-permission-broker.mjs` `3e6f1d6f…a79806`（原 `3df31722…`）；`tests/session-permission-broker.test.mjs` `891df68e…7db120`（原 `73c312d4…`，14 → 25 用例）

## Finding 逐条回答

### SP-F001（会话关闭后在途审批仍 allow）→ 代际栅栏三边界

- 会话记录新增单调 `generation`（register 为 0，close 时 +1）；请求入场快照代际。
- 三边界栅栏 `stateChanged()`：A) resolver 返回后——命中则 resolver 返回 undefined，D07 不进入消费，零副作用；B) consume 提交前——guarded consume 顶部抛错，真实 consume 从不执行（同步直落路径的最后防线，注释说明）；C) consume 已提交后、返回 permission 前——如实返回 `{outcome:'denied', reason:'consumed-then-closed'}`，审批保持已消费，**不伪造干净的 denied+零副作用**。
- 负例：close 于 resolver 前/等待期间/resolver 已返回 broker 未恢复/consume 已提交后四窗，各窗结果与 Approval 消费计数逐项断言。r1 还原测试：6 项新负例在 r1 代码上失败（缺陷复现确认）。

### SP-F002（同 toolCallId 并发双 allow）→ 首次 await 前预留绑定

- 新增 in-flight 预留表：首次 await **之前**按 (sessionId, toolCallId) 预留并绑定当时冻结的 parametersDigest；同 id 同参并发 → `replay`；同 id 不同参 → 显式 `conflict`；均在 resolver/consume 之前拦截。
- 结算（allow/denied/error）从 in-flight 转入裁决日志；逃逸异常也 fail-closed 烧毁为 `error`（同 id 重试必 replay，无法借重试绕过一次性）；fromJSON 恢复后清空 in-flight 并按 closed/open 重建 generation。
- 负例：同 id 同参/不同参并发、首次 allow/deny/error 后并发、不同 id 合法并行、持久恢复后语义。

## 验证（主 Agent 亲自复跑）

`npm run test:session-permission-broker` 25/25；`npm run test:runtime-policy` 27/27；`npm run test:identity-pairing` 13/13。

## 偏差（如实）

- 边界 B（consume 前）在同步直落路径上外部不可交错，作为最后防线保留并注释；`consumed-then-closed` 以 denied+reason 形态表达（非独立顶层 outcome）；r1 审计探针因行为已变需 r2 新探针（本批测试 19/20 即 r2 负例）。
- 未做（保留）：vendor SessionManager 接线、in-flight 持久化、真实工具/native 会话——与审计"下一包"一致。
