# Personal AI OS 执行文档

状态：重构进行中。本文与 [设计文档 v1.2](personal_ai_os_wechat_mac_agent_architecture_v1.html) 配套；已完成兼容期部署、微信常驻、ACP fallback、首批控制面可视化，以及只读 Task/Session/Execution 契约和本机会话索引，正在进入 Chief 工具层和持久化阶段。

## 1. 当前授权与范围

用户已授权开始执行重构。本文是执行状态和验收记录，不把规划项误报为已完成。

项目继续保留 `/Users/markus/ai-agent-cockpit` 路径以避免破坏 launchd 和原生历史；产品名称升级为 Personal AI OS。vendor Cezar、wechat-acp、原生 Agent 历史和凭据不迁移、不复制、不覆盖。重构通过兼容适配层逐步接入，默认 Chief 与微信身份保持不变。

任何服务切换、目录迁移、历史写入、外部消息、部署或破坏性动作仍需单独确认。失败时报告并停下，不自行放宽权限。

## 0. 当前重构状态

| 能力 | 当前状态 | 证据/限制 |
| --- | --- | --- |
| 微信入口 | 已运行 | launchd 常驻；微信 ACP 主 Codex，5 分钟 prompt 超时；连接器不直接承担 Chief 路由。 |
| Cezar cockpit | 已运行 | `127.0.0.1:4321`；负责本身的 run/worktree；不是全机 App 历史控制面。 |
| Agent fallback | 已实现第一版 | 主 ACP 启动失败/超时可切换 DeepSeek、Kimi、WorkBuddy、Devin/OpenCode 候选；provider 认证和历史恢复仍分别归各 Agent。 |
| Dashboard / Settings | 已实现第一版 | Dashboard 首屏系统连接卡片；Settings → Agent 可见微信、Codex、OpenCode、Kimi、WorkBuddy、Devin、Antigravity 边界；深层页面仍有英文待翻译。 |
| pstack 方法论 | 已纳入设计 | Skill-first、Chief/Worker/Reviewer、arena/interrogate/tdd、verification-first、顺序降级。尚未完成独立 Eval Harness。 |
| Task/Session/Execution 控制面 | 已完成第一片 | `control-plane/contracts.mjs` 已提供运行时校验；`session-index.mjs` 和 `gateway/control-plane.mjs` 提供只读索引。尚未持久化 Task/Execution，也未开放写入或派单。 |

## 2. 已观察的基线，不等于闭环完成

| 项目 | 证据边界 |
| --- | --- |
| 微信入口 | 已检查配置和启动定义使用默认 Codex；连接器是移动入口，默认 Agent 可承担 Chief。当前文档更新不重新探测实时运行健康。 |
| Cezar | 已检查实现包含任务派发、run 继续、worktree 和 runner seam；已检查的 runner 注册表没有 Devin。 |
| Devin 本机 | 之前的孤立 ACP 验证成功完成 initialize 和 session/new；未验证真实 prompt、模型鉴权、旧会话 list/load、历史读取、工具调用或云端调度。 |
| Devin preset | config/wechat-acp.json 中已有 devin 入口 preset；没有通过本次更新启用它。它不是 Chief 调用 Worker 的工具。 |
| 能力页面 | 已检查的 Local agents 是静态声明，不能用作调度成功或运行健康证据。 |
| 跨 Agent 管理 | 在已检查的入口与调度代码中未发现完整统一会话检索与 Chief 调度闭环，不能标为已实现。 |

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

未来新增项目设置与 skills 放在 .devin/。自有运行数据仍规划放在 ~/.local/state/ai-agent-cockpit/；当前第一片只读索引不创建控制面状态目录，外部 Agent 的原生历史与凭据仍由各自管理。Task 存储格式和迁移方案在阶段 D 实现前确定，不按文档目录直接创建第二套运行状态。

## 5. 分阶段实施与验收

编号 A–G 是工程实施顺序，不替代设计文档中的产品 Phase 1–7。A 已完成，F 已完成兼容期 launchd/路径保留，B 已完成第一片只读索引，C/D 正在启动；权限和可靠恢复边界从首次执行就必须成立，不能等到阶段 E 才补安全。

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
- [ ] 继续验证 Devin/Codex 原生 list/load、历史读取和恢复，不从命令名或 advertised capability 推断成功。

### C：Chief 管理工具层（只读查询已开始）

- [x] 通过 `gateway/control-plane.mjs` 和 `scripts/control-plane.mjs` 暴露只读来源/会话查询；CLI/HTTP 复用同一索引契约。
- [ ] 通过 interfaces/mcp 暴露读上下文、新建、恢复、状态与取消；在审批和幂等契约完成前不开放写入。
- [ ] 定义异步 operation/execution 标识与结果查询，限制启动参数、工作目录与权限。
- [ ] 保持默认 Chief 与微信账号不变，验证 Chief 可以调度两个不同 Worker；任务内容由用户单独授权。
- [ ] 验收：同一 Chief 能新建和继续指定 Worker 的任务；恢复失败不新建；超时和取消不遗留受控子进程；真实 prompt/工具链验证与模型费用边界有明确证据。

### D：统一任务闭环与 Cezar 接入（未完成）

- [ ] 确定 Task/Execution 持久化格式、事件所有者和状态映射，再实现任务图及关联存储。
- [ ] Cezar adapter 关联其原生 run/worktree 与控制面任务，不复制调度所有权。
- [ ] 实现幂等请求、会话锁、有限重试、明确等待/失败/人工处理状态、重启恢复与状态协调。
- [ ] 验收：重复请求不重复派单；转派建立可审计新 Execution；进程崩溃或服务重启不会把未完成任务标为完成；外部会话活跃时不并发恢复。

### E：验证、review、证据与审批闭环

- [ ] 将原有任务验证要求映射到可复现验证与独立 review；证据记录命令、退出状态、结果、来源和执行关联。
- [ ] 连接微信审批与 Policy，确定具体动作绑定、有效期、拒绝/超时处理及执行前复核。
- [ ] 确认可强制权限边界；无法约束的 adapter 不作为自动执行通道，不开启 bypass 或修改安全设置绕过问题。
- [ ] 验收：Worker 自报完成不能直接进入最终完成；错误、过期或复用审批不能授权新动作；失败证据可追溯；未获授权的外部消息、部署和破坏性操作不执行。

### F：源码入口与运行路径迁移（兼容期已完成，正式迁移未执行）

- [x] 建立 launchd 常驻兼容入口：Cezar、微信 bridge、微信控制、Kimi shim、keepawake、Antigravity proxy。
- [ ] 拆分 gateway 的连接控制、启动协调与 provider shim；正式目录迁移仍需保留旧入口并回归验证。
- [ ] 单独确认 deploy/macos/launchd 迁移及已安装 LaunchAgents 的切换范围，记录旧路径、原服务定义和回退办法。
- [ ] 如需迁移自有日志与状态，先确认备份、权限、保留周期、停止写入条件和恢复方案；不搬外部 Agent 的历史及认证。
- [ ] 验收：旧入口兼容、新入口重启后正确；无重复桥接器或任务执行；微信身份、会话关联与待执行任务保留；失败可回到原服务路径。

### G：云端、GUI 与远程设备

- [ ] 分开验证 Devin Cloud、GitHub Actions、GUI 与 SSH 设备接入，明确身份、计费、权限、并发与证据边界。
- [ ] 优先迁移已验证的本地工作流，不用本机 Devin ACP 证据替代云端能力验证。
- [ ] 验收：每类通道有独立 capability evidence；未授权支付、部署、外发与不可逆操作不执行；不支持能力明确降级而非假装已调度。

## 6. 验证与记录要求

实施时按阶段做最窄范围验证，不因目录规划运行全部构建或调用模型。控制面只读服务的实时健康验证已执行；涉及写入、恢复、外部消息或运行路径切换的验证仍需对应阶段和明确授权。

后续阶段完成时记录：授权范围、基线、实际变更、验证命令/退出状态、证据位置、限制、回退方案及未完成项。已完成项仅依据本仓库测试和实际端口/API 证据勾选；既往 ACP 握手不能替代真实 prompt、历史恢复或云端能力证据。

行为评估在闭环稳定后另行制定测试输入、rubric 和协议，本文件不新增评估阈值、自动授权或评分配置。当前 Task 存储、原生历史回放和 App 并发检测均有待实现前验证；遇到不支持的接口停止该路径并报告。

## 7. 本次交付边界

本轮已执行并验证：

- 重写 README，产品名称统一为 Personal AI OS，保留旧目录和兼容期 launchd 标签。
- 新增只读控制面契约、Codex/OpenCode/Kimi 会话索引、WorkBuddy/Devin/Claude Code/Antigravity 能力发现、CLI 和 HTTP 查询入口。
- 新增控制面 launchd 定义，并让 `scripts/start-local.sh` 管理 4324 健康检查。
- 更新设计 HTML v1.2 和本执行文档，使研究结论、代码状态和限制一致。
- 验证 `npm run test:control-plane`、Node 语法检查、plist 校验、`127.0.0.1:4324/health` 与会话来源 API。

尚未执行：Task/Execution 持久化、Chief 写入/派单、原生旧会话恢复、GUI 自动化、Devin 登录绑定、正式目录迁移和云端通道。它们仍按 A–G 清单推进，不以本轮只读索引冒充完成。
