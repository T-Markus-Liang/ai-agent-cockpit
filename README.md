# Personal AI OS

Personal AI OS 是运行在 macOS 本机上的 AI 调度控制面：微信是移动入口，Cezar 是本地 cockpit，Codex / OpenCode / Kimi / WorkBuddy / Devin / Claude Code / Antigravity 是可插拔的 Agent 或 Provider。项目当前仍使用 `ai-agent-cockpit` 目录和既有 launchd 标签，以保证旧服务、微信身份和原生会话不被迁移或破坏。

它不是把所有 App 历史复制到一个新数据库，也不是给每个 GUI App 强行套一个“已支持”的标签。Personal AI OS 先建立可审计的 Task、SessionRef、Execution 和 Evidence 边界，再逐步增加 Chief 调度、审批和验证闭环。

## 当前已运行

| 入口/组件 | 地址或方式 | 当前职责 |
| --- | --- | --- |
| Cezar cockpit | <http://127.0.0.1:4321> | 本地任务、工作树和运行界面 |
| 微信控制服务 | <http://127.0.0.1:4322> | 二维码、登录状态和 bridge 启动控制 |
| 只读控制面 | <http://127.0.0.1:4324> | 本机会话元数据索引和 Agent 来源能力边界 |
| 微信 ACP bridge | launchd | 微信 → 默认 Codex，失败/超时按配置顺序 fallback |
| Provider shim | launchd | Kimi、DeepSeek、GLM、Antigravity 等本机已有反代/配置 |

已完成的第一轮重构包括：

- `control-plane/contracts.mjs`：运行时校验的 Task、SessionRef、Execution、Evidence、Approval、AgentCapability 契约。
- `control-plane/session-index.mjs`：只读发现 Codex、OpenCode、Kimi 的本地会话元数据；发现 WorkBuddy、Devin、Claude Code、Antigravity 时明确报告“入口已发现、历史索引未支持”。
- `gateway/control-plane.mjs`：回环地址 HTTP API，不写外部 Agent 历史，不读取认证文件或消息正文。
- `scripts/control-plane.mjs`：CLI 会话索引查询。
- `launchd/com.markus.ai-agent-cockpit.control-plane.plist`：控制面常驻定义；可按需加载，不改变旧服务。
- `scripts/start-local.sh`：增加控制面健康检查和启动。

## 快速开始

```bash
cd /Users/markus/ai-agent-cockpit

# 启动仍未运行的本地入口（Cezar、微信控制、只读控制面）
./scripts/start-local.sh

# 查看本机 Agent 会话元数据（只读）
npm run sessions
npm run sessions -- --json --provider=codex --limit=20

# 运行控制面契约和隐私边界测试
npm run test:control-plane
```

也可以直接访问：

```text
GET http://127.0.0.1:4324/health
GET http://127.0.0.1:4324/api/control-plane/sources
GET http://127.0.0.1:4324/api/control-plane/sessions?provider=opencode&limit=50
```

控制面默认只监听 `127.0.0.1`。索引快照会声明 `readOnly=true`、`secretsRead=false`、`messageBodiesRead=false`；任何 Agent 的恢复能力只记录原生命令提示和验证限制，不会因为“发现了可执行文件”就声称旧会话可以安全恢复。

## 架构原则

```text
微信 / 手机网页
        ↓
Chief（当前默认 Codex；未来可替换）
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

1. Session 由原生 Agent 管理；Task 和 Execution 由控制面管理。标题不能作为会话身份，恢复必须绑定来源、profile、原生 ID 和工作目录。
2. Worker 报告完成后必须经过验证和 review，不能直接把任务标成最终完成。
3. fallback 只在尚未产生可确认副作用的启动失败、超时或协议错误边界内执行；已有副作用的执行不会被静默重试。
4. 工作目录不是沙箱。控制面不会通过 bypass、自动批准或复制凭据来“修复”接入失败。
5. 本机 Devin 与 Devin Cloud 是两个不同适配器；本机 ACP 握手成功不代表云端、认证、计费或旧会话恢复已经打通。

## Agent 接入现状

| Agent | 会话元数据 | 原生恢复提示 | 目前限制 |
| --- | --- | --- | --- |
| Codex | 已接入本机 SQLite 只读索引 | Codex app-server / native thread | 未在索引阶段执行恢复和工具调用 |
| OpenCode | 已接入本机 SQLite 只读索引 | OpenCode native session | 不读取 `auth.json`，未执行恢复 |
| Kimi CLI | 已接入 `session_index.jsonl` + `state.json` | `kimi --session <id>` | 不读取 credentials 和消息正文 |
| WorkBuddy | 已发现 App/`codebuddy --acp` | `codebuddy --resume` | 没有稳定的只读旧会话索引接口 |
| Devin | 已发现 App/`devin acp` | `devin --resume` / ACP | 旧会话 list/load、真实 prompt 和认证仍待验证 |
| Claude Code | 已发现本地入口 | 原生 session 机制 | 本版本不读取 `~/.claude` 历史 |
| Antigravity | 已发现 App/本机反代 | GUI-only / proxy | 没有稳定的本地旧会话索引 |

## 文档

- [架构设计 v1.2](personal_ai_os_wechat_mac_agent_architecture_v1.html)：产品边界、Task/Session/Execution 模型、pstack / SpaceXAI 方法论和路线图。
- [执行文档](EXECUTION.md)：每个阶段的实际状态、验证命令、证据边界、回退方案和未完成项。
- [微信配置说明](config/README.md) 与 [Gateway 说明](gateway/README.md)：兼容期入口和本机凭据边界。

设计吸收了 Lauren Tan / SpaceXAI 的 pstack 思路：skill-first routing、Chief + specialized workers、并行候选与顺序降级、verification-first、独立 review 和长期记忆。参考链接保留在架构文档末尾；其中方法论是本项目的二次工程推演，不冒充来源作者的原始产品。

## 路线图

下一步按执行文档推进：

1. 用同一契约接入只读 Session 查询 API，并增加分页、过滤和来源证据。
2. 建立 Chief 的查询/恢复/派单工具层；恢复失败时明确报错，绝不静默新建。
3. 增加 Task/Execution 的持久化、幂等键、会话锁、取消和重启恢复。
4. 把验证、review、审批和审计事件接成闭环，再考虑正式目录迁移与云端/GUI 通道。

默认不迁移 `~/.codex`、`~/.kimi-code`、`~/.local/share/opencode`、Devin/WorkBuddy App 数据，也不把 token、API key、二维码登录状态提交到 Git。
