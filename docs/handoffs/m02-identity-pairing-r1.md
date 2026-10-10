# 执行交接包：M02/I03d 正式身份配对与凭据生命周期（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。

## 批次身份与状态

- batchId / revision：m02-identity-pairing / r1
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；branch `main`；cwd `/Users/markus/ai-agent-cockpit`；实现由该会话 subagent（deepseek-flash）完成，主 Agent 设计契约、裁决偏差、亲自复跑
- 已读并确认协作协议：是。允许写入：control-plane/ 新模块、tests/、package.json script、docs/handoffs/、检查点与台账执行条目；request-authority.mjs 与 runtime/* 未改
- 对应：M02 / I03d（第一切片）；固定验收"正式配对/撤销；不能把临时手动keyUI当正式配对"；V26（审批/凭据生命周期部分）、V42（token 撤销部分）前置
- 本批目标：配对仪式 + 每客户端凭据生命周期纯模块。明确不做：goals/control-plane 生产接线、goals token 改每客户端凭据、真实 SessionManager broker 装入、OS exec 沙箱、生产、commit/push

## 固定来源

- base HEAD：`e8c4317`；工作树含 0.3.0 在途历史未提交内容
- 本批文件（SHA256，2026-10-08 冻结）：
  - `control-plane/identity-pairing.mjs`（新增）`a27c0df4…b9df6a`
  - `tests/identity-pairing.test.mjs`（新增，13 用例）`fb8f3723…85b9b8`
  - `package.json`（新增 `test:identity-pairing` 一行）`1a6daa6c…afb4fb`
- 兼容契约（只读未改）：`control-plane/request-authority.mjs` 的 principals 结构（:21-33）与角色集（:9，未导出故本地定义并注释来源）
- 依赖：无新依赖（node:crypto 内置）；测试注入确定性 now/random
- 与前七份交接包无文件交集
- 自测前后 sourceRef 一致

## 实现、自测与证据

| 要求/Case | 当前实现 | 验证命令与 cwd | 退出码/断言/效果 | evidenceRef | 尚未覆盖 |
| --- | --- | --- | --- | --- | --- |
| 正式配对仪式 | beginPairing（短码 5 分钟、单次消费、只存 digest）→ completePairing 铸每客户端 token（只返回一次，模块只留 sha256 digest） | `npm run test:identity-pairing`（仓库根） | 13/13 pass，exit 0 | 本文件 | 真实客户端/设备的配对 UX 接线（B04） |
| 撤销与生命周期 | revoke（保留审计记录）、rotate（原子换 digest，旧 token 立即失效）、主体 30 天期限 fail-closed、authenticate 对一切失败返回 undefined 不抛 | 同上 | 对应用例通过 | 同上 | goals/control-plane 生产 token 改每客户端凭据（接线切片） |
| 与严格身份的接口 | exportPrincipals 输出 `{version:1, principals:[{id,role,tokenDigest}]}`，测试 9 直接喂给既有 `createRequestAuthority` 鉴权成功（真接口实证） | 同上 | 接口兼容用例通过 | 同上 | loadRequestAuthority 动态重载（当前启动时一次性载入，改凭据需重启——接线切片决策项） |
| 秘密卫生 | 持久化无明文 token/code（toJSON 字符串断言）；错误消息只含 code/reason；无日志 | 同上 | 卫生用例通过 | 同上 | — |
| 回归 | 既有身份/权限套件 | `npm run test:runtime-policy`（含 request-authority 既有 27 项）/ `test:control-plane` | 27/27、21/21 pass | 本文件 | — |

- 真实模型/原文外呼/生产读写/原生会话/微信外发：**均未发生**；全合成（注入确定性 now/random）。
- 失败、部分结果和不明副作用：无。主 Agent 裁决记录：① pending（未消费）配对码不持久化——5 分钟短码，重启丢失是 fail-safe，攻击面更小，重新 begin 即可；② rotate 不刷新 expiresAt——到期边界独立于轮换，语义更好推理。
- 活动进程/job/handle：无。
- 数据守恒、回退和恢复方法：删除两个新文件即完全回退；模块无生产接线。
- 状态分列：实现完成 ✅（本批范围）；自测通过 ✅（主 Agent 亲自复跑）；独立审计：⏳ 待审计 AI；部署/真机：未做。

## 要求审计方做什么

- 审计范围与重点风险：`control-plane/identity-pairing.mjs` 与测试。建议重点：① pairing code 的单次消费/过期/重放阻断是否有竞态窗口；② timingSafeEqual 的使用完备性；③ 持久化中 digest 的可移植性（跨进程 fromJSON 后是否可被重放利用）；④ 与 request-authority 角色集长期一致性（本地 Set 副本的漂移风险）。
- 已知不足/需决定的方案：pending 配对码不持久化的取舍（主 Agent 已裁）是否认可；roles 统一（HTTP ROLES 缺 agent、MCP HOST_ROLES 含 agent）建议单列 I03d 后续切片；真实 SessionManager broker 装入与 OS exec 沙箱是 I03d 最大的剩余项。
- 等待期间将继续的无冲突独立任务：I03d 第二切片（真实 SessionManager broker 设计）或 M02 联合回归汇总。
- 非返工 revision（r1 为首次交接）。
