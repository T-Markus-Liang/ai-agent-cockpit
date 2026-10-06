# Personal AI OS 执行文档

状态：重构进行中。本文与 [设计文档 v1.2](personal_ai_os_wechat_mac_agent_architecture_v1.html) 配套；已完成兼容期部署、微信常驻、ACP fallback、首批控制面可视化、统一契约、只读会话索引，以及第一版 Task/Execution 持久化、幂等、会话锁和重启恢复保护。2026-10-06 已部署 Mem0 OSS 共享记忆，实际微信启动参数已纠正为 Kimi，详见 6.2；原生旧会话恢复与完整 Chief 调度仍未完成。

## 1. 当前授权与范围

用户已授权开始执行重构。本文是执行状态和验收记录，不把规划项误报为已完成。

项目继续保留 `/Users/markus/ai-agent-cockpit` 路径以避免破坏 launchd 和原生历史；产品名称升级为 Personal AI OS。vendor Cezar、wechat-acp、原生 Agent 历史和凭据不迁移、不复制、不覆盖。重构通过兼容适配层逐步接入，默认 Chief 与微信身份保持不变。

任何服务切换、目录迁移、历史写入、外部消息、部署或破坏性动作仍需单独确认。失败时报告并停下，不自行放宽权限。

## 0. 当前重构状态

| 能力 | 当前状态 | 证据/限制 |
| --- | --- | --- |
| 微信入口 | 已运行 | launchd 常驻；微信 ACP 主 Kimi，已核对配置和实际启动参数；仍保留 prompt 超时与 fallback。连接器不直接承担外部派单。 |
| 微信共享记忆 | 已部署并验证 | Mem0 OSS 2.2.1 / 4325，本地 embedding + Qdrant/SQLite；统一上下文/人格注入、完整正文归档、持久 outbox 与真实停启恢复测试已通过；提炼调用现有 Kimi API。 |
| Cezar cockpit | 已运行 | `127.0.0.1:4321`；负责本身的 run/worktree；不是全机 App 历史控制面。 |
| Agent fallback | 已实现第一版 | 主 ACP 启动失败/超时可切换 DeepSeek、Kimi、WorkBuddy、Devin/OpenCode 候选；provider 认证和历史恢复仍分别归各 Agent。 |
| Dashboard / Settings | 已实现第五版 | Dashboard 首屏增加控制面 Task/Execution 和待审批动作卡片；Workflows 页面可视化 Personal AI OS Chief/Router/Worker/Reviewer/Approval 闭环；系统连接和 Settings → Local agents 读取 4324 Feature Map。 |
| pstack 方法论 | 已纳入设计并有基础回归评估 | Skill-first、Chief/Worker/Reviewer、arena/interrogate/tdd、verification-first、顺序降级；`npm run eval:control-plane` 已覆盖控制面协议边界，独立模型/Skill 行为 Eval 仍待完成。 |
| Task/Session/Execution 控制面 | 已完成第二片 | `contracts.mjs`、`store.mjs` 和 `gateway/control-plane.mjs` 已提供 Task/Execution 持久化、幂等写入、状态转移、Evidence、Approval、Session lock 和重启阻断；Cezar 真实派单已接入但必须经过精确审批。 |

## 2. 已观察的基线，不等于闭环完成

| 项目 | 证据边界 |
| --- | --- |
| 微信入口 | 早期基线为 Codex。6.2 部署核对发现已安装启动定义仍覆盖 Kimi 配置；现已修正为 `--agent kimi-primary` 并重启、实测健康。 |
| Cezar | 已检查实现包含任务派发、run 继续、worktree 和 runner seam；已检查的 runner 注册表没有 Devin。 |
| Devin 本机 | 已通过显式 ACP probe 完成 initialize/session/list；声明 loadSession，但未验证真实 prompt、模型鉴权、session/load、历史读取、工具调用或云端调度。 |
| Devin preset | config/wechat-acp.json 中已有 devin 入口 preset；没有通过本次更新启用它。它不是 Chief 调用 Worker 的工具。 |
| 能力页面 | Dashboard / Settings 系统连接已改为共享动态状态；微信主 Agent 标记来自配置，Mem0 来自真实 `/health`。CLI 存在仍不能证明旧会话恢复或外部派单成功。 |
| 跨 Agent 管理 | 已有控制面 Session 元数据索引、原生 ACP list/load probe、MCP 工具和 Approval-bound dispatcher；完整的 Chief 真实 prompt/多 Worker 调度闭环仍未验收。 |

README 已重写为 Personal AI OS 产品说明，并明确 Devin 本机 ACP 的证据边界。

## 3. 固定的架构边界

- 微信连接器负责消息、身份、附件、状态、审批和证据回传，不直接选择 Worker。
- Chief 负责理解、规划、上下文检索、调度、监督和汇总；默认 Codex/Kimi 的选择与 Worker 列表分开。
- 自有控制面管理 Task；原生 Agent 管理 Session；Cezar 管理自身 run/worktree。控制面不与 Cezar重复启动同一次执行。
- Session 引用须包含 Agent 来源、账号/profile 范围、原生 ID 和工作目录；不得仅按标题匹配。
- Execution 是一次执行尝试，保留 Task、Session、引擎 run 或云任务关联。转派建立新执行，不声称无损迁移原生上下文。
- 先元数据，再摘要，再相关消息片段，最后才是必要的完整历史；保留来源，不把摘要当完整记录，不读凭据或全量复制历史。
- 恢复失败明确返回错误，禁止静默新建；原生会话不可并发写入。无法判断 App 活跃状态时暂停并确认，本机锁不等于外部 App 已被约束。
- 本机 Devin 与 Devin Cloud 使用独立 adapter、认证和标识；本机 ACP 成功不能证明云端可用。
- Policy 在具体动作执行前校验；模型判断只是建议，审批绑定目标、参数和有效期。工作目录不等于沙箱，不默认复制现有 runner 的 auto-approve/bypass 行为。
- Worker 报完成进入待验证状态；只有验证、review 和证据齐备才能进入最终完成状态。

## 4. 目录与现有文件映射

设计文档第 18 节定义目标目录。本次只创建已实现的最小控制面模块，不移动 vendor、外部 Agent 历史或现有运行目录。

| 现有位置 | 后续归属 | 兼容要求 |
| --- | --- | --- |
| 根目录设计 HTML | docs/architecture/，仅未来获批归档时移动 | 更新执行文档及其他引用；保留原文与原始日期，处理原路径访问。 |
| gateway/wechat-control.mjs | connectors/wechat 与启动协调边界 | 先保留现有入口；区分连接控制与 Chief 启动，不用改 Worker preset 代替调度工具。 |
| gateway/kimi-chat-shim.py | adapters/providers | 保留 provider 兼容用途，不伪装成任务调度或 Kimi 原生历史恢复。 |
| config/wechat-acp.json | 兼容期保留 | 是桥接层配置，不作为全局 Feature Map 或 Worker 注册表。 |
| launchd/*.plist | deploy/macos/launchd，最后迁移 | 已增加控制面兼容定义；正式迁移前仍需核对仓库定义和已安装 LaunchAgents 副本。 |
| scripts/start-local.sh | scripts/ | 已增加 4324 控制面健康检查；当前相对路径依赖保留。 |
| vendor/cezar、vendor/wechat-acp | vendor/ | 保留上游结构；新增能力优先通过自有适配层接入。 |
| logs/、.ai/、~/.cezar/、~/.wechat-acp/ | 当前位置保留 | 不移动、清理或复制认证及运行状态。 |

未来新增项目设置与 skills 放在 .devin/。自有运行数据现在写入 `~/.local/state/ai-agent-cockpit/control-plane.json`（目录权限 0700、状态文件权限 0600、原子替换）；外部 Agent 的原生历史与凭据仍由各自管理。当前文件是控制面唯一的 Task/Execution 状态源，不复制外部历史。

## 5. 分阶段实施与验收

编号 A–G 是工程实施顺序，不替代设计文档中的产品 Phase 1–7。A 已完成，F 已完成兼容期 launchd/路径保留，B 已完成元数据索引第一片，C/D 已完成控制面写入第一片，正在进入原生恢复和 Chief 调度；权限和可靠恢复边界从首次执行就必须成立，不能等到阶段 E 才补安全。

### A：项目导航与方法论归档（首轮完成）

- [x] 更新设计 HTML v1.2 与执行文档，加入 pstack/SpaceXAI 方法论和当前实现边界。
- [x] 保留原项目路径和 vendor 结构；公开仓库 README 已说明 Personal AI OS 与兼容期边界。
- [x] 修正 Devin 描述：本机 `devin acp` 可握手/建 session，但 prompt 仍需 Devin 登录；不把 GUI/API 说成已完成。
- [x] 验收：HTML 内容保留；Cezar、微信桥、launchd、默认 Chief 和原生历史未迁移。

### B：统一本机会话管理（第一片完成，继续扩展）

- [x] 定义 Session 引用、分页、来源、能力与错误契约；已落地 `control-plane/contracts.mjs`，所有索引能力默认只读。
- [x] 接入 Codex、OpenCode、Kimi 的本机元数据索引；WorkBuddy、Devin、Claude Code、Antigravity 已做入口发现并明确能力缺口。
- [x] 优先原生元数据；SQLite/JSONL fallback 已验证读取一致性和隐私边界，不写外部库、不读取凭据和消息正文。
- [x] 验收第一片：同标题不同来源可区分；索引不加载全量正文；不支持能力明确报告；测试通过且未创建控制面状态目录。
- [x] 通过显式 Codex ACP probe 实际验证 `initialize`、`session/list`、`loadSession=true`、`sessionCapabilities.resume/list` 和 HTTP MCP capability；probe 不 load、不 prompt、不读取消息正文。
- [x] 通过用户显式调用的 CLI `sessions native-load-probe` 实测一个已有 Codex session 的 `session/load` 成功；该动作未暴露给 MCP/自动 Chief 工具，避免无审批恢复外部会话。
- [x] 通过显式 ACP probe 实测 OpenCode、Kimi、Devin 的 initialize/session/list；OpenCode/Kimi 还声明 load/resume，Devin 声明 loadSession 但未声明 resume；WorkBuddy initialize 成功但未声明 session/list。
- [ ] 继续验证这些 Agent 的 session/load、历史读取、认证和真实 prompt；不从 advertised capability 推断成功。

### C：Chief 管理工具层（控制面基础工具已完成，微信 Chief 接入未完成）

- [x] 通过 `gateway/control-plane.mjs` 和 `scripts/control-plane.mjs` 暴露只读来源/会话查询；CLI/HTTP 复用同一索引契约。
- [x] 通过同一 HTTP/CLI 契约创建 Task、Execution、Evidence，并查询任务关联状态；写操作必须带 Idempotency-Key。
- [x] 定义 Execution 状态、结果查询、Session lock 和有限状态转移；不允许从控制面直接启动未验证的外部 Agent。
- [x] 增加 `interfaces/mcp/server.mjs`，暴露 session、native session/list、task、execution、evidence、approval、audit、lock 和 Cezar plan/dispatch/cancel 工具。
- [x] 增加 `router.mjs` 的 capability/policy gate；可选 Jev advisory 只影响候选排序，不授权执行。4324 RoutePlan 已实测返回 codex 选择、confidence 和 `requiresApproval=true`。
- [x] Cezar dispatch 需要 action/target/parametersDigest 精确匹配的未消费 Approval；无审批不会启动外部 Agent。
- [x] 微信 bridge 已在 Codex ACP 会话配置中注入 `http://127.0.0.1:4324/mcp`；Agent 不支持 HTTP MCP 时安全忽略，不改变 fallback。
- [x] 微信 bridge 增加 `/approve <approval_id>`、`/reject <approval_id>` 及中文别名；命令只调用 Approval decision API，不直接启动 Worker。
- [x] 已直接通过 `/mcp` JSON-RPC `tools/call(list_native_sessions)` 实测 OpenCode ACP，返回 3 个本项目会话；这是控制面 MCP 验收，不等同于微信真实 prompt 验收。
- [x] 增加审批绑定的 Native ACP resume+prompt executor；失败/不确定进入 BLOCKED，成功只进入 VERIFYING。
- [x] 控制面已提供读上下文、native session/list、Approval-bound resume/prompt、Cezar cancel 和人工审批入口；恢复失败不能静默新建。
- [ ] 保持默认 Chief 与微信账号不变，验证 Chief 可以调度两个不同 Worker；任务内容由用户单独授权。
- [ ] 验收：同一 Chief 能新建和继续指定 Worker 的任务；恢复失败不新建；超时和取消不遗留受控子进程；真实 prompt/工具链验证与模型费用边界有明确证据。

### D：统一任务闭环与 Cezar 接入（第一片完成，仍需 UI/事件关联）

- [x] 确定 Task/Execution JSON 状态格式、事件所有者和状态映射；状态写入私有目录，原子替换并带文件锁。
- [x] 实现幂等请求、会话锁、有限状态转移、Evidence 关联和启动恢复保护；重启时遗留 running Execution 进入 blocked，不进入 completed。
- [x] Cezar adapter 通过 `/api/v1/runs` 创建 run，并把 Cezar run id、branch/worktree 元数据关联到 Execution；reconcile 把 Cezar done 映射为控制面 VERIFYING，不直接结案。
- [x] Cezar 取消也要求精确 Approval；控制面不会只改本地状态而假装外部 run 已停止。
- [x] Cezar adapter 已解析 `/runs/:id/events` SSE；watcher 将 Cezar done 映射到控制面 VERIFYING，并在控制面重启后保留 reconcile 兜底。
- [x] Reviewer Execution 规划器已把 Worker Execution 作为 parent，创建独立、可审计的 review child；只排队，不自动启动 Agent。
- [ ] 继续关联 Cezar review gate 和人工处理状态，不复制 Cezar 调度所有权。
- [x] 基础验收：重复请求不重复创建；状态非法转移被拒绝；会话锁冲突被拒绝；重启恢复不会把未完成任务标为完成。
- [ ] 完整验收：转派建立可审计新 Execution；外部会话活跃时不并发恢复；Cezar 重启后关联不丢失。

### E：验证、review、证据与审批闭环

- [x] Evidence 已记录 kind、summary、source、capturedAt、exitCode/uri 和执行关联；Worker 成功只进入 VERIFYING。
- [x] Approval 已绑定 action、target、parametersDigest 和 expiresAt，支持批准/拒绝/过期/单次消费；Cezar dispatch 已接入执行前复核。
- [x] Task completion gate 已要求终态 Execution、至少一个 succeeded、test/command Evidence 和独立 review Evidence，再消费一次性完成 Approval。
- [x] Dashboard 已显示待审批动作，并通过同一 Approval API 执行批准/拒绝；校验仍在控制面服务端完成。
- [x] `npm run doctor` 已统一检查 Cezar、微信、控制面、Feature Map 和回归评估，当前报告 `ok=true`、7/7 eval 通过。
- [ ] 将原有任务验证要求继续扩展到可复现命令、独立 review 和完整 Evidence Pack。
- [x] 微信 `/approve`、`/reject` 和中文别名已连接 Approval API；具体动作绑定、有效期和执行前复核由控制面服务端校验。
- [ ] 确认可强制权限边界；无法约束的 adapter 不作为自动执行通道，不开启 bypass 或修改安全设置绕过问题。
- [ ] 验收：Worker 自报完成不能直接进入最终完成；错误、过期或复用审批不能授权新动作；失败证据可追溯；未获授权的外部消息、部署和破坏性操作不执行。

### F：源码入口与运行路径迁移（兼容期已完成，正式迁移未执行）

- [x] 建立 launchd 常驻兼容入口：Cezar、微信 bridge、微信控制、Kimi shim、keepawake、Antigravity proxy。
- [ ] 拆分 gateway 的连接控制、启动协调与 provider shim；正式目录迁移仍需保留旧入口并回归验证。
- [ ] 单独确认 deploy/macos/launchd 迁移及已安装 LaunchAgents 的切换范围，记录旧路径、原服务定义和回退办法。
- [ ] 如需迁移自有日志与状态，先确认备份、权限、保留周期、停止写入条件和恢复方案；不搬外部 Agent 的历史及认证。
- [ ] 验收：旧入口兼容、新入口重启后正确；无重复桥接器或任务执行；微信身份、会话关联与待执行任务保留；失败可回到原服务路径。

### G：云端、GUI 与远程设备

- [x] Feature Map 已增加 Devin Cloud 与 GitHub Actions 的只读入口发现，并明确未验证认证、计费、权限和触发边界。
- [ ] 分开验证 Devin Cloud、GitHub Actions、GUI 与 SSH 设备接入，明确身份、计费、权限、并发与证据边界。
- [ ] 优先迁移已验证的本地工作流，不用本机 Devin ACP 证据替代云端能力验证。
- [ ] 验收：每类通道有独立 capability evidence；未授权支付、部署、外发与不可逆操作不执行；不支持能力明确降级而非假装已调度。

## 6. 验证与记录要求

实施时按阶段做最窄范围验证，不因目录规划运行全部构建或调用模型。控制面只读服务的实时健康验证已执行；涉及写入、恢复、外部消息或运行路径切换的验证仍需对应阶段和明确授权。

后续阶段完成时记录：授权范围、基线、实际变更、验证命令/退出状态、证据位置、限制、回退方案及未完成项。已完成项仅依据本仓库测试和实际端口/API 证据勾选；既往 ACP 握手不能替代真实 prompt、历史恢复或云端能力证据。

行为评估在闭环稳定后另行制定测试输入、rubric 和协议，本文件不新增评估阈值、自动授权或评分配置。当前 Task 存储、原生历史回放和 App 并发检测均有待实现前验证；遇到不支持的接口停止该路径并报告。

### 6.1 原生 ACP 探测证据（2026-10-06）

以下为早期只读探测的历史记录；Kimi 新建隔离会话的真实 prompt 验证随后已在 6.2 完成，不等同于用户旧会话恢复。

使用 `npm run sessions -- sessions native-list --provider=<id> --cwd=/Users/markus/ai-agent-cockpit --json` 做显式、无 prompt 的探测：

| Agent | 实际结果 | 当前边界 |
| --- | --- | --- |
| Codex ACP 2.1.1 | `initialize`、`session/list`、`loadSession=true`、`sessionCapabilities.list/resume`、HTTP MCP 成功；另用 `native-load-probe` 对一个已有 session 的 `session/load` 成功 | 未做 prompt、工具调用或自动恢复 |
| OpenCode 1.18.34 | `initialize`、`session/list`、`loadSession=true`、list/resume、HTTP/SSE MCP 成功，返回 3 个本项目会话 | 未做 load、prompt 或消息读取 |
| Kimi Code 2.0.2 | `initialize`、list、loadSession、list/resume、HTTP/SSE MCP 成功；本项目 cwd 返回 0 个会话 | 未做 load、prompt 或认证路径验证 |
| Devin ACP | `initialize`、list、`loadSession=true`、HTTP/SSE MCP 成功，返回 1 个本项目会话 | 未做真实 prompt、认证、load 或云端验证 |
| WorkBuddy ACP | `initialize`、loadSession、HTTP/SSE MCP 成功，但未声明 session/list | 旧会话不能由控制面猜测或静默创建 |

探测只保留规范化元数据和 capability 结果，不把 stderr、消息正文、token 或凭据写入控制面状态。

另外，控制面 `/mcp` 的 `tools/call(list_native_sessions)` 已用 OpenCode 实测返回 3 个会话；微信桥只完成 MCP 注入和桥接单元测试，尚未发送真实微信 prompt 触发工具调用。

### 6.2 Mem0 部署与验收（2026-10-06）

授权：用户要求直接部署推荐的记忆方案并验证可用性。本轮只修改项目记忆链路、相关可视化/测试/文档和对应常驻服务；不发送合成消息到真实微信，不恢复用户的原生 Agent 旧会话。

实际部署：

- `services/memory/service.py` 使用真实 Mem0 SDK 2.2.1，Python 3.11 独立环境，55 项依赖固定并通过兼容检查。API 为回环地址 `4325`，由 `com.markus.personal-ai-os.memory` 常驻；本机 token 鉴权，不启用 wildcard CORS。
- 多语言 MiniLM embedding 在本机运行，384 维；Qdrant 和 SQLite 存本机。事实提炼通过 4323 shim 调用已有 Kimi API，适配非 thinking / temperature 0.6 / top_p 0.95；不是全离线推理。
- 实际 ACP 派发前构建近期上下文、较早有损摘录、相关长期事实和可信人格；准备结果用于 fallback 重试，避免重复归档用户输入或混用原生 session。
- 正文追加到私有 JSONL；持久 outbox 在服务确认 SQLite 接收后移除。过长提炼输入分块，永久拒绝保留在 `rejectedOutbox`，不会卡住后续事件。只从用户表述提炼事实，助手输出仅归档。
- 修复索引式压缩、超长上下文界限、跨实例写锁、prototype-like 用户 ID 和关闭后的上传竞态。旧快照生成私有备份，并回填尚存的 9 条对话正文；没有删除或迁移原生历史和微信身份。
- 发现已安装微信 plist 的 `--agent codex-official` 覆盖配置；已备份并改为 `kimi-primary`，不只是修改配置文件。
- Dashboard / Settings 复用系统连接组件，增加 Mem0 实时队列状态，移除固定 Codex 主 Agent/微信已连接声明。

验证命令与结果：

| 验证 | 结果 |
| --- | --- |
| `npm test`（vendor/wechat-acp） | 233 通过、1 个仅 Windows 适用的测试跳过；包含派发时记忆准备、fallback 复用、并发、归档、服务不可用、永久拒绝和停机测试 |
| `npm run test:memory-service` | 11/11；鉴权、大小/schema、用户隔离、并发幂等、token/队列重启保留、脱敏错误重试、助手排除和权限 |
| `npm run test:control-plane` | 20/20；包括 Kimi 主对话配置和 Mem0 独立服务状态，不把记忆服务列成 Worker |
| 前端 SystemConnections + AgentsSection | 28/28；真实/不可用记忆状态、Kimi 标签、微信入口和既有设置回归 |
| 微信桥 build、前端 typecheck/build、plist lint、依赖兼容检查 | 通过 |
| 实际浏览器页面验收 | 未完成；ego-browser 导航/CDP 超时，恢复尝试后结束该自动化，不把构建和单元测试冒充浏览器实页通过；HTTP 已确认部署后的新资源被服务提供 |
| `MEMORY_TEST_TAG=mem0-verification-primary npm run test:memory-live` | 真实 Mem0/Kimi 中文提炼与语义检索、鉴权、幂等、隔离、桥实例重建后上下文和归档通过；在实际服务停启后复测通过 |
| `npm run test:memory-kimi` | 真实 Kimi ACP 从仅存于 Mem0 的合成事实正确召回“小柚”；实际桥接准备和用户/助手正文归档通过；真实微信发送数为 0 |
| `npm run test:memory-recovery` | 实际停止/恢复 Mem0；本地上下文降级小于 3 秒、持久积压、旧向量保留、恢复后真实语义入库、助手推测排除及隔离通过 |

边界与回退：原文归档是对话正文，不含附件二进制和原生工具内部状态；较早摘录有损，模型每轮不必加载全量历史。投递为 at-least-once，SDK 写入与 receipt 更新间的断电可能重放，不保证 exactly-once。常见 token 脱敏不覆盖所有秘密形式，Jev advisory 风险检查也不能替代实际隐私校验。可选 spaCy/BM25 未列为已验收能力。没有做真实微信消息回包或长时间合盖耐久测试，本轮不据此保证全链路永不出错。

回退时先停微信写入并备份当前状态；可把配置的 `memory.mem0` 关闭而保留本地上下文/完整归档，再停 Mem0 服务。不要删 runtime、私有备份或恢复旧快照覆盖新对话。旧微信启动定义备份保存在私有 `mem0/migration/`，不把凭据或备份提交到公开仓库。

## 7. 本次交付边界

本轮已执行并验证：

- 重写 README，产品名称统一为 Personal AI OS，保留旧目录和兼容期 launchd 标签。
- 新增控制面契约、Codex/OpenCode/Kimi 会话索引、WorkBuddy/Devin/Claude Code/Antigravity 能力发现、Task/Execution/Evidence API、CLI 和 HTTP 查询入口。
- 新增私有 Task/Execution 状态存储、幂等键、原子写入、会话锁、Approval 和重启恢复阻断。
- 新增 MCP 工具层和 Cezar adapter；Cezar 真实派单必须经审批，完成状态先进入 VERIFYING。
- 新增控制面 launchd 定义，并让 `scripts/start-local.sh` 管理 4324 健康检查。
- 更新设计 HTML v1.2 和本执行文档，使研究结论、代码状态和限制一致。
- 验证 `npm run test:control-plane`、HTTP 临时状态端到端测试、Node 语法检查、plist 校验、`127.0.0.1:4324/health` 与会话/任务 API。

本轮新增共享记忆的交付与验证见 6.2；真实 Kimi ACP 的合成对话已验收。尚未执行：真实微信消息驱动 Chief 工具调用/派单的完整闭环、原生旧会话的历史读取/真实用户任务验证、Cezar worktree/review 完整关联、GUI Agent 自动化、Devin 登录绑定、正式目录迁移和云端通道。MCP 配置已注入，但不能用“配置存在”冒充 Agent 实际调用证据。
