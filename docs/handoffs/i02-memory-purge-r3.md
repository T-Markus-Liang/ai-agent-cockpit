# 执行交接包：I02 memory purge r3（按审计 Finding 返工）

回应 [i02-memory-purge-r2 审计](../audits/i02-memory-purge-r2.md)（CHANGES_REQUESTED，PG-F002 仍开放）；r2/r1 证据与旧交接保留不覆盖。上一版交接：[r2](i02-memory-purge-r2.md)。

## 批次身份与固定来源

- batchId / revision：i02-memory-purge / **r3**；状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；返工由 subagent（deepseek-flash）完成，主 Agent 定返工设计
- 新 hash（r3 交付）：
  - `services/memory/purge.py` = `cb3252aaa490ff470ec1fa45be5463e13c35589dfbc67440dbf1b0f10cc4f869`（r2 为 `0d032839…29f6b3`）
  - `tests/memory_purge_test.py` = `9917e364e9e5223f67cf30b0de51d75ca7481ec7e192ddde6d23e03133fbd1ee`（r2 为 `40c24dad…120fe3`，31 → 45 用例）
- 只读审计参考：`docs/audits/i02-memory-purge-r2.md`、`docs/audits/i02-memory-purge-r1.md`、审计复现脚本 `docs/audits/evidence/2026-10-08-r2-followup/r2-memory-review.py`（第 49–59 行即 PG-F002 交错）
- 测试环境：全部为纯合成夹具（in-memory 假回调 + `:memory:`/tmp 目录 sqlite）；未跑 live 脚本、未触真实 SDK/生产、未改 package.json、未执行任何 git 命令。

## PG-F002（预检→效果间竞态仍可删除新内容）→ 效果边界重验 + 原子条件效果

**缺陷**（r2，定位 `purge.py:354–395`）：整批一次读 digest 收进 `ok_targets`；后续效果前仅再读 `purged`，不重验 digest 或 epoch/owner fence。两个目标初始 digest 匹配时，第 1 目标 delete 回调里另一写者改变第 2 目标 digest+payload，第 2 仍被 delete/scrub，新内容被清掉，直到 postcheck 才 `verify-failed`，晚拒不能还原。

**返工（本层可核对语义）**：

1. **每个不可逆派发边界重验权威身份**（`execute_purge` 内 `authorized(target)`，在预检、每个目标效果开工前、每个向量 delete 前、scrub 前各调用一次）：
   - 逐项比对冻结计划：`digest`（必比，写者改变的就是它）、`event_id`、所属 `user_id`、`source_hash`、绑定 `vector_ids`——凡是读面暴露的字段逐项一致才放行；
   - 可选 `guard_approval(user_id, event_id, source_hash)` 在同一临界点复查审批（tombstone）；返回假/抛错 → 不放行；
   - 任一漂移 → **该目标零 `delete`/`scrub`**，按状态诚实标记（`refused-drift`；若已派发部分效果则为 `unknown`），绝不伪造全绿。
   - 读面未暴露的字段无法反驳计划、跳过（见"诚实边界"）。
2. **优先原子条件效果收窄窗口**（新增三个可选关键字回调，省略即退回"重读+紧邻调用"）：
   - `delete_vector_if(vector_id, expected_digest) -> bool`、`scrub_turn_if(event_id, expected_digest) -> bool`：交由底层存储在其自身临界区做 `… WHERE id=? AND digest=?` 类条件并回传影响行数；`False` 表示并发改写获胜、**本次未施加效果**；
   - 条件效果使"检查"与"效果"在存储侧一步完成，窗口收窄到该存储自己的临界区；vector 侧不支持条件删时，本模块在同一临界段内**先重读再删**，残余窗口如实声明（见下）。
3. **批中部分允许/拒绝合同显式化**：`PurgeError` 新增 `statuses`（每目标 `event_id → completed / already-purged / refused-drift / failed / unknown`），并保留 r2 的 `completed`/`failed`/`drifted` 清单。已合法完成的效果诚实 `completed`，中途漂移的派发诚实 `unknown`。
4. **postcheck 保留但不得叫回滚**：第 5 步仍是擦除后核对（向量不存在、`purged` 真、digest 保持、`payload`/`plan` 逐字段擦净），只在已派发目标上运行，**只能报告所见，不是回滚**；代码注释与文档措辞均避免"回滚/还原"。
5. **PG-F001 不回退**：内容级验证（`_is_erased`/`_read_content`/`unverifiable`）原样保留，被 45 项用例继续覆盖。

## 关键 diff 摘要

- `execute_purge` 签名（位置参数不变，向后兼容 live 脚本）：
  `execute_purge(plan, delete_vector, scrub_turn, vector_exists, turn_get, *, delete_vector_if=None, scrub_turn_if=None, guard_approval=None)`
- 新增内部 `authorized(target)` 闭包：审批探针 + `turn_get` 身份读，二者都要与冻结计划一致；在预检与**每个效果边界**调用。
- 新增 `_field(turn, name)`（dict/对象兼容读取）与 `_identity_matches(turn, user_id, target)`（逐项身份比对）。
- 效果循环：删向量/scrub 前逐次 `authorized`；`delete_vector_if`/`scrub_turn_if` 返回假即停止该目标其余效果；`except` 仍抛 `purge-incomplete` 并携 `statuses`。
- 漂移来源分两处：`preflight_refused`（预检拒绝）与 `boundary_refused`（边界拒绝）；批量抛 `drifted-target` 时 `detail` 区分 `preflight_identity_drift` 与 `pre_effect_identity_drift`，`drifted = preflight_refused + boundary_refused`。
- 成功返回值形状不变：仍为 `{"purged": [...], "already_purged": [...], "verified": True}`（45 项中正例的等值断言原样通过，未放宽）。
- 模块 docstring 第三条不变量改写为"边界重验 + 原子条件效果 + 残余窗口声明"；`turn_get` 合同补记身份字段。

## 验证（命令与计数）

- `npm run test:memory-purge` → **45/45 OK**（31 项原用例 + 14 项新增；`Ran 45 tests ... OK`）。
- `python -m unittest discover -s tests -p 'memory_*test.py'` → **261/261 OK**（两次复跑一致；本次匹配到的子集为 purge 45 + service 85 + reconcile 40 + migration_preflight 19 + migration 72）。
- 未执行 `test:memory-purge-live`（本批禁止 live）；已只读确认 live 脚本对 `execute_purge` 仅用位置参数（`scripts/test-memory-purge-live.py:223/272`），新增关键字参数不影响其调用。

## 反向负例清单与原始结果摘要

新增 14 项，其中 6 项"交错/条件"负例为审计点名场景。**敏感度核验**：把这 6 项跑在 r2 旧算法上（在 /tmp 临时重装 r2 的 `execute_purge`，不改仓库文件）全部失败，证明它们钉住该 Finding 而非空过：

| 用例 | 场景 | r3 结果 | r2 重放 |
|---|---|---|---|
| `EffectBoundaryFenceTests.test_sibling_effect_drift_keeps_second_target_untouched` | 第 1 目标 delete 回调改第 2 目标 digest+payload（审计原复现） | `drifted-target`；`completed=[e1]`、`drifted=[e2]`、状态 `e2=refused-drift`；`delete_calls=[v1]`、`scrub_calls=[e1]`、e2 新内容原样未擦 | **FAIL（未拒绝，e2 被 scrub）** |
| `...test_commit_between_preflight_and_first_effect_is_refused` | 预检后、首效果前提交漂移 | `drifted-target`、状态 `e1=refused-drift`、零 delete/scrub | **FAIL（未拒绝）** |
| `...test_drift_before_current_vector_delete_stops_remaining_effects` | 当前 delete 前一刻漂移（两向量） | `drifted-target`、状态 `e1=unknown`（已删 v1a）；v1b 未删、零 scrub | **FAIL（未拒绝）** |
| `...test_withdrawn_approval_between_targets_refuses_the_second` | 审批撤销后第 2 目标 | `drifted-target`、`e2=refused-drift`、`delete_calls=[v1]` | **ERROR（旧签名无 `guard_approval`）** |
| `ConditionalEffectTests.test_conditional_delete_precondition_failure_refuses_with_zero_effects` | 原子条件删影响 0 行 | `drifted-target`、`e1=refused-drift`、零 delete/scrub | **ERROR（旧签名无 `delete_vector_if`）** |
| `AsyncCommitInterleavingTests.test_committed_change_between_preflight_and_effect_is_refused` | 另连接提交改写第 2 目标（异步提交/重开交错） | `drifted-target`、`e2=refused-drift`；重开后 e1 已擦、e2 原文保留 | **FAIL（未拒绝）** |

其余新增负例/正例：`commit_between_preflight_and_first_effect`、`source_hash`/`vector_binding`/`owner` 漂移各拒绝且零效果；`ConditionalEffectTests.test_conditional_effects_receive_the_approved_digest`（条件回调收到计划 digest 的正例）；`AsyncCommitInterleavingTests.test_connection_reopen_without_drift_still_erases`（重开无漂移正例）；`PerTargetStatusTests.test_statuses_map_every_target_on_a_mid_batch_failure`（`{e1:completed, e2:failed}`）；`EffectBoundaryFenceTests.test_non_drifted_batch_still_erases_every_target`（未漂移正例仍全擦，防过度拒绝）；`PurgeErrorCodeTests.test_error_carries_per_target_statuses`。

**审计原复现的翻转载剪**（隔离合成夹具，无 SDK/DB/网络/真实文件；`docs/audits/evidence/2026-10-08-r2-followup/r2-memory-review.py:49–59` 同构）：

```
error: drifted-target   detail: pre_effect_identity_drift
effects:  ["delete:v1", "scrub:e1"]        # r2 是 ["delete:v1","delete:v2","scrub:e1","scrub:e2"]
statuses: {"e1": "completed", "e2": "refused-drift"}
e2_purged: false   e2_payload: "SYNTHETIC_NEW_CONTENT"   e2_digest: "new"
```

即 r2 的"先删后报 verify-failed、晚拒不还原"已翻转为"边界拒绝、e2 零效果、新内容零 scrub、零错误 vector 删除"。

## 未覆盖项与诚实边界声明

- **残余窗口（如实）**：`delete_vector` / `scrub_turn` 为注入回调，非原子条件回调时，本模块只能在**紧邻调用前**重读+比对，重读到调用之间仍存在极窄窗口（单机、单 owner 假设下）。真正的原子性由调用方以 `delete_vector_if`/`scrub_turn_if` 承接（存储侧条件删），本层不提供跨进程 fencing token/epoch 的强制——审计 r2 提到的 epoch/owner fence 需宿主存储配合，本层只做逐项身份比对。**同步先扫一遍不被当作无并发的证明**（这正是 r3 的返工点）。
- **tombstone/审批实读**：本层执行面不持有 lifecycle 的 tombstone 存储；预检只据冻结计划 `tombstones_required` 为空放行。边界复查审批依赖调用方传入 `guard_approval`；未传则不复查（读面缺该能力），此处为已声明残余。
- **读面缺字段即弱化 fence**：`turn_get` 若不暴露 `user_id`/`source_hash`/`vector_ids`，这些项无法比对而跳过，只剩 digest 级 fence——调用方须暴露全部身份字段才能获得完整项级 fence。
- **未跑 live / 未触生产**：未验证真实 Mem0 SDK 条件删、真实并发提交、真实重开下行为；`test:memory-purge-live` 未运行，其 happy-path 不构成本批 L 证据。
- **mult-target 语义**：漂移目标零效果、可确认同类目标仍擦除，随后抛 `drifted-target` 携 `statuses` 部分状态；`unknown`（部分已派发）与 `refused-drift`（零派发）分开，不假称恢复原文。
- **产品层提醒（审计 r2）**："保留 digest/tombstone" 不是法律合规认证；向用户说明删除范围与保留的审计元数据属后续产品层事项，本批不改。
- **策略/范围不变**：先 soft-forget、tombstone 不删、跨用户选择隔离、digest 审计引用、archive 只引用不执行（执行面无 archive 回调）均保持；未做用户级擦除/archive 协调。
