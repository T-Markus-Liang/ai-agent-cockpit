# 执行交接包：M01 migration r2（按审计 Finding 返工）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包为 r2 revision，回应 [m01-migration-r1 审计](../audits/m01-migration-r1.md)（CHANGES_REQUESTED）；r1 失败证据保留不覆盖。

## 批次身份与状态

- batchId / revision：m01-migration / **r2**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；返工由该会话 subagent（deepseek-flash）完成，主 Agent 定返工设计、亲自复跑
- base：分支 `feat/0.3.0-progress`（PR #1），r1 审计基线 `e8c4317`

## r2 固定来源（新 hash）

- `services/memory/migration.py` `1caa154d…f187912`（原 r1 `679b2ae3…`）
- `tests/memory_migration_test.py` `2484bca5…a9bf84`（原 r1 `3b790359…`，28 → 57 用例）

## Finding 逐条回答

### M01-F001（目标来源与路径保护不足）→ 写入前确定性校验

- `_validate_target_path`：copy_dir 与 DB 路径逐组件校验——symlink → `target_symlink`；非普通文件 → `target_not_regular`；`st_nlink>1` 未知 hardlink → `target_hardlink`（根级 symlink 豁免仅限 `/` 直接子目录，macOS `/var→/private/var` 必需，已在交接中声明）。
- known-copy 收紧为两条准入：① 我方 manifest（converterVersion 匹配）+ provenance 指纹（`source_digest_set_hash` == 重算源 digest 集合哈希）；② 无 manifest 时要求是**当前源的逐行字节忠实快照**（逐 event_id 比对 digest+payload+created_at）。同 schema 冒名库（digest 同、created_at 异）→ `unknown_existing_db`，绝不进入删除/重建。
- 负例：冒名库拒绝且 victim 字节/权限/目录项不变；伪 manifest、provenance 不匹配、目录/DB/祖先 symlink、未知 hardlink、非普通文件各拒绝；合法副本安全重入；新空目录正常。

### M01-F002（守恒只比较已存 digest）→ 全字段逐项比对

- `verify_conservation` 升级为按 event_id 逐项：payload 精确相等、digest 用 canonical 算法**双侧重算**、created_at 相等、event_id 集合一致（增/漏/重复检出）；status 走白名单（done→{done,pending,forgotten}，非 done 原样），越界拒绝；forgotten 单调且与 tombstones 一致；manifest provenance 匹配。报告新增 `field_mismatches`。
- 负例：created_at 篡改、payload 篡改、event_id 增/删、非法状态迁移、重复 digest 不同 event——均检出；合法迁移通过。

### M01-F003（忘记提交后仍产生向量写入）→ 三道隐私 fence

- A) prepare 后、store 前重查 ForgetStore.match + 行 forgotten → 不 store、标 forgotten；
- B) store 后、写回执前重查 → `engine.memory.delete` 补偿删除，删除不可能 → needs_review，**绝不记 validated**；
- C) 结算 UPDATE 带 forgotten=0 条件并回读确认。
- 负例：forget 于 prepare 前/期间、store 期间（补偿/无删除能力 fail-closed）、结算前三时点；event/source/quote 三类 tombstone；断言效果计数、终态、绝不 validated。

### M01-F004（存储重试重新提炼）→ plan 先持久化，重试复用

- 首次 store 前 `_persist_plan` 落库；store_error 重试行加载持久 plan，经 `quality.validate_plan` 重校验（不调 evaluator）后按**同一 plan** 结算——反向探针：重试 evaluator 调用 2→2、崩溃后同 plan 结算不重复向量、plan 篡改/版本漂移 fail-closed。

## 验证（主 Agent 亲自复跑）

| 命令 | 结果 |
| --- | --- |
| `python -m unittest discover -s tests -p 'memory_migration_test.py' -v` | 57/57 OK（+29 负例） |
| `python -m unittest discover -s tests -p 'memory_*test.py' -v` | 210/210 OK |
| `npm run test:memory-service` | 85/85 OK |

## 偏差（如实）

- 根级 symlink 豁免（仅 `/` 直接子目录，macOS /var 必需）；known-copy 第二条准入路径（无 manifest 时的忠实快照校验，审计"内容映射可验证"的落地）；hardlink 用 st_nlink>1 代理；已存在 0 字节/损坏目标文件现判 unknown_existing_db（更保守）。
- 未核验项（保留）：真实 113 条迁移、43 用户条目真实 Jev 重验证、副本→生产迁移与服务重启——仍须 Markus 具体批准。

## 要求审计方做什么

- 按 Finding ID 复核 r2 diff/hash/负例；特别裁决：根级 symlink 豁免范围、known-copy 双准入路径、F003 补偿删除的完备性。
