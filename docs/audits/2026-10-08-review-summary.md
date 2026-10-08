---
title: 0.3.0 第一轮并行审计
subtitle: M01 迁移 · M02 运行时所有权
lang: zh
template: sheet
theme: paper
cols: 2
---

## A 结论与范围

```callout warn 两个 r1 批次均需修改
原有记忆测试 132 项、运行时测试 62 项通过。
专项探针另复现 7 项缺陷，未被原有测试拦住。
这些结果不能证明完整 0.3.0 可以上线。
```

复测使用冻结副本、合成数据和网络隔离。
本线程没有改功能、重启服务或迁移生产数据。

## B 记忆迁移：4 项缺陷

| ID | 实际复现 | 需要修复 |
| --- | --- | --- |
| M01-F001 | 既有目标库和外部目录链接被接受并修改 | 写入前校验目标来源和路径 |
| M01-F002 | 目标时间错误，仍报告守恒成功 | 按原文、身份、时间和事件逐项校验 |
| M01-F003 | 忘记已提交，仍新增一个向量 | 加入隐私屏障和在途效果处理 |
| M01-F004 | 存储失败后，又调用模型重新提炼 | 持久保存计划，恢复时复用 |

F003 没有证明已忘记内容被召回。
确定的问题是新向量效果和错误的 validated 结算。

[查看 M01 完整报告](/Users/markus/ai-agent-cockpit/docs/audits/m01-migration-r1.md)

## C 运行时：3 项缺陷

| ID | 实际复现 | 需要修复 |
| --- | --- | --- |
| M02-F001 | 停止活跃前台后，后台仍排队 | 后台需独立所有权或可靠推进机制 |
| M02-F002 | 报告 aborted，混合任务中的前台仍完成 | 取消结果必须符合实际任务状态 |
| M02-F003 | 无绑定后台能运行，却无法按范围停止 | 入队前强制验证 Execution 绑定 |

真实长后台、完整取消链和 24h 稳定性仍待验证。
短时间的假模型测试不能替代这些证据。

[查看 M02 完整报告](/Users/markus/ai-agent-cockpit/docs/audits/m02-runtime-ownership-r1.md)

## D 与执行同事接力

```flow
执行同事 -> r2修复包: 按 Finding ID 修复
r2修复包 -> 隔离回归: 新版本与反向负例
隔离回归 -> 主审复核: 关闭缺陷并记录证据
```

修复要求与测试计划已写入共享文档。
另有 11 个交接排队待审，不算已经通过。
同事可继续无冲突工作，不冻结整个项目。

[审计索引与待审队列](/Users/markus/ai-agent-cockpit/docs/audits/README.md)

[原始结果与版本证据](/Users/markus/ai-agent-cockpit/docs/audits/evidence/2026-10-08-r1/README.md)

[已更新的执行计划](/Users/markus/ai-agent-cockpit/docs/plans/0.3.0-execution.md)
