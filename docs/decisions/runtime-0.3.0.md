# 0.3.0 P0 运行底座决定与当前证据

阅读说明（2026-10-08整理）：本文按时间保留实现、失败和测试过程；早期“无工具/尚未新增”说明是当时状态，不覆盖后续已完成的受控工具。最新四类状态和部署结论看[阶段台账](../plans/0.3.0-status.md)，执行顺序看[执行计划](../plans/0.3.0-execution.md)。仓库名称/公开状态本轮已核对，功能测试未因文档整理而重新计数或改日期。

状态：P0/P1/P2隔离实现已推进，G0/G1/G2尚未全部通过；更新2026-10-08。生产默认仍为legacy/0.2.2；原基线`7af284b`，本轮测试工作树HEAD为`507b52d`（保留用户README提交）。代码、隔离证据与生产部署分开记录。

## 已取得的基线证据

| 检查 | 本轮实际结果 |
| --- | --- |
| `npm run doctor` | ok=true；Cezar、微信控制服务、控制面、Mem0、Goal 服务可用；微信 connected |
| `npm run test:control-plane` | 21/21 通过 |
| `npm run test:goals` | 原48项；增加Goal broker11项及bootstrap回归1项后60/60通过；隔离副本、实际Seatbelt、无真实模型 |
| `npm run test:memory-service` | 原基线11/11；新增来源/质量/重试/忘记后83/83通过 |
| 微信本地记忆/客户端定向测试 | 21/21通过，含隐私屏障、重复上传、请求摘要、异步召回竞态；tsc/build通过 |
| 微信桥完整回归 | 312通过、1项Windows-only跳过，0失败 |
| `npm run test:runtime-canary` | 9/9通过；真实上游库、SQLite FULL/WAL、重开和副作用边界 |
| `npm run test:runtime-owner` | 14/14通过；双owner/别名/租约/真实子进程终止/回滚/实际faux模型重开 |
| `npm run test:runtime-contract` | 14/14通过；实际Pi适配器、不可变请求映射、等待取消与重开去重；不是完整G2 |
| `npm run test:runtime-settings` | 27/27通过；回调检查点故障复现、私有字段/非JSON/访问器拒绝、设置快照与保存答案验证 |
| 四个运行层测试文件联合 | 64/64通过，0跳过；9基础+14所有者+14合同+27设置/探测 |
| 六个运行层测试文件联合（2026-10-08） | 87/87通过，0跳过；原64+受控工具19+实际SIGKILL重放4 |
| `npm run test:kimi-shim`（2026-10-08） | 9/9通过；loopback首帧早于EOF、旧buffering负例、错误脱敏和HTTP状态完整性 |
| `npm run test:runtime-policy` | 27/27通过，0跳过；10审批/MCP、6HTTP身份、9实际已编译ACP客户端/Approval联动、2进程锁测试；tsc通过 |
| Goal前端与Dashboard | continuous-goals13/13，Dashboard26文件167项通过；web typecheck通过，未构建替换生产静态资源 |
| `npm run runtime:adapter-canary` | fake通过，真实适配器与SQLite；保存正文正确、重复/重开额外模型调用0 |
| `npm run test:runtime-live` | 真实适配器→既有Kimi shim HTTP200，48 token；落盘marker正确，重复/重开同Submission且额外调用0 |
| `npm run runtime:canary` | fake通过；重复/重开零额外模型调用，正文冲突仍需产品Gate |
| `npm run runtime:canary -- --live` | 既有Kimi shim HTTP200、marker正确、41 token；无工具/微信/原生恢复 |
| 独立事实缺失复现 | 用真实 Mem0Engine 接口和假 Mem0 返回，输入对象丢失后 receipt 仍 done；真实模型/生产写入均为 0 |
| Node 与架构 | Node v24.15.0，arm64；满足 Pi 1.0.4 的 Node >=22.19.0 要求 |
| 服务监督 | 保持现有 launchd 标签与运行进程；未重启或改配置 |
| 用户改动 | AGENTS.md 已有一行用户改动；不覆盖、不纳入升级自动提交 |
| root锁文件已知漏洞检查 | `npm audit --package-lock-only --ignore-scripts --json`，公开npm registry报告121项依赖、已知漏洞0；退出0，锁文件SHA256未改 |

昵称丢失 fixture 见 `tests/fixtures/memory-quality.json`。Mem0 健康和 done 数不是关键事实正确的证明，P1 必须拒绝无来源/缺失关键值的可信事实，并给出有限重试和 needs-review。

## 已核对的上游发布物

Pi Durable、Pi-AI、Chord、Pi Telemetry 1.0.4 和 Paseo Client 0.10.3 已用 `--ignore-scripts --no-audit --no-fund` 安装并锁定到 `package-lock.json`；没有执行任何生命周期脚本。Google GenAI、protobufjs 和 esbuild 有安装脚本，均未执行。Pi Telemetry 默认是本地NOOP接口，不等同上游Azure外发遥测。完整依赖安全审计尚未完成。

本轮root锁文件npm已知漏洞查询为0，锁文件保持原摘要，没有安装/升级/fix或执行生命周期脚本。该结果只覆盖此锁文件和registry当时的已知公告；不证明供应链、插件、vendor/全局CLI或Python依赖已全部安全。完整引用/许可/外发与依赖审计仍待完成。

原JSONL+fsync倾向经源码复核后收敛：1.0.4的commit只flush sidecar，主commit marker的append没有同步flush，不能据fsync=true宣称强掉电持久化。当前新增 `runtime/full-sqlite.mjs`，通过公开NodeSqliteDatabase/SqliteStorage API显式设置和检查WAL+synchronous=FULL，不修改上游。9项测试覆盖重开和权限负例。owner/fence、安全重放、迁移及真机掉电/休眠还需后续验证。

## P1 记忆质量实现与实测

`service.py` / `quality.py` 已增加来源坐标、提炼版本、可信回执、准备后落盘再写向量、幂等span查询、有限重试、needs_review、私有状态查询，以及“向量已写但回执未完成不可检索”的保护。旧done记录标为legacy_unverified，不删除、不冒充新版可信事实。

初始Kimi自由JSON提炼候选虽有单元证据，实调用的英文姓名/预算出现语义不确定、超时和格式失败。该失败事件保留并在第三次失败进入needs_review，未被强行重置/删除。当前默认改为extraction-v2：代码分隔完整原文句子，Jev有界选择/完整性检查，Mem0以infer=False存储原文。Kimi仍是主对话模型；Jev不生成改写，不证明真理或授予动作权限。阈值0.90选择/0.10排除，模糊区间不静默丢弃。

新增 `scripts/test-memory-quality-live.py --live`。三次独立真实Jev+Mem0隔离批次，每批中文昵称/语言、英文姓名/预算/币种、否定偏好3/3通过，共9个样例，关键值和来源坐标正确，生成式提炼调用0。不是生产部署或全部P1验收；跨事件更正/冲突、忘记/永久删除、旧事实验证迁移、前端质量状态与实际桥接上下文仍需补齐。

## 服务参数盘点差距

本轮只读核对8个相关launchd标签的脱敏参数；保留keepawake及现役服务。control-plane实际加载来源已查明为项目launchd/com.markus.ai-agent-cockpit.control-plane.plist，而非用户LaunchAgents；登录/重启的自动加载安装仍需迁移前确认。微信桥未看到显式关闭遥测的环境项，未据此断言所有当前外发情况。

## P1 忘记与本地上下文协调

新增lifecycle.py：鉴权服务端/v1/forget与/v1/controls，用户/事件/原文hash绑定、原子目标检查、稳定请求摘要、单调memory_epoch和持久tombstone。新旧事件ID重复同文/同句不再提炼或可信召回；提炼/存储/异步查询竞态不能清除屏障。软忘记不删raw payload/vector/archive，也不调用SDK reset。

微信memory.ts / mem0.ts已实现本地pending屏障先落盘再远端确认；失败、重启、同ID不同目标、异步召回期间忘记、旧摘要/旧回复/同文新ID均覆盖。屏障后不再注入pre-boundary历史，但未忘记的长期事实仍可召回，完整原始归档供用户审计；当前ACP/GUI原生会话还没有自动隐私重置。编译与21项定向测试通过。

真实Mem0软忘记canary，以及隔离FastAPI+实际已编译MemoryStore联合测试通过：可信事实先可召回，忘记后server/local都屏蔽，同文新ID上传被抑制，raw archive字节未改。全程无真实微信发送/原生恢复/生产数据写入，隔离服务已关闭。永久擦除和跨事件更正/冲突、旧事实迁移、UI审批仍待实现。

## P2 存储所有者保护

新增owner-sqlite.mjs，辅助owner表在同一durable SQLite内，非另一套运行状态机。host hash+PID+私有token+单调fence在事务内核对；到期但PID活着不会被偷走，只有同host确证死亡或显式released可重领。旧owner不能写、续租或关闭新owner，过期在事务中发生会回滚。13项初始证据后补实际faux生成/重开和事务内到期测试，当前14项通过；不等于目录/网络产品Grant、Native side effects exactly-once或完整RuntimePort实现。

## P2 基础RuntimePort与Kimi兼容修复

新增`runtime/contracts.mjs`、`runtime/pi-adapter.mjs`及14项合同测试。提交先持久绑定owner/request/body摘要、产品Task/Execution、profile/cwd/model引用，再调用公开Harness。变更正文/授权引用/默认模型不能复用原请求；重开丢失的Submission映射按原requestId核对，不重放用户输入。调用者取消wait只取消等待，后台生成继续。当前仅支持submission/conversation取消，无工具注册，`authorizationDigest`只是引用，不授予权限。

真实适配器首次探测立即unanswered的原因已用实际Harness和faux复现：`settings.stream.onPayload`被写入GenerationTask检查点，严格JSON复制拒绝函数；终态为unanswered/faulted，模型与回调调用均为0，尚未发出HTTP。Pi 1.0.4的ConversationStreamOptions也不含maxTokens/temperature/samplingParams/onResponse，这些值不能硬塞入durable设置。

修复后复用Chord的`copyJson`先验证并脱离调用者对象，再把副本交给Harness。访问器不执行，符号/隐藏属性/非JSON/原型/非法枚举和数值被提前拒绝。当前无工具适配器拒绝headers/metadata/apiKey及回调等私有字段，不打印原始值；原对象在open后被修改不能偷渡回调或扩大设置。Kimi的思考/采样/96-token上限及传输回调只在进程内Provider facade应用。

新增`scripts/runtime-adapter-canary.mjs`，默认faux，`--live`只访问既有4323 loopback shim：超时35秒、模型/SDK重试关闭、合成正文、零工具，不接触真实微信或原生会话。答案按settled.answer引用通过公开Storage.entry精确读取本会话保存正文，而不是把答案ID当文本。首个人工探测已得到HTTP200/done，但该ID读取断言错误导致探测失败；没有计为完整成功。修正后的正式命令单次48 token、HTTP200、保存marker正确，duplicate/reopen同Submission，额外真实模型调用均为0。本轮两次合成真实调用共96 token，不是全天或fallback验收。

本轮重新运行运行层64项、控制面21项和Goal48项，全部通过；doctor确认现役服务健康、微信connected、生产仍0.2.2。未重编译/重启微信、未启用pi路由、未迁移或删除真实数据。

官方DeepSeek三个写任务均为terminal partial，不计成功或独立review：`1791376206-def4cbf26f85`、`1791376441-7073d5697d16`、`1791376736-dd516769aba7`。父Agent逐一检查实际改动，未重放原任务；源候选经精简修正，补齐实际回归和canary。临时scratch探测未导入产品。没有换第三方Provider或修改全局配置。

只读补充审查job `1791377392-10b1167ef1f8`终态failed，未返回有效结构化结论；文件修改0，三份审查输入与产品源字节一致。它也不计独立review通过；当前接受依据为父Agent源码复核和上述实际测试，完整阶段独立审查门槛未豁免。

仍未实现legacy adapter、正式provider/凭据引用解析、Goal范围/OS文件与exec broker接入、foreground/background/Execution/Goal取消范围、安全工具重放及P3入口/Outbox接入。下面的单次审批组件不等于这些完整能力。新适配器依然不对外提供真实工具；G0/G1/G2和后续发布门槛保持未通过。

## P2 权限入口、单次ACP broker与写锁修复

本轮源代码修复三个真实绕过入口：Approval创建不得带approved/approvedBy/usedAt，Execution创建必须queued；MCP默认不向模型开放decide_approval/update_execution_status/add_evidence，viewer只能只读，未知身份拒绝；所有MCP参数先做严格JSON副本与已声明字段检查，拒绝command/args/env/store/principal等隐藏注入。operator/coordinator是可信宿主身份，不读取模型传来的角色或自称批准文字。已消费审批不能重新贴审批人标签，旧持久记录不删除。

新增`request-authority.mjs`：新HTTP路径可读取私有权限文件中的凭据摘要，将Bearer确定性映射为operator/coordinator/chief/viewer。文件必须绝对路径、非符号链接、当前用户所有、无组/其他用户权限；错误配置不降级。`CONTROL_PLANE_REQUIRE_AUTH=1`要求配置`CONTROL_PLANE_AUTH_FILE`，缺失拒绝启动。严格健康接口不公开持久任务数据，也不提供返回Token的bootstrap。审批人来自已认证身份；原生远程参数拒绝自带命令覆盖。严格HTTP外部派单/取消和MCP派单要求已认证operator来源和明确有效期，不能消费旧的仅带approvedBy文字的记录。

未配置权限文件时，网关明确是legacy-loopback，保留0.2.2兼容入口；这不是安全的新工具部署模式。当前生产尚未重启或加载严格模式，UI/微信凭据引用、撤销和真正范围授权仍须接入，不能只设置开关便宣称全机安全。GoalRuntime在当前Goal lease、generation和grant摘要核对下，先创建pending再由可信协调代码确认完成审批，沿用原授权到期时间；不是把模型答案直接变成审批。

新增`acp-permission-broker.mjs`复用现有Approval store。绑定owner/source/account/profile/native ID/cwd/Task/Execution，要求可核对的rawInput与唯一allow_once。消费时同一原子写入检查当前running Execution及native engine引用；缺失、旧未验证来源、过期/无期限、摘要冲突、身份漂移和取消竞态拒绝。幂等回执的replay不再次返回允许，避免“已写审批但未确认客户端是否收到”时重复放行。单次broker不会运行工具，也不等于Goal范围内的批量委派授权。

已删除微信ACP客户端的blanket auto-allow、第一选项/allow_always兜底和裸整机文件回调。缺可信broker一律cancelled；只接受仍属于当前turn的唯一allow_once。filesystem capabilities按实际宿主回调声明，缺回调不读写文件。这只保护客户端提供的操作，不证明原生Agent内部shell/网络/文件已被OS限制；V25仍需实际沙箱接入和原生验证。broker尚未自动装入生产SessionManager或Pi工具注册。

审查落盘时发现旧ControlPlaneStore按30秒mtime抢写锁；不能排除合盖恢复后误抢活进程。当前用Node SQLite的OS写锁仅协调写者/回收者，记录仍在原JSON文件；完整PID/token锁记录通过hardlink发布，活PID/未知所有者不按时间抢锁，旧token不释放新锁。新写入先同步临时文件，rename后同步目录。两项实测包括老mtime的真实活子进程不被抢、SIGKILL后OS释放协调并核对死PID恢复、两个实例并发保留8条记录；不是实际suspend或掉电测试。P6必须停止/drain旧版写者后切换，旧版未使用新协调协议，不能混跑时宣称同样保护。

本轮`test:runtime-policy`27项、控制面21项、Goal48项、运行基础联合64项全过；微信桥完整回归312通过/1项Windows-only跳过。已编译微信桥用于测试，没有重启服务、发真实微信、读写真实原生会话或迁移用户状态。doctor仍ok=true、微信connected、Goal服务0.2.2，现役控制面不报告新authorizationMode，不能把源码和构建当作已经部署。

官方Worker job `1791378120-65b80138df17`终态partial，有4个实际文件片段，无有效最终结构化结果；未计独立review成功。父Agent核对diff、修正更完整的角色/参数/事务边界，并补测新HTTP/ACP/锁联动；没有自动重放或换Provider。

当时发现的额外风险：旧Goal服务`/api/bootstrap`仅按可伪造的Origin/自定义头返回共享Token；本轮已经源码封闭，实际结果见下一节。生产仍加载旧代码，不能把源码当部署。真实配对、原生CLI OS-launch限制、Pi工具注册、正式预算/UI审批/撤销、迁移和真实合盖仍未验收。

## P2 Goal范围broker、只读验收与bootstrap封闭

新增`goal-access-broker.mjs`并接入现有GoalRuntime真实执行路径，复用GoalStore及原工作副本，不新增scheduler/registry/grant数据库。绑定Goal/owner/generation/specDigest/workspaceDir与私有lease；每次重读当前授权，拒绝改向、暂停、失效/过期、scope正文与摘要不符、工作目录或授权期限漂移。最后允许的迭代仍可验证/结束，不能借此开始额外迭代；合法的已满token预留仍可核对实际用量，后续新工作不得越预算。

快照和提案写入使用固定可信Node helper、JSON stdin和实际macOS Seatbelt：限制User/temp/volume访问到批准的精确文件，网络禁用、环境不传父进程秘密、无模型eval、无非沙箱fallback；逐文件/总量限额，O_NOFOLLOW及regular-file检查，唯一临时文件同步后rename再目录同步。原项目不被写入，Reviewer只读，实际验收进程现在也不能写Worker允许的文件。命令必须逐项等于原确认的固定Node检查，不因其他文件以.test.mjs结尾便获准。

长检查在Goal锁内核对并同步启动，等待放在锁外；出生即监听stdout/error/close，避免快速子进程丢事件。取消/期限/授权监视会终止并等待自己启动的进程，暂停不会被整段检查占锁卡住。ACP filesystem回调接口可绑定实际宿主session并处理批准的绝对/相对路径，但尚未自动接入真实SessionManager或Pi扩展。新broker保护的是Goal副本与检查，不等于所有原生CLI/App已被整机限制。

验证过程保留失败：deny-all-read的Node探测SIGABRT，未据此开放User目录或跳过沙箱；第一源候选6项Goal回归失败，修正句柄返回/监听后仍5项因文件写入失败。最终定位macOS /var→/private/var路径别名造成临时文件literal不匹配；改用canonicalRoot后27项旧核心/恢复回归通过，追加11项真实broker测试后Goal全集60/60通过。长检查暂停、原源不变、Reviewer/验收写拒绝、out-of-scope/网络、最后一轮、宿主漂移、变更scope/expiry、symlink、原检查列表与预取消均有实际断言；不代表掉电/24h或所有路径race已测试。

Goal `/api/bootstrap`源码一律410 BOOTSTRAP_RETIRED，不再返回Token；真实HTTP测试包括伪造Origin/header及已认证请求。微信Goal client继续从原本机私有token文件读凭据，身份不迁移。前端移除bootstrap，改为中文密码输入/连接/断开，仅当前组件内存持有；不写Web存储、URL、日志，不把Token放Query key。连接状态以HTTP实际结果判定，清理/取消连接缓存与请求，实例隔离缓存，卸载和换凭据不沿用旧数据。手动凭据是正式桌面/应用配对前的安全过渡界面，不宣称完整零配置配对已交付。

前端首次测试8通过/2定位失败，typecheck发现测试取首项可为undefined；已改精确status断言与存在性检查，并修正认证失败仍显示已连接。最终专用13项、Dashboard167项、web typecheck通过；没有执行生产build:web或替换当前资源，没有声称真实浏览器/手机通过。

官方Worker `1791381993-7644df017742`成功，实际4文件与manifest一致；仅交付bootstrap/UI候选，UI实际验证由父Agent完成。broker的`1791382648-30f4f193b538`与`1791383215-c356de6e7cb4`均terminal partial，未计成功/独立review，父Agent逐项修正并运行实际测试；未自动重放或换Provider。现役仍0.2.2/legacy，未重启服务、发真实微信、操作真实原生会话/凭据或迁移/删除用户数据。G0/G1/G2等完整门槛仍未通过。

## P2 受控Chief工具、Kimi只读闭环与实际SIGKILL（2026-10-08）

新增`runtime/chief-tools.mjs`，只接受宿主签发并绑定owner/Task/Execution/profile/cwd/authorizationDigest的冻结suite。默认三个顺序工具：当前任务查询、创建queued子执行、原生prompt规划；可选只读profile只注册查询。不注册审批、Evidence、完成、实际派单、shell或文件工具。规划明示`nativeIdentityVerified=false`与`requiresApproval=true`，queued不代表接通Worker。引用与digest仍不授予权限。返回拒绝时设置`isError=true`，错误不含输入/秘密。

`PiRuntimeAdapter`用公开SDK对象注册工具/扩展，映射保存toolProfile版本与digest。伪suite、裸registry混入、请求scope漂移、无工具对话加权限、丢失/改变profile及未知版本均提前拒绝。重开与recover还重核持久request绑定，不只比较profile摘要。suite的数组/定义/读facade不能install/uninstall或被调用者修改；descriptor副本修改不会扩大权限。

补查发现getTask到createExecution之间的取消竞态：现已将父状态/Task/父子关系检查放进同一ControlPlaneStore写锁，guard也进入幂等fingerprint。实际负例在读取后取消父执行，结果无子row、无execution.created事件、无effect key。相同Pi taskId/callId与相同参数复用一个子row；参数改变冲突，不能增建。19项工具测试包括真实Pi/faux查询→queued child→规划、HTTP/SSE合成兼容测试和非2xx零重试；均不启动原生Agent。

新增`scripts/runtime-tools-canary.mjs`：默认faux，显式live只有查询工具。现役shim和修复源码临时shim分别通过：2轮HTTP200、1个真实保存tool result、marker正确、每次总usage536 token、产品状态字节不变；重复/重开同Submission，额外调用0。每轮96输出token上限、45秒总deadline，SDK和模型重试关闭；不是Kimi CLI恢复或外部Worker派单。原无工具live本轮也通过，usage45 token。

早期只读live探测失败为unanswered/model_error、未取得成功HTTP/usage证据，失败保留。不能把未收到usage报告等同上游未计费。当前验收配置使用auto/none tool_choice、不传strict字段；没有分别证明所有其他字段均不兼容。修复源码最初的隔离启动丢了本机代理环境，也失败；仅保留必要代理/TLS环境后通过，没有传模型key到子进程环境或检查点。临时shim启动后自行报ephemeral port，结束后终止自己创建的子进程，未重启现役4323。

同时修复`gateway/kimi-chat-shim.py`：用read1及时转发SSE，不等64KB/EOF；响应头已发后发生错误只关闭，不再追加502；认证读取放在错误边界内，CC Switch数据库以mode=ro打开，错误只输出固定文字和可选数字HTTP状态，不输出原始异常。9项合成loopback测试含旧read实现必须被首帧负例拒绝；测试没有读真实认证或调用模型。源码修复尚未加载到生产进程。

新增`tests/runtime-recovery.test.mjs`及合成fixture，真实杀死自己启动的测试进程后重开FULL/WAL/owned SQLite。stored/current replay的4种组合均实跑；原running变pending，未resume前execute/model计数0。只有safe+safe再次执行，后端稳定effect key使产品子row仍为1；其余3组终态failed/interrupted，保留已提交partial输出，execute计数0。没有重发用户输入或新建请求ID。此为raw公开Harness及合成effect验证，不是PiRuntimeAdapter实际原生派单安全恢复；不提升产品Task completed。

本轮复跑：运行层87/87、权限27/27、控制面21/21、Goal60/60、shim9/9，合计204项自动化均通过。真实模型证据单列，不把该数量当V01–V52完成数。本轮未修改前端或测试真实微信/手机/合盖，未迁移、删除用户数据、提交/推送或重启生产。完整G0/G1/G2、后台ownership、正式provider/fallback、legacy、P3–P7与P6c仍未完成。

最终加强断言：unsafe保留的是tool result正文中的partial，不仅是details里的相同marker；真实查询结果必须能解析出精确task.goal，不能只字符串包含。六文件再次87/87通过；正式`npm run test:runtime-tools-live`对最新源码复测通过，总usage539 token，其余同Submission/零额外调用/产品状态不变断言保持。此前两次536 token记录保留。

官方Worker两个候选任务成功并经父Agent核对实际diff：`1791423454-7d61f2238eb3`（4项工具负例候选）、`1791423777-0db8af78e689`（shim/7项候选）；父Agent补了更严格的EOF证明、数值状态测试和suite恢复检查。恢复写任务`1791424020-4b4cac1eb615`失败且files_changed=[]，由父Agent实现真实4组合测试，没有换provider或重放有副作用任务。阶段独立review不能由这些候选任务自动充当。

追加validation路由job`1791424475-d0bcc595b3f5`返回routed_to_main/Terra，未实际执行Worker测试或产生审查结果；不计独立review。当前接受依据为父Agent源码检查、实际diff与上述测试，完整阶段独立复核仍待验收。

## Paseo 追加选型

用户要求仔细研究 Paseo，已完成[源码调查](../research/paseo-2026-10-07.md)。它优先作为 P4 外部原生 Worker/旧会话通道及 P5 手机客户端的候选，不能凭 README 就替换控制面。

- Paseo 正式版 0.10.3 和主分支 0.11.0-beta.5 分开记录，Antigravity 新集成不能冒充正式版已交付。
- 0.2.2 微信、Task/Grant/Approval/Evidence、Mem0、Outbox 保留。SDK 的 idle 不提升产品 completed。
- Pi Durable 只作为 Chief 持久对话/运行候选，不再重复实现 Paseo Worker 生命周期；同一目标唯一 schedule owner。
- 不默认部署独立 Hub 或 Pi Pocket；不以叠加多个框架替代裁剪。
- Paseo 候选先隔离验证：准确版本、认证/旧会话、消息回执、中文手机端、权限负例与真实中断恢复。安装/启动不能修改全局 skills 或原生配置。

## G0 尚缺证据

尚缺完整私有数据/旧链接盘点、control-plane开机自动加载安装确认、裁剪全量引用图和依赖审计、生产单owner/fence切换及Paseo daemon/原生会话/手机实测。加载来源与隔离owner/fence已有上述证据，不能继续列成从未检查。`config/pruning-manifest.json`已有C01–C15初始精确路径，但不是可删除清单。Pi/Kimi基础及无工具适配canary已通过，不替代G2安全恢复或G4原生Worker验证。继续推进隔离实现；不启动生产迁移或宣布全天可用。
