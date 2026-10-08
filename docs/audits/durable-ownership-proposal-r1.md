# Durable ownership方案A：条件接受源码/隔离实施方向

2026-10-08。审查[提案](../handoffs/durable-ownership-proposal-r1.md)，**不是生产开工/新Grant**。依现行Goal §3，已准范围内源码与合成返工不用等待Markus对每个patch再批准；本线程不替执行方写实现。

裁决：接受“前台与显式后台独立durable conversation”作为关闭V11/V12的方向，可从**全新、无旧历史/生产效果**的隔离任务实施。先保留默认生产路由关闭，不触发实际Agent/模型外呼。提案现有“每execution一个conversation便不存在排队/精确停止”的绝对表述还不成立，需下列条件。

1. 明确一个Execution是否只有一个in-flight Submission。若允许多个，单Submission取消仍可能误伤同run其他输入，queue仍可能滞留；必须限制/拒第二输入或细分Task/Submission ownership，不能用同execution下新消息偷偷重放旧任务。
2. conversationKey用类型化owner/account/profile/execution/cycle复合键；不只拼`bg:<executionId>`。宿主确认真实Task/Execution/Grant绑定，防前后台名字碰撞和跨用户/账号共享。
3. 并发slot与累计tokens/calls/授权期限分开，不能直接把budget.maxCalls当活跃数，不能settle/regrant来释放slot续预算。默认/可配置并发不得扩大已有许可，原总Goal预算仍约束每个child。
4. pending推进只保留一个权威owner/fence，复用产品调度与既有持久状态，不叠第二scheduler/registry。绑定、slot预留、launch intent、SDK实体/结果补链接故障窗口要原子/可核对，禁止ghost成功。[RBS报告](m02-route-binding-store-r1.md)、[budget](m02-budget-policy-r1.md)是依赖修复项。
5. 旧stalled迁移**本次不批准自动执行**：queued/stalled标签不等于零效果；需逐项核对model/tool/outbox/launch ledger与原Grant。旧Submission ID若改变要保留不可变旧→新lineage，不能在原mapping覆盖历史，不把unknown重新驱动。先实现只读核对/合成转换与负例。
6. 上下文从已绑定用户/来源/隐私epoch装配，保留原或压缩记忆与预算；不借foreground transcript绕scope。[ContextAssembler缺口](m02-context-assembler-r1.md)须补，不因为模块已存在就算此依赖通过。

可先交r3切片：复合ownership键/单输入合同→新任务分流→精确scope取消与崩溃恢复→slot/pending接口/故障负例。依赖模块可以先stub模拟，未修依赖不得正式接线或把fake当生产通过。无需等许可证/生产chmod/43旧事实批准才写这些代码。

验收保持V09–V13/16/18/31：两种启动顺序、同exec重复/不同payload、多exec、前台/单Submission/Execution/Goal各scope、无新用户消息推进、owner死/恢复/预算到期、完成效果不增加、unknown不重派。方案B非主方向，方案C诚实报告可留但不关闭完整目标。
