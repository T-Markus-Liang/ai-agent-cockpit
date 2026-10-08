# 重启就绪审计的隔离证据

对应[审计与执行交接](../../2026-10-08-restart-readiness-r1.md)。报告不是部署授权或全版本验收。

`observations.json`保存只读现场的允许字段、sourceRef、20项选定测试结果、2个独立缺陷反例和遥测4条旧路径的新结果。无真实token/凭据、对话payload或二维码。time是UTC，主报告使用Asia/Shanghai。

以下探针只创建自有tmp数据、假Goal/SDK；不调用真实Goal引擎或模型，不连接生产服务、不开旧Native会话，不改变用户私有权限。`goal-role-probe`启动独立随机loopback端口；`auth-permission-probe`只chmod自建tmp文件。端口及文件均在finally关闭/清理。

```bash
cd /Users/markus/ai-agent-cockpit
node docs/audits/evidence/2026-10-08-restart-review/goal-role-probe.mjs
node docs/audits/evidence/2026-10-08-restart-review/auth-permission-probe.mjs
node docs/audits/evidence/2026-10-08-restart-review/telemetry-current-probe.mjs
node --test tests/goal-per-client-token.test.mjs
cd vendor/wechat-acp
node --import tsx/esm --test tests/telemetry.test.ts
```

反例probe exit0表示观察成功，不表示安全检查通过：viewer actualStatus=200/fakeMutationCalls=1 和 acceptedAfterPermissionsWidened=true 是缺陷。修补后期望viewer403/0，权限放宽AUTH_CONFIGURATION/不接受。本证据指向报告SHA256，未来复跑前必须核对新sourceRef；改变结果的修补要新revision。

遥测probe复用了原r1路径，但守卫**更新并绑定**当前合成源码SHA256 `c6553c4f72d392f8a39c8a5a5dc8979ec79d764a88d140462003df5c2dc71ac3`，没有去掉来源验证。当前14条用例包含原13条加`/acp-more`白名单新项；四条旧泄漏均false，defaultOff=true。只接受这些路径，不冒充真实SDK或生产已经加载。

测试输出摘录：Goal per-client 6 pass/0 fail/exit0（duration102.273416ms）；telemetry 14 pass/0 fail/exit0（duration62.069375ms）。此前误在根目录指向vendor测试路径报文件不存在，纠正cwd后单独成功，不记产品失败。

文档协查只使用公开计划/交接的独立暂存副本，无凭据/原文。官方DeepSeek job `1791456810-ca4bceb30e6c`只读成功，8文件前后hash一致；失败的前一job未采纳，没有第三方fallback。它不替代主审实际反例，也不作为真实产品Worker或发布签字。

Jev只检查合成措辞是否将隔离/只读证据说成已部署/24h稳定：限定草稿Noul0.05、夸大对照0.98，模型jev-1.13.0。没有阈值动作、工程判断或授权。官方索引已读取相关条目，confidence文档本次TLS访问失败，沿用已读skill和本机wrapper既有Noul契约，不新增集成或编造版本能力。

不保存真实本地凭据文件或SQL行正文；生产Memory只查询schema及状态聚合。113是done入库回执而非独立事实。真实迁移/召回质量/回退均未在本轮执行。
