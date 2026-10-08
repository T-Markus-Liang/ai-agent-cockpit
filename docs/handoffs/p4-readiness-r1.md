# 执行交接包：P4/B03 真实 Worker 闭环现状地图与施工面（r1，只读探索）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。**本包是只读探索成果，不含代码改动**；B03 实施等审计通过后按图施工。

## 批次身份与状态

- batchId / revision：p4-readiness / r1
- 状态：**READY_FOR_REVIEW（探索）**
- 执行AI：Kimi Code 会话（执行方）；探索由该会话 subagent 完成，主 Agent 核对关键结论
- 对应：B03/P4、M04；T04/T06、V23–31/40/41/47/51

## 核心事实

1. **真实 `session/prompt` 零成功记录**：所有测试用 fake ACP（`source:'fake'`，tests/control-plane.test.mjs:278-325）；capability 探测最远到 Codex 的 initialize/list/load 三步（EXECUTION.md 6.1）；`resume` 全是 advertised 未调用。
2. **launch intent 顺序错误**：executor 在 prompt **完成后**才 `attachExecutionRef`（native-acp-executor.mjs:100-101）——spawn 后崩溃则 store 无任何该次启动的引用。正确顺序在 legacy-adapter 已示范（store.bind → planEffect → 落 running → 才 driver，:369-395）。
3. **executionGuard 形同虚设**：`store.consumeApproval` 支持 account/profile 校验（store.mjs:584），但 executor 调用时没传 guard（native-acp-executor.mjs:97）。
4. **SessionRef 缺 account 字段**（contracts.mjs:116-139），accountId 仅存在于 permission broker 与 store guard——"精确 account/profile/native ID/cwd"无落点。
5. **executor 无条件拒绝一切 ACP tool call**（:45-48 回 -32601）——session-permission-broker（M02-R8）目前无触发路径，V47 接线断在这。
6. **裸 spawn 无 OS 约束**（:30-34 全 env）——native-sandbox（M02-R9，真实执法已验）未接线，V25 native 侧断在这。

## 已有资产（施工时直接复用）

- 入口三件套已存在：HTTP `.../native/plan|prompt`（gateway/control-plane.mjs:181-187）、MCP `plan_native_prompt/prompt_native_session`（server.mjs:229-230）、CLI（scripts/control-plane.mjs:100-105）。
- 并发两道防线：SESSION_LOCKED/SESSION_BUSY（store.mjs:401-405）——但只对带 sessionRefId 的 Execution 生效，plan scope 需扩展。
- 完成门槛与固定验收：completionPlanState（store.mjs:242-291）+ 无 updateTask（验收代码层不可改）+ reviewer.mjs 同 artifact 绑定。
- 兜底语义正确：recoverOnStartup 一律 blocked 不猜测重派（store.mjs:648-669）；Cezar runRef 缺失 → blocked（dispatcher.mjs:38-42）。

## 最小施工面（九步，按顺序）

1. `contracts.mjs` SessionRef 加 accountId（session-index/adapters 填充）；
2. `native-acp-executor.mjs` launch intent 前置（先 attach ref 再 spawn）+ 传 executionGuard；
3. 用现有 CLI/HTTP 在隔离 PERSONAL_AI_OS_STATE_DIR 对 **Codex + OpenCode 的合成隔离会话** 跑通真实 load+prompt（6.1 唯二有真实会话的）；
4. 裸 spawn 换 `native-sandbox.wrapWithSandbox`（先做真实 CLI 间接 exec 探测定 execLiterals）；
5. executor 的 tool call 拒绝路径改接 `session-permission-broker.handlePermissionRequest`（V47 接线）；
6. native cancel 通道（审批绑定 → kill + running→cancelled，对齐 cancelCezarExecution 模式）；
7. plan/approval scope 含 sessionRefId/cwd 使 SESSION_BUSY 生效；GUI 占用检测列显式记录项（V41）；
8. 第二个真实 Worker 做 Reviewer（满足 workerId 独立 + 同 artifact）+ reviewer 只读约束（当前无代码强制）；
9. Evidence 按 completionPlanState 产出（kind=test/command、exitCode=0、artifactRef 匹配），Completion Proof 闭环。

## V/T 缺口速览

T06/V40（两个真实 Worker 合成恢复）**零**；V25 native（裸 spawn）/V47（tool call 全拒）**断点明确**；V23/24/26/27/28/29/30/31/41/51 均为"组件已有、接线待 T04/T06"。

## 要求审计方做什么

- 核本地图；裁决施工顺序与"隔离合成会话"的边界（新建专用会话做 prompt 验证，不触碰用户旧会话）；B03 实施等 P1–P3 接线审计结论。
