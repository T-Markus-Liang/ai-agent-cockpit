# Personal AI OS

当前版本：**0.2.1 微信语音可靠性修复版**。新增私有持久收件箱，修复前一轮超时后丢弃排队消息与超时提示被拦截的问题；完整转写先保存，后续消息继续排队。详见 [修复与验证](docs/releases/0.2.1.md)。

0.2.0 的持续目标预览功能保留：确认范围后在私有工作副本里自主修复、验证、复核和返工，不自动覆盖原项目或恢复原生 App 旧会话。详见 [持续目标说明](docs/releases/0.2.0.md)。

Personal AI OS 是运行在 macOS 本机上的 AI 调度控制面：微信是移动入口，Cezar 是本地 cockpit，Codex / OpenCode / Kimi / WorkBuddy / Devin / Claude Code / Antigravity 是可插拔的 Agent 或 Provider。项目当前仍使用 `ai-agent-cockpit` 目录和既有 launchd 标签，以保证旧服务、微信身份和原生会话不被迁移或破坏。

它不是把所有 App 历史复制到一个新数据库，也不是给每个 GUI App 强行套一个“已支持”的标签。Personal AI OS 先建立可审计的 Task、SessionRef、Execution 和 Evidence 边界，再逐步增加 Chief 调度、审批和验证闭环。

## 当前已运行

| 入口/组件 | 地址或方式 | 当前职责 |
| --- | --- | --- |
| Cezar cockpit | <http://127.0.0.1:4321> | 本地任务、工作树和运行界面 |
| 微信控制服务 | <http://127.0.0.1:4322> | 二维码、登录状态和 bridge 启动控制 |
| Personal AI OS 控制面 | <http://127.0.0.1:4324> | 本机会话元数据索引、Task/Execution 状态和 Agent 来源能力边界 |
| 微信 ACP bridge | launchd | 微信 → 默认 Kimi，失败/超时按配置顺序 fallback；各模型使用同一共享记忆 |
| Mem0 OSS 记忆服务 | <http://127.0.0.1:4325/health> | 本地多语言向量检索、持久入库队列；用户事实由现有 Kimi API 提炼 |
| 持续目标服务 | <http://127.0.0.1:4326/health> | 版本绑定的范围授权、租约/心跳、检查点、预算、自动返工；默认一条目标运行 |
| Provider shim | launchd | Kimi、DeepSeek、GLM、Antigravity 等本机已有反代/配置 |

已完成的第一轮重构包括：

- `control-plane/contracts.mjs`：运行时校验的 Task、SessionRef、Execution、Evidence、Approval、AgentCapability 契约。
- `control-plane/store.mjs`：私有状态目录中的原子持久化、幂等键、有限状态转移、Evidence、审批、会话锁和重启恢复保护。
- Task 完成门槛：所有 Execution 终态、至少一个 succeeded、test/command Evidence、独立 review Evidence，并消费精确绑定的完成 Approval。
- Reviewer Execution 会保留 parent Execution 关联，只创建可审计 review child，不会自动启动或伪装成 Worker 原上下文。
- `control-plane/session-index.mjs`：只读发现 Codex、OpenCode、Kimi 的本地会话元数据；发现 WorkBuddy、Devin、Claude Code、Antigravity 时明确报告“入口已发现、历史索引未支持”。
- `control-plane/session-adapters.mjs`：按明确来源和原生 ID 查询元数据；恢复只返回未验证计划，不静默启动新会话。
- `control-plane/native-acp-executor.mjs`：在精确 Approval 下 load 并 prompt 已有 ACP 会话；输出进入 VERIFYING，失败进入 BLOCKED。
- `control-plane/router.mjs`：先用确定性 capability/policy gate 过滤候选，再可选调用 Jev 做 advisory 排序；RoutePlan 本身无副作用，不能授权执行。
- `adapters/engines/cezar.mjs` + `control-plane/dispatcher.mjs`：Cezar run/worktree、reconcile 和取消接入；真实派单/取消必须有精确绑定且未消费的 Approval。
- `interfaces/mcp/server.mjs`：Chief 可用的 MCP 工具层；默认只创建控制面对象，不直接启动外部 Agent。
- `gateway/control-plane.mjs`：回环地址 HTTP API，持久化自己的 Task/Execution 状态，但不写外部 Agent 历史，不读取认证文件或消息正文。
- `config/wechat-acp.json`：在 Codex ACP 支持 HTTP MCP 时注入控制面工具；不支持时保持原有桥接和 fallback 行为。
- 微信显式审批命令：`/approve <approval_id>`、`/reject <approval_id>`，并支持 `/批准`、`/拒绝`；命令只改变 Approval 状态，不绕过控制面执行门槛。
- Cezar Dashboard / Settings 的系统连接和本机 Agent 页面会读取 `4324/api/control-plane/capabilities`，把“已发现”“已连接”“待验证”“不可用”分开显示。
- Dashboard 的待审批动作卡片使用同一 Approval API；批准/拒绝不会绕过服务端的目标、参数摘要和有效期校验。
- Workflows 页面顶部新增 Personal AI OS 控制面工作流图：微信入口 → Chief → Router → Task/Execution → Worker → Reviewer/Verification → Approval/Completion；下方仍保留 Cezar 原生技能链编辑器。
- Feature Map 也会显示 Devin Cloud / GitHub Actions 的只读入口发现，但不会读取密钥、触发云任务或推断计费/权限可用。
- `scripts/control-plane.mjs`：CLI 会话索引查询。
- `launchd/com.markus.ai-agent-cockpit.control-plane.plist`：控制面常驻定义；可按需加载，不改变旧服务。
- `scripts/start-local.sh`：增加控制面健康检查和启动。

## 快速开始

```bash
cd /Users/markus/ai-agent-cockpit

# 启动仍未运行的本地入口（Cezar、微信控制、Personal AI OS 控制面）
./scripts/start-local.sh

# 查看本机 Agent 会话元数据（只读）
npm run sessions
npm run sessions -- --json --provider=codex --limit=20
# 显式调用 Codex ACP session/list（只读，不 load、不 prompt）
npm run sessions -- sessions native-list --provider=codex --cwd="$PWD" --json

# 运行控制面契约和隐私边界测试
npm run test:control-plane

# 运行协议级回归评估（临时状态目录，不调用模型）
npm run eval:control-plane

# 一次性诊断 Cezar、微信、控制面、Mem0、Feature Map 和回归评估
npm run doctor
```

## 微信语音与可靠收件（0.2.1）

`config/wechat-acp.json` 已启用 `inbound.enabled` 和 `inbound.acknowledgeVoice`。桥接器先把完整服务器转写和消息元数据写入实例的私有 `incoming-receipts/`，再推进轮询游标；文件名不包含用户名，目录为 0700，回执为 0600，不提交 Git。语音先收到保存确认，长处理约 10 秒后给出进度提示。

前一轮超时后，尚未开始的消息保留并按顺序继续；清理未确认时只保留队列，不启动重叠进程。服务重启只恢复未开始的消息；已经执行或缓冲中的消息标记为结果不确定，不盲目重放。微信发送 `/消息` 可查看最近 5 条收件状态，`/取消` 中止当前处理。`done` 表示对话轮次结束，不是控制面任务验收通过或外部投递成功的证明。

本版依赖微信返回的语音转写；没有转写时明确提示重发或使用文字，未实现原始音频下载和 ASR。前台仍有 5 分钟处理上限，不代表任意长任务已经独立后台运行。旧版本已经丢失且仅剩日志预览的语音需要重发。

```bash
npm --prefix vendor/wechat-acp run build
npm --prefix vendor/wechat-acp test
npm run test:voice-live  # 真实 Kimi ACP 隔离验证；不发真实微信消息
```

## 微信共享记忆（已部署 Mem0 OSS）

微信主对话使用 Kimi。每轮实际派发前统一注入人格规则、近期对话、较早的有损摘录和 Mem0 检索到的相关事实；切换 fallback 不更换用户的记忆命名空间。近期上下文并非全部历史，Mem0 也不是原生 Agent 工具状态的无损复制。

完整对话正文追加到私有 `conversation-archive/*.jsonl`；近期快照和持久 outbox 仍由微信实例管理。Mem0 在本机使用 Qdrant + SQLite，目录位于 `~/.local/state/personal-ai-os/mem0/`，不提交 Git。只从用户表述提炼长期事实，不把助手推测当作事实。

记忆服务不可用时，桥接器继续使用本地上下文；上传记录保留，服务恢复后重试。过长正文只在提炼输入中分块，归档不截断；永久拒绝的记录保留在私有 `rejectedOutbox`，不会阻塞后续上传。交付语义是 at-least-once，不保证断电窗口中的 exactly-once。

**存储和 embedding 本地运行，但事实提炼会调用现有 Kimi API，不是全离线。** 常见 token 格式会在提炼前屏蔽，不能保证识别所有秘密；不要在微信对话中发送密钥。Dashboard 与设置里的系统连接显示 Mem0 实时健康/队列和配置的微信主 Agent，而非固定的 Codex 标签。

安装、固定依赖和运维说明见 [记忆服务文档](services/memory/README.md)。

```bash
npm run test:memory-service  # 鉴权、隔离、幂等、持久重试、权限与提炼边界
npm run test:memory-live     # 真实 Mem0 + Kimi 中文提炼/召回（少量模型调用）
npm run test:memory-kimi     # 真实 Kimi ACP 使用注入记忆；不发真实微信消息
npm run test:memory-recovery # macOS：短暂停止 Mem0，验证降级/恢复；不停止微信
```

部署时回填了旧快照尚存的 9 条对话正文，并生成私有备份；此前已被截断/删除的历史无法重建。本轮测试结论和未验证边界见 [执行记录](EXECUTION.md#62-mem0-部署与验收2026-10-06)。

## 持续目标怎么用

在仪表盘“持续目标 · 自主验证”创建草稿，查看文件范围、不可修改的验收和 token 上限，再点击“确认范围并启动”。默认示例是非生产加法函数修复。Kimi 负责规划/复核，官方 DeepSeek V4.1 Flash 提出修改；修改只应用到私有副本，真实 Node 测试在 macOS Seatbelt 下运行。

微信发送 `/目标` 抽查进度；支持查看、暂停、恢复、取消及暂停全部。确认目标需完整 scope digest，聊天模型不能替你批准。暂不支持从一句任意需求直接无人值守操作所有 App。

```bash
npm run test:goals       # 范围、租约、预算、验收、真实隔离与返工
npm run test:goals-live  # 真实 Kimi/DeepSeek 合成修复试运行，会产生少量模型费用
GOAL_LIVE_RETRY=1 npm run test:goals-live # 真实模型遇到一次验收故障后自行继续
npm run goal-status
npm run goal-status -- get goal_ID
```

`~/.local/state/personal-ai-os/goals/` 保存 0700 私有目录、0600 token/状态、结果副本和单独的 Task/Evidence 存储。获批文件内容会发送给既有 provider；不是全离线。首版只支持已有文本文件、固定不可修改的 Node 验收；源码合并、任意原生 App 自动执行、外部反馈订阅和全天耐久仍需后续验收。

`native-load-probe` 是显式的本机验证命令，会调用指定 Codex `session/load`；它没有暴露给 MCP/自动 Chief，避免无审批恢复外部会话。

也可以直接访问：

```text
GET http://127.0.0.1:4324/health
GET http://127.0.0.1:4324/api/control-plane/sources
GET http://127.0.0.1:4324/api/control-plane/sessions?provider=opencode&limit=50
GET http://127.0.0.1:4324/api/control-plane/tasks
GET http://127.0.0.1:4324/api/control-plane/audit?limit=50
POST http://127.0.0.1:4324/api/control-plane/route-plan
POST http://127.0.0.1:4324/api/control-plane/tasks  # 必须带 Idempotency-Key
POST http://127.0.0.1:4324/mcp                    # JSON-RPC tools/list / tools/call
```

控制面默认只监听 `127.0.0.1`。索引快照会声明 `readOnly=true`、`secretsRead=false`、`messageBodiesRead=false`；控制面只写自己的状态文件，不写外部 Agent 历史。所有写操作要求幂等键，Cezar 派单还要求动作、目标、参数摘要完全匹配的审批。任何 Agent 的恢复能力只记录原生命令提示和验证限制，不会因为“发现了可执行文件”就声称旧会话可以安全恢复。

## 架构原则

```text
微信 / 手机网页
        ↓
Chief（当前微信默认 Kimi；可替换）
        ↓
Task / SessionRef / Execution / Policy / Evidence 控制面
        ↓
Worker 与执行适配器
  ├─ Cezar：run、worktree、review gate
  ├─ Codex / OpenCode / Kimi：CLI 或 ACP
  ├─ WorkBuddy / Devin：已确认入口，历史和认证能力按证据逐步接入
  └─ Antigravity：Provider 反代或 GUI，不伪装成稳定本地会话 API
```

核心边界：

1. Session 由原生 Agent 管理；Task、Execution 和审计事件由控制面管理。标题不能作为会话身份，恢复必须绑定来源、profile、原生 ID 和工作目录。
2. Worker 报告完成后必须经过验证和 review，不能直接把任务标成最终完成。
3. fallback 只在尚未产生可确认副作用的启动失败、超时或协议错误边界内执行；已有副作用的执行不会被静默重试。
4. 工作目录不是沙箱。控制面不会通过 bypass、自动批准或复制凭据来“修复”接入失败。
5. 本机 Devin 与 Devin Cloud 是两个不同适配器；本机 ACP 握手成功不代表云端、认证、计费或旧会话恢复已经打通。

## Agent 接入现状

| Agent | 会话元数据 | 原生恢复提示 | 目前限制 |
| --- | --- | --- | --- |
| Codex | SQLite + 显式 ACP `session/list` 只读索引 | ACP `session/load` / `session/resume` 已被 capability probe 证实存在 | 未执行恢复、prompt 或工具调用 |
| OpenCode | SQLite + ACP `session/list` 只读索引 | ACP load/resume capability 已实测 | 未执行 load、prompt 或消息读取 |
| Kimi CLI | `session_index.jsonl` + ACP `session/list` | ACP load/resume capability 已实测 | 新建隔离 ACP 会话的真实 prompt/记忆召回已通过；用户旧会话恢复仍未验收 |
| WorkBuddy | 已发现 App/`codebuddy --acp`，ACP initialize 成功 | 声明 loadSession/MCP，但未声明 session/list | 旧会话不能由控制面猜测或静默创建 |
| Devin | App/ACP `session/list` 已实测 | 声明 loadSession，未声明 resume | 真实 prompt、认证、load 和云端能力仍待验证 |
| Claude Code | 已发现本地入口 | 原生 session 机制 | 本版本不读取 `~/.claude` 历史 |
| Antigravity | 已发现 App/本机反代 | GUI-only / proxy | 没有稳定的本地旧会话索引 |

## 文档

- [架构设计 v1.2](personal_ai_os_wechat_mac_agent_architecture_v1.html)：产品边界、Task/Session/Execution 模型、pstack / SpaceXAI 方法论和路线图。
- [执行文档](EXECUTION.md)：每个阶段的实际状态、验证命令、证据边界、回退方案和未完成项。
- [微信配置说明](config/README.md) 与 [Gateway 说明](gateway/README.md)：兼容期入口和本机凭据边界。

设计吸收了 Lauren Tan / SpaceXAI 的 pstack 思路：skill-first routing、Chief + specialized workers、并行候选与顺序降级、verification-first、独立 review 和长期记忆。参考链接保留在架构文档末尾；其中方法论是本项目的二次工程推演，不冒充来源作者的原始产品。

## 路线图

下一步按执行文档推进：

1. 将 MCP/HTTP 工具接入微信 Chief，建立查询/恢复/派单工具层；恢复失败时明确报错，绝不静默新建。
2. 增加原生 Agent list/load 适配器和外部会话并发检测。
3. 把验证、review、审批和审计事件接成闭环，再考虑正式目录迁移与云端/GUI 通道。

默认不迁移 `~/.codex`、`~/.kimi-code`、`~/.local/share/opencode`、Devin/WorkBuddy App 数据，也不把 token、API key、二维码登录状态提交到 Git。控制面自己的状态位于 `~/.local/state/ai-agent-cockpit/control-plane.json`，只在第一次写入 Task/Execution 时创建。
