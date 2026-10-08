---
title: Personal AI OS · 双AI协作
subtitle: 它推进实现，我们审计并优化方案/计划
lang: zh
template: sheet
theme: paper
source: 2026-10-08 · 本线程实现Goal保持paused
---

## A 分工已经明确

| 角色 | 主责 | 边界 |
| --- | --- | --- |
| 执行AI | 写功能、测试、修复，交可复现证据 | 不自签独立审计、不擅自上线 |
| 我们 | 读差异/证据，审计，优化方案和执行顺序 | 不抢写功能、不代修、不恢复实现Goal |
| Markus | 定方向、重大取舍和高风险批准 | 不逐函数人工盯开发 |

本线程Goal真实状态为paused，没有启动新实现Worker。
计划文档已加最新分工，旧blocked提示不再当现状。
对方具体App/线程/branch和协议ACK仍待交接填写。

## B 每一批怎样接力

```flow LR
它实现与自测 -> 固定版本与交接包 -> 我们审计
我们审计 -> Finding与计划修订 -> 它返工与新revision
它返工与新revision -> 我们复核 -> 下一工作包
```

交接必须有源码版本、文件hash、测试/失败及未覆盖范围。
HEAD不能包含全部dirty/untracked变化，需要批次sourceRef。
审计前后代码漂移，旧结论不能给新版本背书。
等待审计时，它可做已准且不冲突的独立工作。

协议及初次发给同事的短指令在[协作协议](../plans/0.3.0-collaboration.md)。
[执行交接模板](../collaboration/execution-handoff-template.md)写入docs/handoffs。
[审计结果模板](../collaboration/audit-result-template.md)写入docs/audits。

## C 当前核对到的缺口

已看到migration.py和迁移测试新增，读取期间仍有变化。
尚无固定交接包，本轮没有运行迁移或签审计通过。
第一批重点验：只读源与安全目标、WAL、原文/ID/时间守恒。
还验重入/漂移/崩溃、忘记/跨用户/秘密、向量效果与召回。

自测、独立审计和生产验证分列。
“组件合成测试通过”不等于“整套上线24h稳定”。
Jev只提醒措辞越界，实际Gate按代码与证据判定。
本轮合成措辞Jev检查不含私有聊天/原文或密钥。

## D 接下来无需重建系统

把协议里的短指令发给执行同事一次。
让它填写身份/branch与ACK，提交首个READY_FOR_REVIEW批次。
你在本线程说“审计最新交接批次”，我直接读共享文件。
发现缺陷给Finding ID，非阻断建议进backlog。

目前只有共享文件协作约定，没有自动跨App消息通道。
没有定时监听或新监督Goal，不宣称离线持续监控。
我只写审计/规划文档，未改同事的功能、测试或包配置。
原52项验收、C01–C15、迁移回退和真机门槛不缩小。
