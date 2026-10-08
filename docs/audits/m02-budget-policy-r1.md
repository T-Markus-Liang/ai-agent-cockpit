# M02 budget policy r1：CHANGES_REQUESTED

2026-10-08。对象：[交接](../handoffs/m02-budget-policy-r1.md)。源码`96d15371…9d14a86`、测试`7bc8eb07…1bcd33a`，13/13原用例通过。[第三轮版本、原输出与探针](evidence/2026-10-08-round3/README.md)。主审未实现本模块；只对纯预算路径审查，不给其“全M02联合回归无干扰”或生产预算背书。

## M02-BP-F001 — 中 / 阻断fail-closed：时钟异常后仍可使用预算

定位`budget-policy.mjs:263–269,280–302,305–312`。clock只验函数类型，实际值不验；NaN与expiresAt比较为false。

复现：先用正常clock=100签出有效budget，再故障注入clock=NaN。assertActive返回成功、remainingMs=NaN，charge接受并扣1次call。不是现役主机时钟故障，也不是已经超支；是缺少“当前期限不可核对时拒绝”的屏障。

返工：每次grant/check/charge验证有限、合法clock及derived expiry；异常或溢出在状态变动/效果授权前拒绝，原记录与计数不变。不要把unknown剩余期限当仍active。金额/调用计数等硬量保留确定性校验，Jev不参与。

补测：有效grant后NaN/Infinity/非法clock、grant时异常与expiresAt溢出、边界expiry、正常clock和重开一致；异常时无charge/副作用。测试默认Date.now正常用例不替代故障校验。

原子扣减、exhaustion、settled历史保留正例可留；但这是**请求预算元数据**，不是Grant授权系统或并发slot。settle再grant须宿主确认新授权周期，不等于自动续原Goal；并发活跃数必须用独立slot计数/原调度器释放，不把累计maxCalls当并发限额。P2接线后验证原Goal总预算/期限与本层同时约束，V31不能只靠这13项关闭。
