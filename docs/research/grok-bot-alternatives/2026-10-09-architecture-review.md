# Grok Bot 开源替代：源码架构研究

日期：2026-10-09。用途：Personal AI OS 下一大版本参考，**不是更换基座、引入依赖或部署批准**。下一版暂称 0.4.0，正式范围仍须收敛；0.3.0 原验收不变。

## 1. 结论

选择 **Codync、OpenMausBot、Rakazo** 深入阅读。建议采用“Codync 的移动/会话与 routine 体验 + OpenMausBot 的驱动/能力/记忆可视化 + Rakazo 的持久执行与动作账本”这组设计参考，保留我们已有 Task/Execution、RuntimePort、Mem0、Inbox/Outbox 和权限/验收门槛。

本轮没有找到一个可以未经适配就代替我们全部要求的产品。不推荐把三个项目拼成三套常驻调度器，也不推荐直接整仓 fork 后迁生产。这里是针对核心路径的源码研究，不是第三方全仓安全审计。

先更正产品身份：本研究针对“持续工作 AI 队友”形态的 Grok Bot，不是 X 评论区的 `@grok`。社区替代的架构与我们的目标确有重合。

## 2. 固定来源与研究边界

| 项目 | 固定 commit | 许可与版本 | 本轮关注 |
| --- | --- | --- | --- |
| [Codync](https://github.com/leepokai/Codync/tree/9de648192320eabea121ba8a24e44937cdaa24f7) | `9de648192320eabea121ba8a24e44937cdaa24f7` | Apache-2.0，host 2.11.2 | ACP、bot actor、会话/线程、routine、SQLite、事件追赶、远程配对 |
| [OpenMausBot](https://github.com/milind-soni/OpenMausBot/tree/3e9e42b3a05e0b7c4edbaedba2e667b851296e27) | `3e9e42b3a05e0b7c4edbaedba2e667b851296e27` | Apache-2.0，0.1.102；NOTICE 保留来源说明 | Native/ACP driver、实例注册、规范化事件、权限、记忆编辑、routine、桌面 |
| [Rakazo](https://github.com/elie222/rakazo/tree/8d3fedb63725ac1f896a8009484bf75fcd1ba7ac) | `8d3fedb63725ac1f896a8009484bf75fcd1ba7ac` | Apache-2.0，package 0.1.0；README beta | API/Worker 分离、Pi runtime、租约、effect、后台 job、记忆 revision |

隔离浅克隆位于 `/tmp/personal-ai-os-next-research.bSWUYW/`。临时目录不是部署依赖；可按固定 commit 重新取得源码。52 个选定源码/许可文件的 SHA256 和字节数在[source manifest](source-manifest-2026-10-09.json)。记录 hash 不意味着每个大文件逐行全审；按调用链选读关键区段。

未安装依赖、未执行生命周期脚本、未运行上游 CLI/模型、未启动 Docker/数据库或手机 App，未读取用户私有数据。克隆内没有源码修改。验证范围见§7。

## 3. Codync：一个本机 host，把 Agent 变成可联系的队友

### 3.1 怎么构建

`host/Cargo.toml` 定义 Rust 2024 / Rust >=1.88 的单 host：Tokio 异步、Axum HTTP/WebSocket、rusqlite bundled、ACP 子进程；iPhone 用 SwiftUI，桌面是 Electron，另有 TUI。cloud/relay 是独立边缘服务，不负责在 Mac 睡眠时替它执行本机 CLI。

```text
iPhone / Electron / TUI
  → 认证 host API / 授权远程通道
  → Hub → 每 bot Actor / 串行队列 → ACP CLI
  → SQLite entries + rev → catch-up / live stream → 客户端
```

主要证据：[Cargo](https://github.com/leepokai/Codync/blob/9de648192320eabea121ba8a24e44937cdaa24f7/host/Cargo.toml)、[ACP transport](https://github.com/leepokai/Codync/blob/9de648192320eabea121ba8a24e44937cdaa24f7/host/src/agent/acp.rs)、[queue](https://github.com/leepokai/Codync/blob/9de648192320eabea121ba8a24e44937cdaa24f7/host/src/agent/bot/queue.rs#L13)。

### 3.2 会话与协作怎么实现

- bot 是持久配置和可联系对象，Actor 管当前 CLI、队列与活动 turn。普通私聊、线程和 routine 并非同一个状态对象。
- `session.rs` 保存 native session ID；线程可使用 `session/fork`，否则新建并带入有限前序文本。`session/load` 恢复后丢弃 provider 回放事件，避免历史再次显示成新消息。
- 常规聊天的 `session/load` 不支持/失败时会提示并新建 session（213–258 行）；**这不符合我们“用户旧会话不可静默替代”的合同，不能原样采用**。
- routine 恢复另有保护：`turn.rs:76` 在恢复时若不得不新建 session，终结为 Interrupted 而不重新发送中断任务。应借鉴的是这条严格路径，不是普通聊天的宽松路径。
- bot 间 request 的 wait graph 在锁内检查循环，限制 hop 和 sender quota；不是任意相互喊“继续”形成无限协作。

证据：[session](https://github.com/leepokai/Codync/blob/9de648192320eabea121ba8a24e44937cdaa24f7/host/src/agent/bot/session.rs#L205)、[恢复保护](https://github.com/leepokai/Codync/blob/9de648192320eabea121ba8a24e44937cdaa24f7/host/src/agent/bot/turn.rs#L76)、[wait graph](https://github.com/leepokai/Codync/blob/9de648192320eabea121ba8a24e44937cdaa24f7/host/src/chat/team/requests.rs#L11)。

### 3.3 后台与通知怎么实现

- routine 定义/run 存在 SQLite KV；`restore()` 将 Running 转 Recovering，Starting 转 Pending。开始发 prompt 前用 `mark_started` 持久化 Running。
- 结果先保存在 run 的 `result/report_pending`，`publish()` 独立重试；稳定 `routine-result-<runId>` entry ID 防止结果重复入聊天。它不是远程推送 exactly-once 或已读保证。
- 日程错过时合并，不把睡眠期间每个 interval 全补跑；routine 是独立线程/session。该行为在文档和实现中均有明确边界。
- UI 事件是 `rev` 增量：先订阅 live，再查询 catch-up；重复可由 id/rev upsert，滞后通知 `resync`。比全量刷新或客户端自产生运行状态更可控。

证据：[restore](https://github.com/leepokai/Codync/blob/9de648192320eabea121ba8a24e44937cdaa24f7/host/src/routines/mod.rs#L138)、[结果独立发布](https://github.com/leepokai/Codync/blob/9de648192320eabea121ba8a24e44937cdaa24f7/host/src/routines/runner.rs#L98)、[events](https://github.com/leepokai/Codync/blob/9de648192320eabea121ba8a24e44937cdaa24f7/host/src/api/events.rs#L50)、[routine 语义](https://github.com/leepokai/Codync/blob/9de648192320eabea121ba8a24e44937cdaa24f7/docs/features/routines.md)。

### 3.4 记忆与远程访问的取舍

`chat/context.rs` 以 session + compaction epoch 冻结 prompt snapshot，profile/memory 变更增量通知，减少每轮改写缓存前缀。`memory/keeper.rs` 将交换先排入持久队列，空闲或达到批量阈值再提炼。应参考“稳定上下文+异步提炼”，不再给我们新增第二套事实库。

`remote/crypto.rs` 明确实现签名临时密钥、X25519/HKDF/ChaCha20Poly1305；本轮未做密码学审计。Routine webhook 文档明确云端能看到内容并持有验签 key，**不能把所有通道统一宣传成端到端加密**。NOTICE 还限制官方托管 relay 为个人使用，商业/多租户需自建；代码许可与服务使用权分开。

`updates.rs:135` 的 Auto 模式可选择 allow_once/allow_always；registry 还可首次使用时获取 npx/uvx/binary。这些便利不能绕过我们的精确 Approval、pin/integrity 和真实 capability 验证。

证据：[snapshot](https://github.com/leepokai/Codync/blob/9de648192320eabea121ba8a24e44937cdaa24f7/host/src/chat/context.rs#L1)、[权限分支](https://github.com/leepokai/Codync/blob/9de648192320eabea121ba8a24e44937cdaa24f7/host/src/agent/bot/updates.rs#L132)、[crypto](https://github.com/leepokai/Codync/blob/9de648192320eabea121ba8a24e44937cdaa24f7/host/src/remote/crypto.rs)、[NOTICE](https://github.com/leepokai/Codync/blob/9de648192320eabea121ba8a24e44937cdaa24f7/NOTICE)。

## 4. OpenMausBot：统一驱动，把不同原生协议变成一种产品体验

### 4.1 怎么构建与调用

TypeScript/React/Vite UI + Electron 外壳；Node host 持有所有 provider transport，客户端只发 typed HTTP commands、折叠 SSE events。Claude driver 使用 stream-json、stdin prompt、native result，带 native resumeCursor；Codex 与 ACP 各有自己的 driver，而不是假设所有 CLI 参数相同。

```text
React / Electron / companion
  → HTTP command → Node harness / ProviderRegistry
  → Claude stream-json / Codex driver / ACP driver
  → normalized RuntimeEvent → EventBus → SSE + NDJSON inspector
```

`contracts.ts` 区分 instanceId、driver、model、variant、effort、approvalMode、toolScope、native resumeCursor、sessionReset、recoveryText。模型选择是数据，不是“哪个服务就是哪个模型”。`TurnNotStartedError` 还要求证明未 prompt/未客户端动作且自有进程已停止，才允许安全恢复。

`ProviderRegistry` 为未知/坏配置生成 unavailable shadow snapshot，单实例失败不拖垮其它实例；并发探测后保留配置顺序。它解决的不是“出现一枚 Agent 图标就是已连接”。

证据：[contracts](https://github.com/milind-soni/OpenMausBot/blob/3e9e42b3a05e0b7c4edbaedba2e667b851296e27/server/contracts.ts#L107)、[registry](https://github.com/milind-soni/OpenMausBot/blob/3e9e42b3a05e0b7c4edbaedba2e667b851296e27/server/harness/registry.ts#L59)、[Claude driver](https://github.com/milind-soni/OpenMausBot/blob/3e9e42b3a05e0b7c4edbaedba2e667b851296e27/server/drivers/claude.ts#L1)、[ACP core](https://github.com/milind-soni/OpenMausBot/blob/3e9e42b3a05e0b7c4edbaedba2e667b851296e27/server/drivers/acp/core.ts)。

### 4.2 事件、权限和记忆

- EventBus 关联 providerInstanceId，拒跨 driver 事件，50ms 合并同流文本 delta；脱敏后写按 thread 分组的 NDJSON。磁盘写失败仍继续 live stream，但插入“历史不完整”告警，**不宜直接拿其 live event 当我们完成证据**。
- `permission-proxy.ts` 通过 Unix socket 连接 broker；broker 断开会对等待请求 deny。问题卡和权限卡分开，避免把 AskUserQuestion 当作简单工具 allow。
- 记忆是 MEMORY.md/topic/log 三类路径，支持 expected hash 防编辑覆盖，路径 containment/symlink 检查、0600/原子写和 journal；UI 显示实际注入预算、修改与撤销。
- MEMORY 开关并不能阻止有文件工具的 bot 自行读写记忆文件，文档明确披露。这不是我们的强隐私 epoch/forget 屏障。
- routines/runs 以 JSON 原子保存，active 记录不因历史上限被淘汰；单次 `turn.completed` 可把普通 routine 标为 completed，room-goal 则由 goal lifecycle 决定。不能把这种 completed 直接映射为我们的 Task 完成。

证据：[EventBus](https://github.com/milind-soni/OpenMausBot/blob/3e9e42b3a05e0b7c4edbaedba2e667b851296e27/server/harness/bus.ts#L95)、[permission proxy](https://github.com/milind-soni/OpenMausBot/blob/3e9e42b3a05e0b7c4edbaedba2e667b851296e27/server/permission-proxy.ts#L45)、[memory store](https://github.com/milind-soni/OpenMausBot/blob/3e9e42b3a05e0b7c4edbaedba2e667b851296e27/server/memory-store.ts#L80)、[memory 说明](https://github.com/milind-soni/OpenMausBot/blob/3e9e42b3a05e0b7c4edbaedba2e667b851296e27/docs/memory.md)、[routine completion](https://github.com/milind-soni/OpenMausBot/blob/3e9e42b3a05e0b7c4edbaedba2e667b851296e27/server/routines.ts#L1650)。

### 4.3 不应照搬的体量

该固定版本 `server/index.ts` 为 25,726 行，routines 1,975 行，Claude/Codex/ACP core 各约两千行。我们要借接口与用例，不复制一个新的大型服务器。其原子 JSON 文件也不等于多 store 事务或跨进程 fence。

`package.json` 含 prepare 安装 git hooks、打包准备 browser/cloudflared/CUA 等动作；本轮未执行。NOTICE 清楚列出 T3 Code、OpenCode、models.dev、noVNC 等来源；采纳代码需带上对应说明，不能只保留根 Apache 标签。

## 5. Rakazo：数据库驱动的 Run/Attempt/Effect 与后台 worker

### 5.1 怎么构建

pnpm workspace + Turbo。应用层包括 Hono/oRPC API、独立 Worker、React Web、Electron、Expo mobile；PostgreSQL/Prisma 是产品状态源，Graphile Worker 是后台 job 执行载体。Pi 提供模型/工具 Agent runtime，sandbox/provider 和 memory 使用 adapter 接口。

```text
Web / Desktop / Mobile / messaging
  → API → PostgreSQL Task/Run/Attempt/ExternalEffect
  → Graphile job → Worker executor → Pi runtime → sandbox / connectors
  → 持久 thread events / 投递状态 → 客户端
```

不是“Pi 自己包办所有持久性”：租约、动作去重、job 修复与状态结算主要在产品数据库/adapter 层。`apps/worker/src/index.ts` 装配同一个 executor、job host、reconciler，并共享 PostgreSQL pool；多进程与连接容量是部署成本。

证据：[worker 装配](https://github.com/elie222/rakazo/blob/8d3fedb63725ac1f896a8009484bf75fcd1ba7ac/apps/worker/src/index.ts)、[Pi adapter](https://github.com/elie222/rakazo/blob/8d3fedb63725ac1f896a8009484bf75fcd1ba7ac/packages/adapters/src/pi-runtime.ts#L1)、[Graphile](https://github.com/elie222/rakazo/blob/8d3fedb63725ac1f896a8009484bf75fcd1ba7ac/packages/adapters/src/wakeup.ts#L18)。

### 5.2 可靠性如何落在代码上

- `Run` 带 task/thread/bot/user/space、clientNonce、checkpoint、leaseOwner/Fence/ExpiresAt；`Attempt` 带同 run 的 fence，`ExternalEffect` 有唯一 idempotencyKey。`lease` 是 worker 存活/占用约束，不是用户授权 Grant。
- `continueRun()` 通过条件 updateMany 争抢租约，递增 fence；heartbeat 同时续 Run 与 Computer lease，失败会 abort。之后结算继续绑定 owner/fence。
- `approval-effect.ts` 区分 completed → 返回结果、executing → uncertain、intended → paused、approved → execute；绑定 connector/resource/tool/revision，避免审批后资源变化却继续执行旧批准。
- `job-reconciler.ts` 用 PG session advisory lock 选单 reconciler，按 cursor/batch 扫描卡住任务、到期 routine 与漏投递。Graphile jobKey 是唤醒去重，不是外部动作 exactly-once 保证。
- `run-state.ts` 将 routine/webhook 与普通聊天分开；`failed→queued` 在状态表中允许，但我们的产品不能因此自动重放未知副作用。

证据：[schema](https://github.com/elie222/rakazo/blob/8d3fedb63725ac1f896a8009484bf75fcd1ba7ac/packages/db/prisma/schema.prisma#L606)、[claim/heartbeat](https://github.com/elie222/rakazo/blob/8d3fedb63725ac1f896a8009484bf75fcd1ba7ac/packages/adapters/src/executor.ts#L3232)、[effect gate](https://github.com/elie222/rakazo/blob/8d3fedb63725ac1f896a8009484bf75fcd1ba7ac/packages/adapters/src/approval-effect.ts#L354)、[reconciler](https://github.com/elie222/rakazo/blob/8d3fedb63725ac1f896a8009484bf75fcd1ba7ac/packages/adapters/src/job-reconciler.ts#L25)。

### 5.3 不能直接当作我们的完整合同

Pi runtime 的 MAX_TOOL_CALLS_PER_TURN 默认 unlimited，且预算 Map 注释明确跨 worker/重启可从零开始。我们的授权期限和 Goal 预算必须跨 attempt 持久守恒，不能把这种可选进程内 fuse 当硬预算。

executor 在模型结束后调用 finalizeRun(completed)；这是一次 Agent run 的结束，不是我们同 artifact 的固定测试和独立 Reviewer 完成证明。下一版映射为“执行返回，待验收”，而不是跳过 VERIFYING/REVIEWING。

`MarkdownMemoryStore` 实际把 content/revision 保存在 Prisma DB，支持 expectedRevision 与事务历史；搜索是 path/content substring，不是语义向量检索。`pi-session.ts` 默认 30 天/每 bot 100 文件保留上限，也不能原样用来清理用户原生历史。

证据：[进程内 fuse](https://github.com/elie222/rakazo/blob/8d3fedb63725ac1f896a8009484bf75fcd1ba7ac/packages/adapters/src/pi-runtime.ts#L74)、[run 结算](https://github.com/elie222/rakazo/blob/8d3fedb63725ac1f896a8009484bf75fcd1ba7ac/packages/adapters/src/executor.ts#L7008)、[memory revision](https://github.com/elie222/rakazo/blob/8d3fedb63725ac1f896a8009484bf75fcd1ba7ac/packages/memory/src/index.ts#L50)、[session retention](https://github.com/elie222/rakazo/blob/8d3fedb63725ac1f896a8009484bf75fcd1ba7ac/packages/adapters/src/pi-session.ts#L9)。

## 6. 采纳矩阵：复用机制，而不是再建三套系统

| 参考机制 | 我们承接位置 | 采用方式 | 不照搬 |
| --- | --- | --- | --- |
| Codync bot/thread/actor | Agent/Profile、SessionRef、现有 execution ownership | 概念/UI DTO 映射；每执行明确 lane | 自建第二 daemon/调度器；旧会话失败自动替换 |
| OpenMaus driver/instance/model | native-acp executor、provider resolver、capability | 参考合同与必要的 provider-specific 薄适配 | 复制大型 server/index；未经准入自动下载所有 CLI |
| Codync routine/run/publication | GoalRuntime、统一 route、Inbox/Outbox | 在同一 runtime owner 下增加触发与读模型 | 每轮定时发“继续”、丢失后重新 prompt |
| Rakazo lease/fence/effect | owner store、Execution/attempt、Approval/Evidence | 补跨层守卫与动作记录；DB 技术先保持现状 | 新增 Run DB 与现有 Execution 双写；lease 代替 Grant |
| Codync rev/catch-up、Maus inspector | 现有日志、控制面查询与前端 | 规范化事件/增量投影，native details 分权限 | 把文本 delta 当完成证据；另建可写 task 状态源 |
| 记忆 revision/预算可视化 | 现有 Mem0 与质量/隐私层 | 编辑、来源、冲突、注入预算视图 | Markdown/新向量库成为第二事实源 |
| 多端 app / relay | ChannelPort、现有中文 Web | 先移动 Web/PWA；独立设备配对后再研究 native/relay | 默认复制 Swift/Expo/Electron 三套产品或托管账号系统 |

### 客户端实现也应作为参考

- Codync 的 Swift `HostClient` 对 `HostTransport` 编码/解码，`events(since:)` 接同一追赶协议；客户端不自行启动 Agent。参考[HostClient.swift](https://github.com/leepokai/Codync/blob/9de648192320eabea121ba8a24e44937cdaa24f7/apps/ios/Kit/Sources/CodyncKit/Client/HostClient.swift#L43)。
- Maus React store 使用 typed command + 单 SSE stream + 纯 reducer；`live-events.ts` 有 visible ping、40s stale 检查、重连游标和 snapshot-required，处理“连接看似正常但消息已停”的半开连接。参考[store](https://github.com/milind-soni/OpenMausBot/blob/3e9e42b3a05e0b7c4edbaedba2e667b851296e27/src/state/store.tsx#L1)与[liveness](https://github.com/milind-soni/OpenMausBot/blob/3e9e42b3a05e0b7c4edbaedba2e667b851296e27/src/lib/live-events.ts#L1)。其 loopback-owner 信任策略不能替换我们严格的 principal 认证。
- Rakazo Web `thread-events.ts` 合并已持久 send receipt、live event、snapshot/history；界面可短期显示 queued，但下个权威事件覆盖，不自签 completed。参考[receipt projection](https://github.com/elie222/rakazo/blob/8d3fedb63725ac1f896a8009484bf75fcd1ba7ac/apps/web/src/lib/thread-events.ts#L80)。

开源许可和产品接口复用是两件事：计划中任何复制/import 都需固定版本、来源/NOTICE、依赖/漏洞/脚本审查；本轮未导入上游代码。

## 7. 本轮验证与未验证

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| 三个 clone/sourceRef | 固定 commit；52 选定文件 hash；克隆源码无改动 | 不是全仓审计 |
| Maus `node --test electron/routine-wake.node-test.mjs` | 3/3，exit 0 | fake blocker + 临时 settings；没有改变本机电源设置 |
| Rakazo Node strip-types 纯函数检查 | 11/11，exit 0 | transition、routine 类型、fence 算术、effect gate、route revision、FIFO approval；没有 executor/DB |
| Codync Rust/native/手机构建 | 未做 | 不报告编译或端到端通过 |
| 三者真实模型、旧会话、微信、relay、24h | 未做 | README 能力不能升格为现场可用 |

Rakazo 检查输入均为 TESTONLY：running→completed、completed不能重开、failed→queued、routine不接聊天 steering、nextFence(9)=10、completed effect 返回旧结果、executing/unknown不再 execute、intended暂停、revision不同拒、FIFO不匹配不消费且未排空报错。正式参考采用前应移植为独立 fixtures，不把这 11 个断言当产品测试矩阵。

**合盖边界再次确认**：Codync routine 文档/runner 与 Maus routine-wake 均明确真正 suspend/合盖可停止本机执行，阻止 idle sleep 不是唤醒或 24h 保证。Maus 默认插电才保持；这是上游策略，不替用户修改本机电源策略。

按最新云端规则检查过 Jules sources：三个上游 repo 未连接，现有 run wrapper 默认 AUTO_CREATE_PR。本轮未创建云端 session/PR、未扩连接权限，以本机只读架构核对与局部验收完成研究；没有使用 DeepSeek worker。Jev 文档主题分类调用收到 HTTP 451 地域拒绝，没有分类结果、没有改 provider 绕过。

## 8. 下一动作

执行同事继续完成 0.3.0 S01–S06 和完整发布验收；本研究不是新阻塞，也不替代 S01 独立复核。下一大版本按[0.4.0 参考计划](../../plans/0.4.0-reference-plan.md)选择最小切片，先做合同映射与隔离样机，不直接迁生产或搬用户旧会话。
