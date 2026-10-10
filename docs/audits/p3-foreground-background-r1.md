# P3 foreground/background r1 审计

交接：[p3-foreground-background-r1](../handoffs/p3-foreground-background-r1.md)。本报告基于当前合成版，不把早期r1hash涵盖后续消息/派发切片；session SHA256 `f226843ef19fb0fa224bd653ef684e4a9c3a0d132f0909dfb641fec93443859a`，config `fba96d6326f3a30cb5f0009d893812e03682d9ead611ab4ec200c2a896291dfe`。

## 裁决

**CHANGES_REQUESTED / FG-F001（Major）；前台仅通知、不杀operation，迟到结果、后台notice去重/恢复子项限定接受。** 三个相关测试文件15/15通过，不等于后台完整接管或真实Grant已接。

### FG-F001：所谓Grant期限到期仍重新入队fallback

`SessionManager.processQueue`的GrantDeadlineError分支在cleanup后，依据无已观察消息/工具、retryCount等条件重新enqueue同一pending；下一attempt的awaitAgentOperation重新开启一个完整grantDeadlineMs相对定时器。原期限没有跨attempt持久/继承，过期本身不会禁止fallback。

独立假ACP反例：配置grantDeadlineMs=30，primary永不返回且未产生消息/工具；到期后createSession被调用，fallback prompt在第一期限后启动，任务最后**resolved**并发出reply，Grant到期notice为0。fake models only、无真实进程/用户数据。不是主审批准了新Grant，也不能用“未看到工具”证明真实派发没有副作用。

若此字段只是“每次operation超时”，需明确命名且不能宣称它已实现Grant硬期限；现交接称其“唯一硬终结/Grant期限”与实际行为不符。真实per-task Grant未下发这一已声明缺口保留，不能靠改措辞代替正式接线。

### 返工合同

1. 重用已有Grant/预算/lease，入站一次记录原绝对截止点；后台、retry、fallback与恢复都不得重新从now计算完整期限或默默延长。过期只终结/保留原文和待核对副作用，不重发原prompt。
2. 仍在原授权/原剩余期限内的明确可重试provider故障可fallback；认证/授权/期限耗尽及副作用不确定不得换Agent重放。将无工具通知与确定无副作用区分，接既有fallback-policy，不另建引擎。
3. 补“静默primary到期+fallback已配置”负例：原任务拒绝/到期、fallback调用0、原notice一次；另补期限未到的合法fallback、等待超时不杀、后台完成、取消、重启沿用原截止点及未知副作用不重派。
4. 部署前必须处理旧`session.promptTimeoutMs=300000`配置：新代码移除此消费者，原生产文件不带两新键时会落到默认30分钟（而非旧5分钟），不能在无明确部署配置/范围核对时静默扩大时限。不要为本次审计直接改生产配置。
5. foregroundWaitMs可作交互体验参数，不是新的授权。30min不是“批准的真实Grant”；正式值由原范围提供并验证。源码/fake返工可直接继续，真实调用/生产/旧事实仍按既有授权。

本报告没有发送微信或跑真实Agent，不证明实际用户已发生重复执行或超限；发现的是可重复的控制流违约。复核r2后再关FG-F001，不能用15条原测试绿或背景状态显示替代。
