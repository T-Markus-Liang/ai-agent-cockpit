# M02 route binding r1：CHANGES_REQUESTED

2026-10-08。对象：[交接](../handoffs/m02-route-binding-r1.md)。源码`a5eb6fde…63ea16`、测试`7a410c21…632e54`；12/12原用例通过，包含[路由22项输出](evidence/2026-10-08-round3/route-suite.log)。[固定版本/探针](evidence/2026-10-08-round3/README.md)。主审未实现本模块，未派发任何实际effect。

## M02-RB-F001 — 中 / 阻断ID/效果一致性：task变化不冲突，恢复重复intent静默覆盖

定位`route-binding.mjs:295–315`，intentKey只有request+effectKey，已有intent直接返回；`:349–378` restore对同key直接set。

复现：legacy allowlist含t1/t2，先planEffect(task=t1)，再同key请求t2，返回原t1对象，不告知冲突；快照追加同key、task=t2的另一合法intent，fromJSON静默取最后一个t2。两任务都在allowlist，不是跨scope越权或实际t2派发；问题是效果语义/task身份不一致以及重复键恢复不确定。

返工：把影响effect/Approval的task/完整参数绑定进不可变intent身份与幂等比较。同key同body可重用，不同body拒conflict；restore检测重复不同值，不last-wins。若API故意只按effectKey识别任务，必须明确一个唯一task绑定，不能同时在响应保留相互矛盾的taskId。

补测：同key同/不同task、task缺省与显式值、scope内两个任务、重复/互相矛盾快照、重开后行为一致；conflict零状态变化、原intent不变。实际target/parametersDigest、Execution与Approval映射另验。

可保留binding字段级比较、expiry、scope与冻结正例；纯Map的唯一性不证明跨进程单owner。V01/V02/V03/V18/V49正式路径待接线，不把advisory intent当已持久派单或已批准。
