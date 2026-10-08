# I02 purge r2：CHANGES_REQUESTED（PG-F002仍开放）

2026-10-08。[r2交接](../handoffs/i02-memory-purge-r2.md)，源码0d032839…29f6b3、测试40c24dad…120fe3。[固定复测和JSON](evidence/2026-10-08-r2-followup/README.md)。31项原用例通过；主审未参与返工，未运行真实SDK/live删除。

PG-F001内容检查子项接受：payload/plan必可读，单打标/正文或plan残留已拒，独立探针得到verify-failed。archive/备份/保留digest策略不当已完成。

## PG-F002预检到效果间竞态仍可删除新内容

定位purge.py:354–395：整批一次读digest收进ok_targets；后续效果前仅再读purged，不重验digest或epoch/owner fence。

独立复现：两个目标初始digest匹配；第1目标delete回调模拟另一写者改变第2目标digest和payload。第2仍delete/scrub，新合成内容被清掉；postcheck才verify-failed，晚拒不能还原。这不是r1的执行前已漂移用例；那一子项已改善。

返工：在实际不可逆派发边界重验权威user/event/digest/source/vector/tombstone/审批，并用单owner/epoch/fence保护检查到效果窗口。同步先扫一遍不能证明无并发；不得把postcheck叫回滚。

补测：预检后、前一目标效果期间、当前delete前、异步提交/重开等交错；漂移新内容零scrub、错误vector零delete，已合法效果诚实completed/unknown。批中部分允许/拒绝合同明确，未漂移正例仍可用。

仍需r3隔离返工，不能批准生产purge。无需等Markus旧事实外呼/迁移批准才修源码。
