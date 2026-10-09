# Personal AI OS

Personal AI OS 是一个跑在 macOS 上的本地 AI 调度控制面。它将微信作为随时随地的移动入口，并在本地提供基于 Cezar 的 cockpit 进行任务管理，实现了一个真正的个人级自动化工作平台。

## 1. 为什么是 Personal AI OS？

**你的个人专属高效团队**
在传统工作模式下，你必须在电脑前才能执行复杂的软件开发和管理任务。一个人加上这套系统，相当于获得了一支随时在线的专业团队。你可以随时随地用微信沟通任务进度与突发灵感，不需要把自己绑在办公室。

**解决 AI 时代的“人为瓶颈”**
严重问题：AI 执行效率越来越高，人类审核细节的速度完全跟不上 AI 产出 PR/修改的速度，人工审核成为 AI 时代的人为瓶颈。
本系统通过**有界准入**（Grant / Approval / 独立 Reviewer / Evidence 门）设计，把人的角色从逐行审核的执行者，升级为规则制定者与抽查者。系统会自动隔离有副作用的操作，确保证据充分再执行。

**长期目标 (Goal) 可持久化与跨会话恢复**
我们的最终目标是实现长期的、跨会话的任务持久追踪，断电、网络中断或进程重启都不会丢失上下文，而不是简单地重发一次指令。

## 2. 能力一览

| 核心能力 | 它如何服务上述愿景 |
| --- | --- |
| **持久收件与可靠投递** | 消息在执行前先落盘，保证断线或重启后任务进度和反馈能够稳定恢复，不丢不漏。 |
| **共享记忆与上下文注入** | 自动记忆长期事实，每次执行前提供精准的业务背景，免去反复解释需求的成本。 |
| **独立审核与防错门禁** | 把有界限的任务丢进沙盒自测、复核，人只抽查不可逆的步骤，彻底破除人为审核瓶颈。 |
| **多引擎与组件化执行** | 后台解耦，灵活接入多种工具与执行模型，真正做到了能力可插拔、团队无限扩张。 |
| **随时响应的移动入口** | 借力微信，你只需通过简单指令下发意图，平台自动在后台编排，实现离线不掉线。 |

## 3. 架构与数据流

下面的架构图展示了从微信消息到后台任务执行、复核与返回的流转过程：

```mermaid
graph TD
    User([用户 / 微信]) -->|原始收件/转写| Bridge[WeChat Bridge]

    subgraph 控制面 [Control Plane (控制面)]
        CP_Inbox[MessageInbox]
        CP_Task[产品 Task / Execution / Evidence]
        CP_Grant[Grant / Approval 门禁]
    end

    subgraph 运行层 [Runtime Port (版本化接口)]
        Runtime_Pi[Pi Durable 运行时]
        Runtime_Legacy[Legacy 适配器]
    end

    subgraph 执行与记忆
        Workers[CLI Workers / Native ACP / Cezar]
        Goals[持续目标服务 / 自动返工]
        Memory[(Mem0 共享记忆 / 事实库)]
    end

    subgraph UI/控制台 [Cezar UI / Web]
        AUI[同源代理 AUI-03 / Loopback 边界]
    end

    Bridge --> CP_Inbox
    CP_Inbox --> CP_Task
    CP_Task <--> CP_Grant
    CP_Task --> Runtime_Pi
    CP_Task -.->|迁移期限定| Runtime_Legacy

    Runtime_Pi --> Workers
    Runtime_Pi <--> Goals
    Runtime_Pi <--> Memory

    AUI <--> CP_Task
    AUI <--> Goals

    Workers -->|独立 Reviewer + Completion Proof| CP_Task
    CP_Task --> Outbox[持久 Outbox]
    Outbox -->|通知/消息投递| Bridge

    classDef boundary stroke-dasharray: 5 5;
    class 控制面,运行层 boundary;
```
> *注：图中明确标注了 loopback 端口边界与后续由 AUI-03 同源代理管控的安全投射访问。*

## 4. 平台兼容性

当前项目的开发、验证与运行强依赖特定操作系统的底层服务（如 `launchd`）。

| 平台类别 | 平台 | 当前状态与说明 |
| --- | --- | --- |
| **操作系统** | macOS | **当前唯一开发/验证平台**。常驻服务依赖 `launchd`，且部分组件依赖本地路径。 |
| | Linux / Windows | 未开始，目前仅作为远期兼容性探索目标，**不支持**生产运行。 |
| **通讯入口** | 微信 | **已接入**并稳定运行，使用专用的 WeChat Bridge 连接控制面。 |
| | 飞书 / WhatsApp / Slack 等 | 作为候选的平台化接入模板评估中，**目前未接入，亦不承诺发布**。 |

## 5. 快速开始与部署指导

### 5.1 本地开发启动步骤

由于目前仅在 macOS 上进行过部署和验证，请在 macOS 系统下按如下步骤初始化。

1. **依赖安装**
   ```bash
   npm install
   ```
2. **构建 Vendor 依赖**
   微信桥与核心控制面强依赖底层子项目的编译：
   ```bash
   cd vendor/cezar
   npm run typecheck && npm test
   cd ../..
   ```
3. **启动控制面与各服务 (推荐基于 launchd)**
   系统通过多个服务协调工作，端口均限定在 `127.0.0.1` 环回地址。启动入口均配置为 macOS `launchd` 的 plist 文件以实现常驻：
   - 控制面 (`com.markus.ai-agent-cockpit.control-plane`): `:4324`
   - Kimi 反代 (`com.markus.ai-agent-cockpit.kimi-shim`): `:4323`
   - 持续目标服务 (`com.markus.personal-ai-os.goals`): `:4326`
   - 微信控制服务 (`com.markus.ai-agent-cockpit.wechat-control`): `:4322`
   - Cezar cockpit (`com.markus.ai-agent-cockpit.cezar`): `:4321`
   - 记忆服务 (`com.markus.personal-ai-os.memory`): `:4325` (Python 服务)

   可以直接使用开发辅助脚本（需根据本地路径调整）：
   ```bash
   # 测试并拉起核心环境
   npm run control-plane &
   npm run goals &
   ```
   > 真实部署建议使用 `launchctl load` 挂载 `launchd/` 下对应的 `.plist` 配置文件。

### 5.2 核心测试命令

确保项目修改后，必须运行并通过所有单元测试和集成测试：

```bash
# 测试控制面、契约及相关逻辑
node --test tests/*.test.mjs

# 测试共享记忆服务 (Python 环境)
.venv-memory/bin/python -m unittest discover -s tests -p 'memory_*test.py'

# 测试 Cezar 运行时与组件
cd vendor/cezar && npm run typecheck && npm test
```

## 6. 项目状态与演进里程碑

**当前状态**：生产版本基线为 **0.2.2**；目前正处于 **0.3.0 升级进行中** (执行 M01–M08 里程碑计划)。

> ⚠️ **诚实声明**：本机上的所有特性并未全部完备。项目正在向 0.3.0 进行多维度升级，目前不能宣称生产完全可用或全线能力已交付。具体完成情况与待验证事项，请严格查阅 [docs/plans/0.3.0-status.md](docs/plans/0.3.0-status.md)。

## 7. 命名与致谢

- **项目更名**：本项目已从原项目名 `ai-agent-cockpit` 正式演进并重命名为 **Personal AI OS**（个人仓库公开时随之更新）。为保持历史兼容，部分本地状态配置路径（如 `~/.wechat-acp` 等）尚未完全迁移，后续会逐步随架构收敛。
- **特别致谢**：项目控制台与部分执行抽象基于开源项目 [Cezar](https://github.com/open-mercato/cezar) (保留在 `vendor/cezar` 目录下)。我们对上游的启发和贡献表示诚挚致谢。*(为避免产品概念混淆，我们的上层调度与系统名称现已统一，不再使用旧名称)*。
