# I01 · P0 私有数据/旧链接清单 + control-plane 开机加载证据

日期：2026-10-08
状态：只读盘点完成；不构成迁移执行，不构成"重启验证"
范围：Personal AI OS 0.3.0 · I01 / P0 的两个子项

本轮为**严格只读**盘点：仅枚举路径、权限、大小与数据类别，**未读取任何文件内容**（不 cat / 不 head / 不打开 token、对话正文、向量、密钥）。未停写、未重启、未 `launchctl` 变更、未 commit。运行服务保持原样。当前进度见[阶段台账](../plans/0.3.0-status.md)，命名迁移与批次 2 边界见[命名决策](./rename-personal-ai-os.md)。

---

## 一、私有数据 / 旧链接清单

记录口径：`mode` 取 `stat -f %Mp%Lp`；`大小` 取 `du -sh`（目录）或文件字节数（`stat -f %z`，表中标注）；`类别` 为数据性质；`迁移注意` 针对批次 2 / P6 停机迁移。

### 1. 控制面状态

| 路径 | 权限 mode | 大小 | 类别 | 迁移注意 |
| --- | --- | --- | --- | --- |
| `~/.local/state/ai-agent-cockpit/` | `0700` | 128K | 状态（目录） | 旧命名空间；P6 需先停写、一致备份；与下面 personal-ai-os 下 goals/mem0 的归属须逐一核对，不整目录合并 |
| `~/.local/state/ai-agent-cockpit/control-plane.json` | `0600` | 127472 B | 状态（控制面协调记录） | 必须先停写备份；含协调/运行记录，属状态而非明文凭据；迁移后逐文件校验摘要与权限 |

### 2. Personal AI OS 状态（`~/.local/state/personal-ai-os/`）

| 路径 | 权限 mode | 大小 | 类别 | 迁移注意 |
| --- | --- | --- | --- | --- |
| `personal-ai-os/`（根） | `0755` | 2.5M | 混合（目录） | **权限异常**：预期 `0700`，实为 `0755`（见"异常"）。迁移时同时收紧 |
| `personal-ai-os/goals/` | `0700` | 172K | 混合（目录） | goals 引擎状态区；先停写备份 |
| `…/goals/goals.json` | `0600` | 36866 B | 状态 / 目标正文 | 含目标正文与状态；含凭据不外传（正文） |
| `…/goals/api-token` | `0600` | 43 B | **凭据** | 含凭据，不外传；不读取、不落日志；`config/wechat-acp.json` 引用（见 §4） |
| `…/goals/wechat-owner` | `0600` | 71 B | 状态（owner 标识） | 唯一 owner 归属需在切换前核对，避免新旧标签同时拥有同一任务 |
| `…/goals/task-proof/` | `0700` | 68K | 状态（目录） | 任务凭证目录 |
| `…/goals/task-proof/control-plane.json` | `0600` | 67405 B | 状态（任务凭证） | 与 §1 的同名文件区分；先备份再判归属 |
| `…/goals/workspaces/` | `0700` | 56K | 工作区（目录） | 含 5 个 `goal_<uuid>` 子目录；可重建性不一，逐目录确认 |
| `personal-ai-os/mem0/` | `0700` | 2.3M | 混合（目录） | 记忆子系统根；含 WAL，停机后备份 |
| `…/mem0/api-token` | `0600` | 43 B | **凭据** | 含凭据，不外传；`config/wechat-acp.json` 引用（见 §4） |
| `…/mem0/ingest.sqlite` | `0600` | 28672 B | 状态 / 索引（SQLite 主库） | 含 WAL（见下 3 个）；须用 SQLite backup API 一致备份，勿直接拷冷文件 |
| `…/mem0/ingest.sqlite-shm` | `0600` | 32768 B | WAL 共享内存 | 非独立数据；纳入 WAL 备份流程 |
| `…/mem0/ingest.sqlite-wal` | `0600` | 1203072 B | **WAL（未检查点，含正文）** | 含 WAL 需 backup API；停写并 checkpoint/备份后再迁移，否则丢数据 |
| `…/mem0/history.sqlite` | `0644` | 40960 B | 对话 / 历史正文 | **权限异常**：预期 `0600`，实为 `0644`（见"异常"）。含正文，含凭据/隐私不外传 |
| `…/mem0/migration/` | `0700` | 4K | 备份（目录） | 迁移用目录 |
| `…/mem0/migration/wechat-bridge.before-mem0.plist` | `0644` | 1474 B | 旧配置备份 | 历史回退件；含绝对路径，确认无需回退后可归档 |
| `…/mem0/vectors/` | `0755` | 212K | 向量索引（目录） | **权限异常**：预期 `0700`，实为 `0755`（见"异常"） |
| `…/mem0/vectors/collection/` | `0755` | — | 向量数据 | 可重建（如源正文在）但代价高；迁移时收紧权限 |
| `…/mem0/vectors/meta.json` | `0644` | 1153 B | 向量元数据 | 权限异常（同目录） |
| `…/mem0/vectors/.lock` | `0644` | 13 B | 锁文件 | 可重建（运行时生成） |

### 3. 微信实例（`~/.wechat-acp/instances/cezar-codex/`）

| 路径 | 权限 mode | 大小 | 类别 | 迁移注意 |
| --- | --- | --- | --- | --- |
| `cezar-codex/`（根） | `0700` | 156K | 混合（目录） | 旧实例名；批次 2 拟改名，须保证新旧实例不同时持有同一任务 |
| `…/state.json` | `0600` | 790 B | 状态 | 先停写备份 |
| `…/token.json` | `0600` | 254 B | **凭据** | 含凭据，不外传 |
| `…/conversation-memory.json` | `0600` | 18107 B | 对话正文 | 含凭据/隐私不外传；迁移前确认是否已并入 mem0 |
| `…/conversation-memory.json.before-mem0` | `0600` | 4070 B | 对话正文（旧） | 历史回退件；确认无需回退后归档 |
| `…/sync-buf.json` | `0600` | 126 B | **队列 / 缓冲** | 未同步缓冲；迁移即"停写备份"，否则丢失待处理项 |
| `…/telemetry-id` | `0644` | 36 B | 遥测 ID | 轻微异常：预期收窄至 `0600`；可重建 |
| `…/conversation-archive/` | `0700` | 44K | 对话正文（目录） | 归档正文；含凭据/隐私不外传 |
| `…/conversation-archive/wechat-*.jsonl` | `0600` | 43543 B | 对话正文 | 同上；含隐私不外传 |
| `…/incoming-receipts/` | `0700` | 8K | **队列（目录）** | 入站回执队列（2 文件，`0600`）；迁移需停写 |
| `…/reply-outbox/` | `0700` | 28K | **队列（目录）** | 出站回执队列（7 文件，`0600`）；迁移需停写，否则丢待发消息 |
| `…/inject/` | `0700` | 36K | **队列（目录）** | 子目录 `done/ failed/ pending/ processing/`；属在途队列，停写备份 |

### 4. 仓库内私有区

| 路径 | 权限 mode | 大小 | 类别 | 迁移注意 |
| --- | --- | --- | --- | --- |
| `logs/` | `0755` | 6.3M（19 个文件） | 日志 | 最大件 `wechat-bridge-launchd.log` 5.5M；日志可能含消息正文/路径，**含凭据/隐私不外传**；大体可重建，但归档前须确认无正文 |
| `.ai/` | `0755` | 12K | 私有运行区（目录） | 存在性核对：**存在** |
| `.ai/cezar/launch-key` | `0600` | 37 B | **凭据** | 含凭据，不外传；已 gitignore（`.ai/cezar/.gitignore` 在位） |
| `.ai/cezar/runs.json` | `0644` | 2 B | 状态 | 可重建 |
| `config/wechat-acp.json` | `0644` | 4296 B | 配置 | 引用私有路径（只记路径不读取目标内容）：`tokenFile` → `~/.local/state/personal-ai-os/goals/api-token`；`tokenFile` → `~/.local/state/personal-ai-os/mem0/api-token`；`personaFile` → `/Users/markus/ai-agent-cockpit/AGENTS.md`。批次 2 共 6 处绝对路径待改 |

### 5. 其他常见位置（仅路径 / 大小）

| 路径 | 权限 mode | 大小 | 类别 | 迁移注意 |
| --- | --- | --- | --- | --- |
| `~/.cc-switch/cc-switch.db` | `0644` | 91549696 B（约 87M） | **凭据来源**（kimi shim） | 含凭据不外传；**权限异常**：`0644` 说明组/他人可读（见"异常"）；本仓迁移**不搬动**此库，仅记录依赖关系 |
| `~/.dsh/.credentials.yaml` | `0600` | 504 B | **凭据**（goal-ai / dsh 用） | 含凭据不外传；与本仓迁移无关，仅登记路径 |

---

## 二、control-plane 开机加载证据

### 2.1 九标签现场状态（`launchctl print gui/$(id -u)/<label>`）

| 标签 | state | pid | plist 路径 | RunAtLoad | KeepAlive | last exit |
| --- | --- | --- | --- | --- | --- | --- |
| `com.markus.ai-agent-cockpit.control-plane` | running | 15506 | **仓库** `…/ai-agent-cockpit/launchd/…control-plane.plist` | `true` | `true` | 无 `last exit code`；`last terminating signal = Terminated: 15`；runs=18 |
| `com.markus.ai-agent-cockpit.cezar` | running | 32742 | `~/Library/LaunchAgents/…cezar.plist` | `true` | `true` | 0；runs=6 |
| `com.markus.ai-agent-cockpit.wechat-control` | running | 73196 | `~/Library/LaunchAgents/…wechat-control.plist` | `true` | `true` | (never exited)；runs=1 |
| `com.markus.ai-agent-cockpit.wechat-bridge` | running | 15936 | `~/Library/LaunchAgents/…wechat-bridge.plist` | `true` | `true` | 0；runs=7 |
| `com.markus.ai-agent-cockpit.kimi-shim` | running | 14394 | `~/Library/LaunchAgents/…kimi-shim.plist` | `true` | `true` | (never exited)；runs=1 |
| `com.markus.ai-agent-cockpit.keepawake` | running | 51683 | `~/Library/LaunchAgents/…keepawake.plist` | `true` | `true` | (never exited)；runs=1 |
| `com.markus.personal-ai-os.memory` | running | 6573 | `~/Library/LaunchAgents/…personal-ai-os.memory.plist` | `true` | `true` | (never exited)；runs=1 |
| `com.markus.personal-ai-os.goals` | running | 15509 | `~/Library/LaunchAgents/…personal-ai-os.goals.plist` | `true` | `true` | 0；runs=7 |
| `com.markus.antigravity-proxy` | running | 35355 | `~/Library/LaunchAgents/…antigravity-proxy.plist` | `true` | `dict{SuccessfulExit=false}` | 0；runs=72 |

汇总：**9/9 标签均为 loaded + `state = running`**，且 `active count = 1`。RunAtLoad 全部为 `true`。`antigravity-proxy` 未失败（任务允许跳过，实际运行正常，如实记录）。

### 2.2 仓库 `launchd/*.plist` 键值核对（grep，非执行）

仓库 `launchd/` 共 9 个 plist，与上表一一对应。逐项核对：

- 全部 9 个 plist 均含 `<key>RunAtLoad</key><true/>` 与 `<key>KeepAlive</key><true/>`；
- 唯一例外 `com.markus.antigravity-proxy.plist` 的 `KeepAlive` 为字典 `<dict><key>SuccessfulExit</key><false/></dict>`（即"非正常退出才拉起"），`RunAtLoad` 仍为 `true`。

### 2.3 control-plane 的 plist 副本情况（重点）

- `~/Library/LaunchAgents/` **不存在** `com.markus.ai-agent-cockpit.control-plane.plist`（已明确核对：目录列表无该文件）。
- `launchctl print` 显示的 `path` 为**仓库内** plist：`/Users/markus/ai-agent-cockpit/launchd/com.markus.ai-agent-cockpit.control-plane.plist`。
- 即：**control-plane 是从仓库 plist 加载的，LaunchAgents 无副本**。其余 8 个标签均有 LaunchAgents 副本（cezar、wechat-control、wechat-bridge、kimi-shim、keepawake、personal-ai-os.memory、personal-ai-os.goals、antigravity-proxy）。这是批次 2 需处理的点：改 Label/路径时，control-plane 只需同步仓库内 plist，而其余 8 个需要**同时**同步仓库 plist 与 LaunchAgents 副本（两份）。

### 2.4 端口实测（GET，只读）

| 端口 | 归属标签 | pid | 探测 | HTTP 码 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 4321 | cezar | 32742 | `/health` | **200** | ok |
| 4322 | wechat-control | 73196 | `/health`、`/` | **404 / 404** | 端口在 listen（curl 有响应），但无 `/health`、`/` 路由 |
| 4323 | kimi-shim | 14394 | `/health`、`/` | **404 / 404** | 同上，端口在 listen |
| 4324 | control-plane | 15506 | `/health` | **200** | ok |
| 4325 | personal-ai-os.memory | 6573 | `/health` | **200** | ok |
| 4326 | personal-ai-os.goals | 15509 | `/health` | **200** | ok |
| — | wechat-bridge | 15936 | — | — | 出站网桥，非监听端口；`lsof` 无对应 LISTEN 记录 |

监听核对（`lsof -nP -iTCP -sTCP:LISTEN`）：4321→node(32742, cezar)、4322→node(73196, wechat-control)、4323→Python(14394, kimi-shim)、4324→node(15506, control-plane)、4325→Python(6573, memory)、4326→node(15509, goals)，全部绑定 `127.0.0.1`（仅环回、不对外）。

---

## 三、边界声明（必读）

**声明 1 — 本轮未读取任何文件内容。**
以上全部条目仅为元数据：路径、权限、大小、类别。**未 cat / 未 head / 未打开 token、对话正文、向量、密钥、配置值**。所有条目均不含任何私密内容，`config/wechat-acp.json` 仅记录其**引用的路径**（tokenFile/personaFile 的路径字面），未读取被引用文件。凭据类别条目均只登记"存在、路径、大小、权限"。

**声明 2 — 未做重启验证，"开机加载"只是配置与当前态，不等同于"实际重启后验证过"。**
`launchctl` 显示 9 个标签均 loaded、`RunAtLoad=true`（且当前 `state=running`、pid 存在、端口可连），这可证**"已配置为开机加载且当前在跑"**；但本轮**未重启机器**，因此**不能**断言"重启后仍会加载、加载后仍健康"。真实重启验证须在后续停机窗口另行执行并单独取证。

---

## 四、发现的异常（如实列出）

权限预期基准：目录 `0700`、敏感文件 `0600`。以下与预期不符，供批次 2 / P6 处理：

1. **`~/.local/state/personal-ai-os/` 目录为 `0755`**（预期 `0700`）——其为 `goals/` 与 `mem0/` 的父目录，他人/组可进入列目录。子目录本身多为 `0700`，但父目录过宽削弱隔离。
2. **`…/mem0/history.sqlite` 为 `0644`**（预期 `0600`）——**历史/对话正文库对组/他人可读**，属最需优先收紧项。
3. **`…/mem0/vectors/` 目录 `0755` 且 `meta.json`、`.lock` 为 `0644`**（预期 `0700`/`0600`）——向量区对组/他人可读。
4. **`…/mem0/migration/wechat-bridge.before-mem0.plist` 为 `0644`**——历史配置备份（含绝对路径），敏感度较低但仍在记忆数据区内。
5. **`~/.wechat-acp/instances/cezar-codex/telemetry-id` 为 `0644`**（含父目录 `0700` 保护，实际暴露面有限）——建议统一收至 `0600`。
6. **`~/.cc-switch/cc-switch.db` 为 `0644`**（约 87M）——标注为 kimi shim 的**凭据来源**，组/他人可读。与本仓迁移无关，但作为凭据风险点登记。
7. **`logs/` 目录 `0755`、日志文件 `0644`**——日志可能含微信消息正文/绝对路径，属对组/他人可读；迁移归档前应确认内容并考虑收窄。

状态类异常（非权限）：

8. **control-plane 无 `last exit code`，仅有 `last terminating signal = Terminated: 15` 且 `runs=18`**——表明该进程历史上被 SIGTERM 终止过（重启/重启循环痕迹）而非正常退出；当前 `state=running`。属观察项，未做进一步动作。
9. **4322（wechat-control）、4323（kimi-shim）对 `/health` 与 `/` 均返回 404**——端口在监听、进程在跑，但探针无匹配路由。疑似这两个服务不使用该探针路径（非故障）；如需健康探针，须由各自实现确认正确路径。
