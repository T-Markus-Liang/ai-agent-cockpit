# M01 migration r2：CHANGES_REQUESTED

2026-10-08。[r2交接](../handoffs/m01-migration-r2.md)、[r1历史失败](m01-migration-r1.md)保留。本次新converter返工主审未参与；历史service/preflight只做依赖核对，不自签整体验收。

源码1caa154d…f187912、测试2484bca5…a9bf84绑定[完整sourceRef](evidence/2026-10-08-r2-followup/source-ref.sha256)。迁移57项及相邻记忆共232项通过；主审专项仍复现F001未关闭。不是生产或43条旧事实外呼批准。

## M01-F001仍需返工

1. migration.py:316–321：未知目标准入检查仍在makedirs/chmod(copy_dir,0700)之后。合成未知库拒绝unknown_existing_db，其原0755目录已变0700。旧测试victim原本700，不能证明所有unknown路径零元数据变化。
2. :256–270：无manifest的faithful snapshot只检查target每行属于source，不检查完整集合；空基线表因循环为空返回True。独立target0行、source1行，snapshot仍接受且未备份那1行。部分/空库无来源marker，不足证明是授权副本。

[实际探针](evidence/2026-10-08-r2-followup/r2-memory-review.py)/[JSON](evidence/2026-10-08-r2-followup/probe-results.json)。所有目标自建，没有改真实文件权限。

返工：读/身份/来源校验全部在mkdir/chmod/DDL/删除前；未知库与真正新空目的地区别；无manifest至少要求完整immutable事件集合相等。允许half-copy恢复必须有明确converter来源/journal身份，而非subset或空循环成立。根级系统symlink豁免收窄到已核对alias/owner。

补测：unknown目标0755/0770、空/子集same-schema、正确同源副本、half-copy有/无marker、拒前后bytes/mode/目录项一致。

## 其他返工的限定观察

F002全字段/重算digest/时间/集合校验加强；F003增加prepare后隐私检查、store后补偿、结算forgotten条件；F004先存plan、store重试复用。原新测试有证据，但主审未对全部真实SDK异常/补偿/进程间隐私epoch独立完整验证，不标生产安全。补偿仅据delete未抛异常判断成功，unknown store效果与source/copy隐私漂移还需联合核对。

先修F001交r3；其他安全源码继续。M01收尾需固定副本/两次dry-run、源/隐私守恒、备份回退与独立scope通过，再由Markus分别批准旧原文外呼和cutover/restart。本报告不是Grant。
