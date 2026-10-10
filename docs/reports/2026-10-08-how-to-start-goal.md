---
title: 按0.3.0 Prompt启动长期Goal
subtitle: 当前线程先恢复已有目标，再指定完整文件与检查点
lang: zh
template: sheet
theme: paper
source: 2026-10-08 · 当前旧Goal仍blocked
---

## A 当前对话：推荐这样操作

在Codex聊天输入框单独发送第一条消息：

```text
/goal resume
```

然后另发一条消息，明确执行文件：

```text
请完整读取 /Users/markus/ai-agent-cockpit/docs/plans/0.3.0-goal-prompt.md，按照其中的长期Goal合同，在 /Users/markus/ai-agent-cockpit 项目中持续完成0.3.0升级。
先读取 docs/plans/0.3.0-resume.md，从下一检查点继续，不重建或重复已完成工作。
持续实现、测试、修复和记录证据，直到满足文档的完整完成条件，不要只整理文档。
保留用户改动、原生历史、微信身份和旧记忆；生产切换、迁移、外发、删除等仍按文档取得具体范围确认。
```

当前已有未完成Goal，不能直接再建一个。
不要把它标complete或随手clear来绕过限制。
也不要把这两条消息合成 /goal resume 的参数。

## B 如何确认不是普通聊天

再单独发送：

```text
/goal
```

检查Goal面板/返回状态是否为active。
若仍blocked、paused或budget-limited，自动续轮未启动。
把实际返回发给我，不凭助手口头“已开始”判断。

| 控制 | 命令 |
| --- | --- |
| 查看 | /goal |
| 暂停 | /goal pause |
| 恢复 | /goal resume |

操作口径参考[OpenAI官方Goals说明](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex)。
官方说明确认生命周期由用户/系统控制，不由模型改成active。

## C 如果使用新对话

在项目对应的新Codex对话中直接发送：

```text
/goal 完整读取 /Users/markus/ai-agent-cockpit/docs/plans/0.3.0-goal-prompt.md，按其中的M01–M08和完成标准持续完成Personal AI OS 0.3.0升级。先读0.3.0-resume.md，从已有检查点继续；实现→测试→修复→复核→记录→继续。保留脏工作树、身份、历史、旧记忆与未发文本；高风险动作仍遵守原授权边界，不把源码/组件通过冒充部署或完整完成。
```

推荐沿用当前线程，避免丢失上下文或双线程写同一项目。
不要同时保持两个针对本项目的活跃执行Goal。
这些是Codex聊天命令，不是在zsh执行的shell命令。
也不是微信的 /目标 或本项目4326 Goal服务命令。

长任务需要宿主持续运行和联网。
真正休眠不能执行；权限/预算/工具限制仍可能停下。
提示词、持续Goal和已启动后台守护服务是不同概念。
