# 执行交接包：M02/I03c 唯一 route binding 与有期限 legacy 绑定（r2，按审计 Finding 返工）

回应 [m02-route-binding-r1 审计](../audits/m02-route-binding-r1.md)（CHANGES_REQUESTED）。r1 交接与证据保留不覆盖；本文件为**新文件**，与同域的 [route-binding-store r2](m02-route-binding-store-r2.md) 同批返工。

## 批次身份与状态

- batchId / revision：m02-route-binding / **r2**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；branch `feat/0.3.0-progress`；cwd `/Users/markus/ai-agent-cockpit`；返工由该会话 subagent（deepseek-flash）实现，主 Agent 定返工契约、裁决偏差、亲自复跑
- 已读并确认协作协议：是。允许写入：`runtime/route-binding.mjs`、`tests/route-binding.test.mjs`、docs/handoffs/、docs/audits/evidence/。**未改** package.json（script 已在此前批次存在）；**未触碰** contracts.mjs / pi-adapter.mjs / 上一版交接 / r1 证据
- 对应：M02 / I03c（第一切片）；验收矩阵 V01/V02（幂等与冲突）、V08、V18/V49 的接口层
- 本批目标：按 RB-F001 把「影响 effect/Approval 的 task 与完整参数」绑定进不可变 intent 身份与幂等比较；同 key 不同 body 一律 conflict，恢复禁止 last-wins。明确不做：真实路由接管、持久化适配（另文件）、legacy adapter 本体、生产、commit/push

## 固定来源

- base HEAD：未在本批核验（本批**未执行任何 git 命令**）；工作树为 `feat/0.3.0-progress` 在途未提交内容
- 本批文件（SHA256，2026-10-08 冻结，**完整哈希**）：
  - `runtime/route-binding.mjs`（修改）`5148669a0baff140f477dc9f6b38d352892a0f6d3efa2427cb5922a331168d4a`（r1 `a5eb6fde…63ea16`）
  - `tests/route-binding.test.mjs`（修改，12 → 15 用例）`32c516da71076f8af7661cac94dec2690f102168ba25986db613e025df41aa8e`（r1 `7a410c21…632e54`）
  - `package.json`（**未改**）`b46f4bc95650da0b217ede96cc6b5733acab9ceb0ec5666c2a35c31da5818aaf`
- 直接依赖：无新依赖；纯 ESM、零副作用、无 IO/网络/文件读写（仍无 import/process/fs/fetch）
- 全部 sourceRef（含 evidence 日志哈希）见 [source-ref.sha256](evidence/2026-10-08-rb-rbs-r2/source-ref.sha256)
- 自测前后 sourceRef 一致（同一冻结副本复跑）
- 历史共享未提交内容（0.3.0 在途）与本批新增的区别：本批仅改上述两个文件

## Finding 逐条回答

### RB-F001（中 / ID 一致性：task 变化不冲突，恢复重复 intent 静默覆盖）→ 已修复

- **根因**：`planEffect` 的 intent 槽位键只有 `requestKey + effectKey`，命中即 `return existing`（r1 :310–315）；`restore` 对同键 `intents.set(...)` 直接覆盖（last-wins，r1 :378）。task/参数不参与身份与幂等比较。
- **修复**：
  1. 新增 `intentIdentity(intent)`：对 intent 的**全部字段**做 canonical 序列化（键排序的 JSON），把 `taskId`（`buildIntent` 仅在提供时写入）纳入身份。省略 task 与提供不同 task 因此永不互相别名。
  2. `planEffect`：命中同槽位时，canonical 身份相同 → 幂等返回同一冻结对象；**不同 → 抛 `RouteBindingError("intent-conflict")`**，在 `intents.set` 之前抛出，**零状态变化、原 intent 不变**。
  3. `restore`：同键同值 → `continue`（幂等跳过）；同键不同值 → 抛 `RouteBindingError("intent-conflict")`（含冲突明细措辞），**禁止 last-wins**。与 `bind` 侧「同键不同值 → binding-conflict」对称。
  4. task 规范化：`buildIntent` 对 `undefined` 省略 `taskId`；显式 `undefined` 与省略归一为同一 body（比较相等、幂等）；非空字符串校验不变。
- **理由**：审计复现场景（allowlist 含 t1/t2，先 planEffect(t1) 再同 key 请求 t2 返回 t1 且不告知；快照追加同 key、task=t2 的另一合法 intent 被静默取最后）现在分别得到 `intent-conflict` 与 `intent-conflict`，不再有静默复用/不确定恢复。

### 关键 diff 摘要（route-binding.mjs）

- `+ intentKeyString(requestKey, effectKey)`：槽位键 = `JSON.stringify([ownerId, sourceRequestId, effectKey])`。
- `+ intentIdentity(intent)`：`Object.keys(intent).sort()` 后序列化，含 `taskId`。
- `planEffect` 尾部：`existing !== undefined` 时按身份相等返回旧对象，否则抛 `intent-conflict`（原为 `if (existing) return existing`）。
- `restore` intent 循环尾部：同键同值 `continue`；同键不同值抛 `intent-conflict`（原为无条件 `set`，last-wins）。
- 头注释：契约（planEffect）与设计意图第 4 点补充「intent 身份含完整 task/参数；恢复拒绝矛盾重复」。

## 反向负例清单与原始结果摘要

新增 3 条固定负例（`tests/route-binding.test.mjs`），逐条对应审计复现路径：

| 负例 | 断言 | 审计复现 | r2 结果 |
| --- | --- | --- | --- |
| RB-F001: two in-scope legacy tasks on the same request+effectKey conflict (no silent reuse) | 同 key 请求 t2 → `intent-conflict`；`toJSON` 快照前后逐字段相等；原 intent 仍返回 | 「先 t1 再 t2 返回原对象不告知冲突」 | 通过 |
| RB-F001: an omitted task and an explicit task are distinct intent bodies | 省略 task 幂等；显式 `undefined` 归一相等；显式 t9 → `intent-conflict` 且零变化 | 「task 缺省 vs 显式、重复幂等」 | 通过 |
| RB-F001: fromJSON rejects a contradictory duplicate intent and skips an identical one | 相同重复 intent 幂等跳过（count=1）；同 key 不同 in-scope task 追加 → fromJSON 抛 `intent-conflict` | 「快照追加同 key、task=t2 被静默取最后」 | 通过 |

**负例的负例证据（r1 代码上必失败）**：把修复逆向回退到 r1 逻辑的临时副本上运行本套件 → `tests 15 / pass 12 / fail 3`，**恰好这 3 条新负例失败**；原始日志 [route-binding-negative-on-prefix.log](evidence/2026-10-08-rb-rbs-r2/route-binding-negative-on-prefix.log)。证明负例确实锚定缺陷，而非恒真。

## 实现、自测与证据

| 要求/Case | 当前实现 | 验证命令与 cwd | 退出码/断言/效果 | evidenceRef | 尚未覆盖 |
| --- | --- | --- | --- | --- | --- |
| RB-F001 同 key 不同 task 冲突 | `intent-conflict`，零状态变化 | `npm run test:route-binding`（仓库根） | **15/15 pass，exit 0** | [route-binding-r2.log](evidence/2026-10-08-rb-rbs-r2/route-binding-r2.log) | 实际 Execution/Approval 映射另验 |
| RB-F001 恢复唯一性 | 同值幂等跳过、异值 `intent-conflict` | 同上 | 对应用例通过 | 同上 | — |
| r1 原契约回归 | binding 冲突/过期/scope/冻结/序列化 | 同上 | 12 条原用例仍全过 | 同上 | — |
| 相邻回归 | legacy adapter（唯一消费者） | `npm run test:legacy-adapter` | 14/14 pass，exit 0 | [legacy-adapter-regression.log](evidence/2026-10-08-rb-rbs-r2/legacy-adapter-regression.log) | — |
| 相邻回归 | 身份/broker/owner/resolver | `test:identity-pairing`/`test:runtime-ownership`/`test:provider-resolver` | 13/13、21/21、12/12 | 本文件 | — |

- 真实模型/原文外呼/生产读写/原生会话/微信外发：**均未发生**；纯内存合成，无 IO。
- 失败、部分结果和不明副作用：无。偏差登记：`intent-conflict` 为新增错误码（r1 无此路径）；r1 审计探针对本模块行为已变，需 r2 新探针（本批 3 条负例即 r2 定向探针）。
- 活动进程/job/handle：无。
- 数据守恒、回退和恢复方法：无状态模块；反向回退即恢复 r1（已用逆向副本实证）。
- 状态分列：实现完成 ✅（本批范围）；自测通过 ✅（主 Agent 亲自复跑）；独立审计：⏳ 待审计 AI；部署/真机：未做。

## 诚实边界与未覆盖项

- 本次仅在**普通 shell** 复跑（未再套 sandbox-exec OS 隔离）；全部夹具为 `/tmp` 自建合成数据，无真实文件/DB/服务。
- `intent-conflict` 只消费 `planEffect` 的 `{effectKey, taskId}` 这两个自由度；若未来 `planEffect` 增加新参数，须一并纳入 `buildIntent`/`intentIdentity`（当前签名无其它参数）。
- 未做：真实 `target`/`parametersDigest`、Execution→Approval 映射、V01/V02/V03/V18/V49 的正式接线与 owner/fence 实证（与 r1 的「另验」一致）。
- 未做：intent 跨进程单 owner 保证——纯 Map 唯一性不证明跨进程单 owner（沿用 r1 结论）。

## 要求审计方做什么

- 审计范围与重点风险：`runtime/route-binding.mjs` 与 `tests/route-binding.test.mjs`。建议重点：① `intentIdentity` 键排序序列化是否覆盖全部 effect 相关字段；② `intent-conflict` vs 既有 `effect-conflict` 的语义边界（本次未改动后者）；③ restore 同键不同值拒绝的错误码选择是否认可。
- 已知不足/需决定的方案：见上「诚实边界」。
- 等待期间将继续的无冲突独立任务：同域 [route-binding-store r2](m02-route-binding-store-r2.md)（本批同交付）。
- 返工 revision：本文件为对 RB-F001 的返工交接（r2）。
