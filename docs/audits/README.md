# 0.3.0 审计索引

更新：2026-10-08。这里记录审计结论，不代替执行方自测、产品状态、部署或实际微信证据。执行线程的Goal可继续，本线程实现Goal保持paused，仅监督、review和改进计划。规则见[协作协议](../plans/0.3.0-collaboration.md)。

## API Key 专项审计（优先交接）

[2026-10-08 密钥扫描与执行交接](2026-10-08-secret-scan.md)：第66行是上游合成测试假密钥，已改为TESTONLY构造，188条相关用例及server typecheck通过；并行执行方已提交到公开feature分支，审计线程未操作远端。当前源码和公开历史未确认真实API Key泄漏；GitHub alert #1仍open，未改历史。最新[遥测r1复核](2026-10-08-telemetry-r1-review.md)：默认关闭/裸异常擦除限定接受，11/11自测通过，但4条独立canary反例复现 **SKEY-F003：opt-in标识符/标签/自动属性仍透传秘密形状原文，CHANGES_REQUESTED**。执行方可立即按报告做离线源码返工，不必等待生产审批。完整系统尚未安全签字。

## 重启与真实测试准入（最新）

[重启就绪审计r1](2026-10-08-restart-readiness-r1.md)：**当前整套生产重启NO-GO / CHANGES_REQUESTED**。19:43只读现场仍0.2.2/legacy，Goal authority.json缺失、113旧done记忆回执未迁；隔离复现 **RR-F003 viewer可写Goal、RR-F004权限漂移仍命中鉴权缓存**。执行方可直接做源码/fake返工，不等待人类技术选择。遥测新源码14/14，原SKEY-F003四条泄漏路径均不复现，限定接受；不自动代表P0或生产已完成。首次受控真实测试与正式发布分门槛，不以24h完成作为第一次隔离真实测试的前置；实际切换/外呼按原授权。

## 已审查的批次（逐版本限定）

### 最新指定返工与新反例

[本轮继续执行输入](2026-10-08-review-followup-summary.md)：**RR-F003、RR-F004与M01-F001剩余两点已按固定sourceRef关闭**，报告分别见[角色r1](m02-goals-role-authz-r1.md)、[身份r2](m02-identity-lifecycle-r2.md)、[迁移r3](m01-migration-r3.md)。45项角色/身份、72项迁移、55项native与15项前后台既有案例通过，但独立反例又复现 **RO-F001真实Seatbelt仍允许Reviewer改workspace**、**FG-F001 Grant期限后fallback重入并resolved**。两个Major的[Reviewer](p4-reviewer-readonly-r1.md)/[前后台](p3-foreground-background-r1.md)返工合同已交接。通过数不等于发布验收；RR-F001/002生产准备与完整真实链路仍待，整套重启限制不因源码子项接受而取消。

最新入口：[给执行Goal的新输入](2026-10-08-unblock-input.md)。审计/设计反馈已交付；源码返工不必等旧事实外呼/生产切换批准。本线程未代改执行Goal、提交GitHub review或批准生产。

### 最新返工与第三轮

| 批次 | 结论 | 下一动作 |
| --- | --- | --- |
| [M01 r2](m01-migration-r2.md) / [r3](m01-migration-r3.md) | r2历史失败保留；r3原F001两点限定修复接受 | 真实质量/SDK与旧事实/迁回/重启另验 |
| [ownership r2](m02-runtime-ownership-r2.md) | 新admission F003关闭；F001/F002诚实子项接受，完整能力未过 | 按[方向条件](durable-ownership-proposal-r1.md)做新合成切片 |
| [reconcile r2](i02-memory-reconcile-r2.md) | 纯解析核心限定接受，RC-F001关闭 | 可fake接search，真实质量/隐私另验 |
| [purge r2](i02-memory-purge-r2.md) | 内容检查子项接受，PG-F002预检→effect间漂移仍删除 | 单owner/epoch/fence及交错负例 |
| [session r2](m02-session-permission-broker-r2.md) | 进程内关闭窗/并发一次性限定接受 | commit fence、pending耐久、全路另验 |
| [resolver r1](m02-provider-resolver-r1.md) | 纯离线解析核心限定接受 | 私有transport/公开DTO、真实认证待证 |
| [fallback r1](i03b-fallback-policy-r1.md) | CHANGES_REQUESTED：FB-F001/002 | 全kind副作用屏障、完整immutable上下文 |
| [budget r1](m02-budget-policy-r1.md) | CHANGES_REQUESTED：BP-F001异常clock仍active | 不明时间拒绝，slot/原预算分开 |
| [route r1](m02-route-binding-r1.md) | CHANGES_REQUESTED：RB-F001不同task未conflict | intent参数身份/恢复唯一性 |
| [route store r1](m02-route-binding-store-r1.md) | CHANGES_REQUESTED：RBS-F001失败后ghost成功 | poison/回滚；未知DB接管/owner另补 |
| [ContextAssembler r1](m02-context-assembler-r1.md) | EVIDENCE_REQUIRED：局部限额不等总预算/隐私 | 总budget/数量/来源与epoch |
| [native sandbox r1](m02-native-sandbox-r1.md) | EVIDENCE_REQUIRED：四deny树覆盖不全 | 完整Grant读边界、executor接线 |
| [ownership提案](durable-ownership-proposal-r1.md) / [序列提案](construction-sequence-r1.md) | 源码/隔离方向条件接受，不是生产Grant | 原owner/预算；不自动迁旧stalled |

第三轮147项选定原套件通过，另5项代码Finding、3类接线缺口分列；[成功/失败/OS证据](evidence/2026-10-08-round3/README.md)。四份r2另257项通过，M01/purge负例仍失败；[followup](evidence/2026-10-08-r2-followup/README.md)。不能相加冒充V01–V52全过。

### 历史r1结论（不覆盖原失败）

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
| 兼容/退役 | [legacy-adapter r1](../handoffs/m02-legacy-adapter-r1.md) | 期限、legacy真实能力边界、不明请求不重派 | QUEUED / 尚未正式审 |
| P0基础 | [dependency-audit r1](../handoffs/i01-dependency-audit-r1.md) | 依赖/许可/telemetry实际覆盖、工具exit=1含义、未覆盖风险 | QUEUED / 尚未正式审 |
| P0基础 | [private-data-boot r1](../handoffs/i01-private-data-boot-r1.md) | 私有库存权限、真实launchd来源与现场时间，非重启成功证明 | QUEUED / 尚未正式审 |
| 微信接线 | [P3 readiness r1](../handoffs/p3-readiness-r1.md) | Inbox/结果/Outbox崩溃守恒、映射链、依赖缺陷未关闭 | QUEUED / 探索不算接线实施 |
| Worker接线 | [P4 readiness r1](../handoffs/p4-readiness-r1.md) | 真实worker/旧会话/权限与Evidence交接范围 | QUEUED / 探索不算真实Worker通过 |
| 可视化/迁移 | [P5/P6 readiness r1](../handoffs/p5-p6-readiness-r1.md) | UI/资源/迁移/回退范围 | QUEUED / 探索不算实施 |
| 盘点 | [T01/T02 inventory r1](../handoffs/t01-t02-evidence-inventory-r1.md) | sourceRef与U/I/L/R缺口 | QUEUED / 不算验收 |

执行方可继续无冲突任务；未关闭M01/M02 finding的依赖链不得过对应门槛。新批次不被旧r1测试覆盖，也不能自动继承本轮审计结论。

## 返工提交要求

- 每条Finding回答修复/理由拒绝/待决，附新diff、完整hash、反向负例和原始结果，不覆盖r1证据。
- 多个交接共同修改package.json，历史追加版本与共同冻结版本不一致；补统一依赖/实际入口。不要把共享scripts的变化隐藏为“无交集”。
- V10真实长后台、当前回合/全Goal/产品取消接线、真实微信与24h合盖均待验。上一轮7项和本轮5项各按新revision复核；缺陷修完也不自动代表完整0.3.0完成。
- 不自动迁移生产、启动真实原文外呼、重启/部署/推送或发外部消息。本轮没创建自动监督Goal或监听；共享报告不等于已通知外部App。
