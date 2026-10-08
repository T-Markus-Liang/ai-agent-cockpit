# 0.3.0 审计索引

更新：2026-10-08。这里记录审计结论，不代替执行方自测、产品状态、部署或实际微信证据。执行线程的Goal可继续，本线程实现Goal保持paused，仅监督、review和改进计划。规则见[协作协议](../plans/0.3.0-collaboration.md)。

## 已审查的批次（逐版本限定）

| 交接 / 固定sourceRef | 结论 | 发现 | 返工负责人 |
| --- | --- | --- | --- |
| [m01-migration-r1](../handoffs/m01-migration-r1.md)；migration `679b2ae3…d1cb6` | [CHANGES_REQUESTED](m01-migration-r1.md) | 4项：未知目标/别名、digest-only守恒、忘记后写向量、store重试重新提炼 | Kimi Code执行线程，交r2 |
| [m02-runtime-ownership-r1](../handoffs/m02-runtime-ownership-r1.md)；adapter `81ebd842…2037f6` | [CHANGES_REQUESTED](m02-runtime-ownership-r1.md) | 3项：后台队列停滞、混合run假取消、无Execution绑定后台 | Kimi Code执行线程，交r2 |
| [i02-memory-reconcile-r1](../handoffs/i02-memory-reconcile-r1.md)；reconcile `a696cf73…91523` | [CHANGES_REQUESTED](i02-memory-reconcile-r1.md) | RC-F001：三事件更正链保留独立环 | 执行方交r2，补全图环/可达性负例 |
| [i02-memory-purge-r1](../handoffs/i02-memory-purge-r1.md)；purge `984aa617…51a4` | [CHANGES_REQUESTED](i02-memory-purge-r1.md) | PG-F001/002：正文未擦除仍verified；摘要漂移在不可逆效果后才拒 | 执行方交r2，补内容postcheck与效果前fence |
| [m02-session-permission-broker-r1](../handoffs/m02-session-permission-broker-r1.md)；broker `3df31722…c6db` | [CHANGES_REQUESTED](m02-session-permission-broker-r1.md) | SP-F001/002：关闭后晚到allow；同callId并发两次allow | 执行方交r2，补generation/在途预留与实际store计数 |
| [m02-identity-pairing-r1](../handoffs/m02-identity-pairing-r1.md)；pairing `a27c0df4…df6a` | [COMPONENT_ACCEPTED，纯内存核心限定](m02-identity-pairing-r1.md) | ID-E001：静态HTTP快照不继承rotate/revoke/expiry；完整接线EVIDENCE_REQUIRED | 核心可继续使用；HTTP/MCP/工具全路生命周期另包验证 |

原有两路套件194/194通过，但专项缺陷未被覆盖。完整[命令、原始输出、复现、版本与独立性限制](evidence/2026-10-08-r1/README.md)。未出任何整批/发布COMPONENT_ACCEPTED；失败子代理和只读DeepSeek定位不作为独立发布签字。

第二轮新增4个r1审计：两记忆套件49项、两身份/权限套件27项均通过，但另复现5个缺陷，三批需修改。身份接受仅指纯内存核心，不继承到HTTP身份生命周期或完整产品。[第二轮sourceRef、原始日志和6组探针观察](evidence/2026-10-08-round2/README.md)。两轮测试数都不是V01–V52验收完成数；旧Finding不因新模块加入自动关闭。

## 后续待审队列

只确认这些交接文件存在并读了标题/范围；没有审结或复测它们。排序来自固定隐私/权限/恢复风险，不是模型批准。每批先绑定完整文件与依赖版本再审核。

| 队列 | 批次 | 要审的主要边界 | 当前状态 |
| --- | --- | --- | --- |
| 隐私/数据 | [memory-purge-live r1](../handoffs/i02-memory-purge-live-r1.md) | offline真实SDK删除取证、失败负例、擦除范围与原始artifact | QUEUED / 只读过交接，未审脚本或复跑 |
| 隐私/展示 | [vendor隐私重置/质量UI提案](../handoffs/i02-vendor-proposals-r1.md) | 原生上下文重置、来源质量可视化；提案不算实施 | QUEUED / 提案待审 |
| 安全/权限 | [native-sandbox r1](../handoffs/m02-native-sandbox-r1.md) | OS文件/exec/network、symlink、实际接线、fail-closed | QUEUED / 尚未正式审 |
| 安全/期限 | [budget-policy r1](../handoffs/m02-budget-policy-r1.md) | 原Goal预算、到期/暂停、重开和effect前拒绝 | QUEUED / 尚未正式审 |
| 数据/恢复 | [route-binding-store r1](../handoffs/m02-route-binding-store-r1.md) | DB来源/权限、owner、事务回滚、内存/持久态一致 | QUEUED / 尚未正式审 |
| 数据/恢复 | [route-binding r1](../handoffs/m02-route-binding-r1.md) | intent先于effect、唯一route、幂等/旧待办关联 | QUEUED / 尚未正式审 |
| 模型/记忆 | [provider-resolver r1](../handoffs/m02-provider-resolver-r1.md) | 私有凭据引用、错误分类、fallback不重放、秘密清理 | QUEUED / 尚未正式审 |
| 模型/记忆 | [context-assembler r1](../handoffs/m02-context-assembler-r1.md) | 原文与压缩来源、遗忘/跨用户、稳定fallback上下文 | QUEUED / 尚未正式审 |
| 模型/恢复 | [fallback-policy r1](../handoffs/i03b-fallback-policy-r1.md) | auth错误/期限预算、上下文绑定、不明effect不重放 | QUEUED / 尚未正式审 |
| 兼容/退役 | [legacy-adapter r1](../handoffs/m02-legacy-adapter-r1.md) | 期限、legacy真实能力边界、不明请求不重派 | QUEUED / 尚未正式审 |
| P0基础 | [dependency-audit r1](../handoffs/i01-dependency-audit-r1.md) | 依赖/许可/telemetry实际覆盖、工具exit=1含义、未覆盖风险 | QUEUED / 尚未正式审 |
| P0基础 | [private-data-boot r1](../handoffs/i01-private-data-boot-r1.md) | 私有库存权限、真实launchd来源与现场时间，非重启成功证明 | QUEUED / 尚未正式审 |
| 微信接线 | [P3 readiness r1](../handoffs/p3-readiness-r1.md) | Inbox/结果/Outbox崩溃守恒、映射链、依赖缺陷未关闭 | QUEUED / 探索不算接线实施 |
| Worker接线 | [P4 readiness r1](../handoffs/p4-readiness-r1.md) | 真实worker/旧会话/权限与Evidence交接范围 | QUEUED / 探索不算真实Worker通过 |

执行方可继续无冲突任务；未关闭M01/M02 finding的依赖链不得过对应门槛。新批次不被旧r1测试覆盖，也不能自动继承本轮审计结论。

## 返工提交要求

- 每条Finding回答修复/理由拒绝/待决，附新diff、完整hash、反向负例和原始结果，不覆盖r1证据。
- 多个交接共同修改package.json，历史追加版本与共同冻结版本不一致；补统一依赖/实际入口。不要把共享scripts的变化隐藏为“无交集”。
- V10真实长后台、当前回合/全Goal/产品取消接线、真实微信与24h合盖均待验。上一轮7项和本轮5项各按新revision复核；缺陷修完也不自动代表完整0.3.0完成。
- 不自动迁移生产、启动真实原文外呼、重启/部署/推送或发外部消息。本轮没创建自动监督Goal或监听；共享报告不等于已通知外部App。
