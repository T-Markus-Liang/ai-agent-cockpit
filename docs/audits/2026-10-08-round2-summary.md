---
title: 0.3.0 第二轮并行审计
subtitle: 更正 · 删除 · 会话权限 · 身份配对
lang: zh
template: sheet
theme: paper
cols: 2
---

## A 这轮的结论

```callout warn 3 批需修改，1 批限范围通过
4 个 r1 组件的原有 76 项测试通过。
专项复现另发现 5 项缺陷。
身份配对仅接受纯内存核心，完整接线仍待验证。
```

复测使用冻结副本，禁止网络和真实用户目录读写。
本线程只改审计与计划，没有接管功能或重启服务。

## B 权限：两个异步窗口

| Finding | 实际复现 | 必须修复 |
| --- | --- | --- |
| SP-F001 | 会话已关闭，等待中的审批仍返回 allow | 加入会话代际与关闭屏障 |
| SP-F002 | 同一工具调用并发，获得两次 allow | 在等待之前预留调用 ID 并绑定参数 |

第二例中的两份审批各自有效。
问题是同一调用身份被放行两次，不是无审批越权。
测试没有启动真实工具。

[会话权限完整报告](/Users/markus/ai-agent-cockpit/docs/audits/m02-session-permission-broker-r1.md)

## C 记忆：不能只看成功标记

| Finding | 实际复现 | 必须修复 |
| --- | --- | --- |
| RC-F001 | 更正链 A 与 B 成环，C 仍为 current | 检查完整图，而不只检查终点存在 |
| PG-F001 | 原文未擦除，仍返回 verified | 核验实际内容，不只核验 purged 标记 |
| PG-F002 | 目标摘要已漂移，删除后才报错 | 在不可逆效果前校验当前目标 |

删除测试使用合成回调，没有删除真实用户数据。
本轮未复跑真实 SDK 删除脚本。

[更正报告](/Users/markus/ai-agent-cockpit/docs/audits/i02-memory-reconcile-r1.md)

[删除报告](/Users/markus/ai-agent-cockpit/docs/audits/i02-memory-purge-r1.md)

## D 身份核心通过，不代表全路通过

| 路径 | 本轮结论 |
| --- | --- |
| 直接配对、鉴权、轮换、撤销、过期 | ok 纯内存核心限范围接受 |
| 导出的旧 HTTP 鉴权快照 | warn 仍接受已失效的凭据 |
| HTTP、MCP、工具权限持续同步 | warn 接线证据待补 |

修复清单、负例与顺序已写入共享文档。
同事可继续无冲突工作，按 Finding ID 提交 r2。
上一轮问题不因加入新模块自动关闭。

[身份报告](/Users/markus/ai-agent-cockpit/docs/audits/m02-identity-pairing-r1.md)

[审计索引](/Users/markus/ai-agent-cockpit/docs/audits/README.md)

[原始结果与固定版本](/Users/markus/ai-agent-cockpit/docs/audits/evidence/2026-10-08-round2/README.md)
