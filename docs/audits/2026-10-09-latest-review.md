# 2026-10-09 最新复核与执行交接

审计者：本线程主审；未参与本批功能修复。本报告将前一 review 回合实际证据正式入档，本次文档更新没有重新运行完整测试。版本核对：HEAD `c0125a8d4719783aad1e1acef8a0af45346f43cf`；相关源码本次 hash 与 review 时一致。PR #1 OPEN、同 HEAD、检查列表为空（不等于 CI 通过）。

## 结论与固定来源

| 批次/交接 | 裁决 | 证据与边界 |
| --- | --- | --- |
| [FG r2](../handoffs/p3-foreground-background-r2.md) | COMPONENT_ACCEPTED，原 FG-F001 限定关闭 | 六套件 36 项通过；原期限反例 fallbackPrompts=0、createdFallbackSessions=0、terminalOutcome=rejected。正式 per-task Grant、配置迁移仍待 |
| [RO r2](../handoffs/p4-reviewer-readonly-r2.md) | COMPONENT_ACCEPTED，原 RO-F001 限定关闭 | 82 项通过；真实 sandbox-exec 写 artifact 遭 EPERM，artifactModified=false。只限 native-acp，不含其他执行路径/真实 CLI scratch 联调 |
| [Snapshot r1](../handoffs/p6-snapshot-orchestrator-r1.md) | CHANGES_REQUESTED | 快照/转换/演练 36 项通过，但三项独立边界反例仍复现，见下文 |
| 转换/回退生产能力 | EVIDENCE_REQUIRED | 测试演练不等于已存在生产 restore 编排；跨 store freeze/watermark 和新数据保护待补 |
| 其余积压 | 本报告未裁决 | 不能把 154 项选定回归等同所有交接或整版验收 |

相关 source SHA256：

```text
9008c017711cb99ddc81b320d94cd78344318ab301e2e41877fcce94cf226a3d  control-plane/snapshot-orchestrator.mjs
de39cee141ba4e0cef522d8799f69ea9a9ab770f5e39f5e901ee93d992bc701f  control-plane/native-sandbox.mjs
ba62451128e1d1c8d2852148c492d7cdb769395b744b0c75b5fd158f7e7c9cf0  control-plane/native-acp-executor.mjs
60b15d6fb0b9121a39ca79b8cf9563e3776446abc21482fbaa0bb785ce887c03  vendor/wechat-acp/src/acp/session.ts
dd9cb86f71fa6e27b36895cc918e5f52d9106aaf2a1f717924ca5ee6b72b73e2  vendor/wechat-acp/src/bridge.ts
```

上述裁决只覆盖交接和已复测路径；后续实现修改直接依赖也要重新核对。此前交接的完整依赖 hash 应由执行方随新包携带，不把这些五个 hash 当整个发布版本清单。

## P1 / Major：三个阻断快照生产准入的 Finding

| ID | 源码定位 | 复现与影响 | 返工验收 |
| --- | --- | --- | --- |
| SN-F001 | snapshot-orchestrator.mjs:507 | quiesce 先暂停后 throw，未 push 入 quiesced；resumeCalls=0、storeStillPaused=true，清单标 skipped | 先记录 intent；未知结果可重开核对；owner/fence 下幂等恢复；不盲目 resume |
| SN-F002 | 同文件:385、513、306 | store.name 为 ../victim 被接受，越出本轮目录并替换已有空目录，仍 success | 单段命名/保留名校验、目标 containment、独占创建与禁止覆盖，拒绝零变化 |
| SN-F003 | 同文件:163、530、546、564 | 任意错误 message 进 manifest；合成 canary 明文持久化 | 固定错误码与阶段白名单；message/name/stack/cause 不透传 |

这些是源码缺陷，不以生产授权缺失为修复前置。SN-F003 是合成凭据通道证据，不是本轮发现真实 API key 泄漏。

独立探针的最小重现步骤（全部在自建临时目录）：

1. 注册 fake adapter：quiesce 设置 paused=true 后抛含合成 canary 的 Error；resume 增计数并清 paused；运行后核对 manifest 与 paused/计数。
2. 创建 source 文件目录和 backups/victim 空目录，记录 victim inode；注册 name='../victim' 的 filedir store；runId 使用正常单段，运行后对比 victim inode 与复制内容。
3. 断言合成 canary 是否出现在返回 manifest；不要把真实凭据放入探针。

review 回合原始结果（仅脱敏布尔和状态）：

```json
{"quiesceAndError":{"syntheticOnly":true,"productionTouched":false,"models":0,"status":"failed","storeStillPaused":true,"resumeCalls":0,"quiesceOrder":[],"resumeOrder":[],"manifestContainsSyntheticCredential":true,"recordedStores":[{"name":"TESTONLY-store","status":"skipped"}]},"traversal":{"status":"success","acceptedTraversalName":true,"victimReplaced":true,"victimContainsCopiedData":true}}
```

探针当时退出 0 表示观测完成，不表示模块通过。返工必须将这些观测转为明确的回归断言。临时原脚本位于 `/tmp/personal-ai-os-approval-review.uX8b6W/snapshot-boundary-probe.mjs`；该路径可能过期，以上步骤和结果为可持久重建依据。

## 已实际运行的入口

```sh
# 仓库根：118 项（82 native + 36 快照/转换/演练），exit 0
node --test --test-reporter=dot tests/native-sandbox.test.mjs tests/native-acp-executor.test.mjs tests/snapshot-orchestrator.test.mjs tests/state-converter.test.mjs tests/migration-rollback-drill.test.mjs
# vendor/wechat-acp：36 项，exit 0
node --import tsx/esm --test --test-reporter=dot tests/grant-deadline-inherit.test.ts tests/fallback-policy-parity.test.ts tests/session-foreground-background.test.ts tests/session-timeout-retention.test.ts tests/dispatch-window.test.ts tests/bridge-recovery.test.ts
# 仓库根：独立旧反例，均 exit 0；按输出字段判断修复
node docs/audits/evidence/2026-10-08-followup/reviewer-os-probe.mjs
node --import ./vendor/wechat-acp/node_modules/tsx/dist/esm/index.mjs docs/audits/evidence/2026-10-08-followup/deadline-fallback-probe.ts
```

## 部署差额与下一动作

前一 review 回合只读核对：goals/mem0 默认 authority.json 均 ENOENT；仓库 config/wechat-acp.json 只有旧 promptTimeoutMs=300000，新代码默认 grantDeadlineMs=1800000。实际部署还须核对环境覆盖，不能仅据默认路径断言所有运行请求都失败。没有现场重启。

quality.py 的 selection/completeness/no_facts/semantic state 含完整 user_text；旧记录外呼不能宣称只发送最小 quote。生产回退、真实 CLI/微信与 24h 未在本轮验证。

下一动作按[整改执行方案](../plans/0.3.0-remediation-2026-10-09.md)：先 S01；并行无冲突 S02/S03/S04；再按匹配授权进入 S05/S06。这里的并行指工作安排，不声明已启动任何 agent。

未改源码、生产状态、权限或远端 PR/告警；没有产品 Approval、生产迁移或发布签字。typesafe-ai/jev-eval 仅检查无敏感信息的交接措辞，jev-1.13.0 的 boundary_clear=0.87（408 input/21 output tokens），advisory 不参与工程/授权裁决。
