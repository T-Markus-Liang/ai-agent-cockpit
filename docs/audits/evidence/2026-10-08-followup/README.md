# 本轮指定返工与新反例证据

报告：[角色r1](../../m02-goals-role-authz-r1.md)、[身份r2](../../m02-identity-lifecycle-r2.md)、[迁移r3](../../m01-migration-r3.md)、[Reviewer r1](../../p4-reviewer-readonly-r1.md)、[前后台r1](../../p3-foreground-background-r1.md)。

`observations.json`含初始冻结及最终合成sourceRef、测试计数、原反例新结果和两个新反例。没有真实凭据或实际用户payload。3个probe均只用自建tmp、fake对象/SDK；Reviewer probe真实执行sandbox-exec包裹的受控Node builtin文件写入，不是真实Agent，也不联系模型/网络。

复跑（须先核对报告sourceRef；未来源码不同不得继承签字）：

```bash
cd /Users/markus/ai-agent-cockpit
node docs/audits/evidence/2026-10-08-restart-review/goal-role-probe.mjs
node docs/audits/evidence/2026-10-08-restart-review/auth-permission-probe.mjs
node docs/audits/evidence/2026-10-08-followup/reviewer-os-probe.mjs
PYTHONPATH=/Users/markus/ai-agent-cockpit .venv-memory/bin/python docs/audits/evidence/2026-10-08-followup/migration-r3-probe.py
node --import ./vendor/wechat-acp/node_modules/tsx/dist/esm/index.mjs docs/audits/evidence/2026-10-08-followup/deadline-fallback-probe.ts
node --test tests/goal-role-authz.test.mjs tests/goal-per-client-token.test.mjs tests/request-authority.test.mjs tests/identity-pairing.test.mjs
node --test tests/native-acp-executor.test.mjs
.venv-memory/bin/python -m unittest discover -s tests -p 'memory_migration_test.py'
cd vendor/wechat-acp
node --import tsx/esm --test tests/session-foreground-background.test.ts tests/bridge-foreground-background.test.ts tests/session-timeout-retention.test.ts
```

测试输出摘录：角色/身份联跑45 pass/0 fail，migration72 OK，native55 pass/0 fail，前后台三文件15 pass/0 fail（约2251ms）。187是选定既有案例数，不是52项完成数；新的独立反例不被这些成功代替。

反例exit0表示采集成功，不是安全通过：Reviewer readonlyMarker=true而artifactModified=true/sandboxExit=0是缺陷；deadline fallbackPrompts=1、在第一次期限后启动、terminalOutcome=resolved是缺陷。修补后应相反且合法读/未过期fallback正常。

夹具开发失误已区分：首次shell/非canonical temp路径的OS实验未写成功，不作为只读安全证据；随后改用canonical目录与受控Node，实际复现。首版迁移夹具缺600/canonical来源而被拒，修正为有效合成source后两原反例通过。临时TS probe初因目录非ESM导致top-level-await失败；声明本机fixture type=module后运行，另修正fake fallback session初始processing应false，避免把mock未启动误认产品挂起。这些不是产品失败Finding。

初始executor冻结ea3127dd与最终0ebe00c8不同，包含并行scope/GUI占用切片。接受/缺陷必须按最终来源再次重放；Reviewer OS反例已在最终0ebe版重复得到同结果。整个native/GUI占用/取消语义并未审结。authority/current tests也含交接之外已共享的native输入变化，不给它们自动签字。

官方只读worker3个输入前后SHA一致，files_changed=[]，tests=[]；只作为定位协查。M01原预检有本线程历史参与，不自签整个预检系统。所有真实原文外呼、生产备份/迁回/重启与实际App会话都未进行。

Jev只接收测试范围和两组合成报告措辞，检查是否把隔离/子项接受夸大成整版上线：限定草稿Noul0.09、夸大对照0.98，模型jev-1.13.0；不是工程判断或授权，没有阈值放行动作，无真实payload/凭据输入。
