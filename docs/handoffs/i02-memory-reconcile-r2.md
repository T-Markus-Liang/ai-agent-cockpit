# 执行交接包：I02 memory reconcile r2（按审计 Finding 返工）

回应 [i02-memory-reconcile-r1 审计](../audits/i02-memory-reconcile-r1.md)（CHANGES_REQUESTED）；r1 失败证据保留不覆盖。

## 批次身份与固定来源

- batchId / revision：i02-memory-reconcile / **r2**；状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；返工由 subagent（deepseek-flash）完成，主 Agent 定返工设计、亲自复跑
- 新 hash：`services/memory/reconcile.py` `862e4f9b…be3f9f7`（原 `a696cf73…`）；`tests/memory_reconcile_test.py` `ec3faf5c…5f5c54`（原 `72f92619…`，27 → 40 用例）

## RC-F001（存在终点不等于图中无环）→ 全图三色 DFS 校验

- 新增 `_sole_terminal(nodes, successor)`：对完整 successor 图做三色（白/灰/黑）DFS 遍历**所有连通分量**——重入灰即有环；仅当全图为"单条无环链、唯一终点、每节点有限步可达、无悬空边"时 sound。
- `_resolve_group`：显式覆盖后的 successor 图先过 `_sole_terminal`；不 sound 则**整组丢弃显式边回退纯时间线**（docstring 既定规则）；防御分支：回退后仍无法确定唯一终点 → 整组进 conflicts（`cycle-conflict`）。
- 审计复现的 A↔B+C 断开环现在：显式边丢弃，按时间线 A→B→C 解析，successors={a:b,b:c,c:None}；审计探针原断言已反转失败（缺陷消失）。
- 负例 13 个：三节点断开环、四节点内部环、全节点成环、矛盾边回退、含环整组回退（合法显式边一并丢弃的语义锁定）、合法跨版本更正保留、排列一致性；另有 4000 次随机化不变式检查通过。

## 验证（主 Agent 亲自复跑）

`npm run test:memory-reconcile` 40/40；`python -m unittest discover -s tests -p 'memory_*test.py' -v` 232/232；`npm run test:memory-service` 85/85。

## 偏差（如实）

- `cycle-conflict` 防御分支在公开 API 下不可达（同刻整组 conflict 规则已保证回退后必 sound），以 `_sole_terminal` 直接单测覆盖（断开环/全环/悬空/双终点）；整组级回退会一并丢弃组内合法显式边（语义已由测试锁定）。
- 接 search 时宿主仍须先绑定用户/来源/质量/forgotten/隐私 epoch（审计提醒，接线切片职责）。
