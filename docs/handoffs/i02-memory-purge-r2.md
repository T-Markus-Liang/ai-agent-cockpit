# 执行交接包：I02 memory purge r2（按审计 Finding 返工）

回应 [i02-memory-purge-r1 审计](../audits/i02-memory-purge-r1.md)（CHANGES_REQUESTED）；r1 失败证据保留不覆盖。

## 批次身份与固定来源

- batchId / revision：i02-memory-purge / **r2**；状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；返工由 subagent（deepseek-flash）完成，主 Agent 定返工设计、亲自复跑
- 新 hash：`services/memory/purge.py` `0d032839…29f6b3`（原 `984aa617…`）；`tests/memory_purge_test.py` `40c24dad…120fe3`（原 `b1368443…`，22 → 31 用例）

## PG-F001（打标被当正文已擦除）→ 内容级验证

- `turn_get` 合同升级：必须返回本层拥有的内容副本 `payload` 与 `plan`（plan 的 facts[*].quote 即原文回显）。
- `_is_erased`：仅 None/空/约定标记 `[purged]`/精确 `{"purged":true}` 判为已擦除；带多余键或非空 plan 一律判残留。
- postcheck：字段缺失（无法提供内容）→ `unverifiable`，**绝不 verified=true**；字段在但未擦除 → `verify-failed`（detail 含 event_id 与字段）。
- 负例：只打标不清内容 → 不得 verified；payload 清但 plan/quote 残留 → 失败；scrub 无持久效果 → 失败；无内容字段 → unverifiable。r1 探针 F001 已翻转为 `unverifiable`。

## PG-F002（目标漂移后先删再报错）→ 效果前漂移闸门

- 任何不可逆效果前，对**每个**目标 `turn_get` 重读当前 digest 与 plan 期望 digest 比对；漂移/不可读 → `drifted` 集合，**该目标零 delete/scrub**；整批先核对再删。
- 完成后对漂移目标抛 `drifted-target`（携诚实 completed/drifted 部分状态，不做假回滚）；中途效果失败仍 `purge-incomplete`（completed/failed/drifted 三清单）。
- 负例：执行前漂移 → 零效果拒绝；批中第 2 目标漂移 → 第 1 已删如实记录 + 第 2 拒绝未触及；第 1 目标漂移同样前置拦截；重开后内容保持已擦且重放幂等。r1 探针 F002 已翻转（effects==[]，漂移内容未被擦除）。

## 验证（主 Agent 亲自复跑）

`npm run test:memory-purge` 31/31；`python -m unittest discover -s tests -p 'memory_*test.py' -v` 232/232；`npm run test:memory-service` 85/85；`npm run test:memory-purge-live` 16/16（live 脚本已同步升级：turns 加 plan 列、scrub 双副本擦除、断言扩展，脚本新 hash `ee97110f…338ab7`）。

## 偏差（如实）

- 多目标漂移语义：漂移目标零效果，可确认同类目标仍擦除，随后抛 drifted-target 携部分状态（审计"整批先核对再删"的落地，与强制补测一致）；`unverifiable`（字段缺失）与 `verify-failed`（字段在但未擦除）分开。
- 策略提醒（审计）："保留 digest/tombstone"不是法律合规认证，向用户说明删除范围与保留的审计元数据属后续产品层事项。
