# 0.3.0 重启、真实测试与日常使用准入审计 r1

## 结论

**CHANGES_REQUESTED：目前不宜整套重启生产加载最新源码。** 可以继续隔离测试和安全源码返工；关闭下列阻断项并通过灰度准入后，再按获批范围重启、做真实微信/Worker测试。正式日常使用要等真实闭环、回退、裁剪与24小时等发布验收，不把“能启动”当作升级完成。

正确顺序是：候选代码完成 → 安全/数据准入 → 受控重启或隔离真实测试 → 真实闭环及耐久验收 → 正式发布/日常使用。不能要求先做完24h才允许第一次真实测试，也不能把第一次真实测试当作已经发布。

## 审计身份、来源与范围

- 审计者：本监督线程主Agent；未参与本轮Goal鉴权/authority loader及遥测返工实现。只写审计报告/证据，不代修功能，不恢复本线程实现Goal。
- 源码与现场最终核对：2026-10-08 19:43 Asia/Shanghai，HEAD `a9747bd185897504a4c63b96eebec6407d1b2a17`，当时工作树干净。此前读取从 `3eb1bb8` 开始，期间并行执行方新增 `/acp-more`、Submission登记等批次；不是整个工作树都被固定不变。
- 缺陷复现绑定下列完整SHA256，复现前后关键文件一致；其他批次/WIP不继承本报告接受结论。

| 文件 | SHA256 |
| --- | --- |
| `gateway/goals.mjs` | `cf10b8007fd37196f89d2ad73ca89996a68bc765cd546142408ae082226ab086` |
| `control-plane/request-authority.mjs` | `a96954507408a6704cd26f31c470f2eb4274c6a15df5dc2744cae6c37d24f997` |
| `control-plane/goal-client.mjs` | `d24d895a3c8dc79f7e7c8d758b704270ed1a77a93157e264ef220f349423f4ba` |
| `services/memory/service.py` | `87bffe307d5765256ef2f899532ae2f65d89a6dc1bb81758f466d9de11fb85cb` |
| `config/runtime-versions.json` | `bb02397f71f208a4185146de0f77c143d48335fa44c21b6197d81a92c935926b` |
| 遥测当前合成版本 `vendor/wechat-acp/src/telemetry/index.ts` | `c6553c4f72d392f8a39c8a5a5dc8979ec79d764a88d140462003df5c2dc71ac3` |
| `vendor/wechat-acp/tests/telemetry.test.ts` | `b3f1f0fc9868714c89fce97dc22d7bdc59cded45a1214fd334dd17b937595c48` |

读过：Goal/请求鉴权/客户端、新记忆迁移与召回过滤、运行版本配置、native executor入口、微信`/acp-more`、遥测、相关测试、Goal合同/台账/验证/裁剪/协作文件与交接。没有逐项审结18份待审交接，没有做全仓回归、真实Agent派单、真实微信外发、浏览器/手机、24h或实际回退。

生产核对仅GET健康、launchctl/ps/stat元数据和SQLite只读schema/聚合；不读真实对话正文，不运行MemoryService初始化，不改生产DB/凭据/权限/配置，不重启服务。两个缺陷探针只使用自建tmp、合成token和假Goal/runtime。

## 现场事实

- 微信接口HTTP200、connected；Goal HTTP200、版本0.2.2、active=0；控制面及Mem0健康200。Mem0的2.2.1是依赖版本，不是产品已升0.3.0。
- 产品package仍0.2.2，`defaultRuntime=legacy`、`pi.productionEnabled=false`。健康200不证明新运行层、角色与迁移已加载。
- 活跃进程核对中，Goal/control-plane/bridge自10月7日运行，Memory自10月6日运行。本轮没有让它们加载新代码。Goal active=0不等于所有Native进程或待发Outbox都为空，切换前仍须重新盘点。
- `/Users/markus/.local/state/personal-ai-os/goals/authority.json`不存在；现役`api-token`仍存在0600，微信配置及`goal-client.mjs`仍引用旧token文件。正常签发/映射/权限验证未做部署闭环。
- 现役Mem0 `turns`仍只有旧8列，没有`validation_status/plan/quality`等新字段；只读聚合是113条done回执。113不是独立用户事实数，不读取payload来猜新事实数量。
- 微信token.json仍0644；这是已列出的权限收紧待办，本轮未chmod，不据此声称凭据已经被别人读取。
- 最新执行检查点列18份交接待审；明确生产未重启，原生真实Worker/迁移/发布仍未做。已交付的Submission登记等源码不因旧readiness地图而被抹掉，但交接也不是整链验收。

## Findings 与执行方返工条件

| ID | 严重度/门槛 | 证据及影响 | 下一动作与验收 |
| --- | --- | --- | --- |
| RR-F001 | 部署阻断；Goal新版准入 | `goals.mjs:25`总是消费authority.json；实际文件缺失。隔离测试证明health可200而业务请求500 AUTH_CONFIGURATION | 完成私有principal签发/原子导出、角色/撤销/过期验证与微信/UI/CLI客户端映射；在独立实例证明健康与真实业务都成功。没有匹配生产授权不写现役authority文件 |
| RR-F002 | 数据/迁移阻断；新Mem0准入 | `service.py:404–426`启动会扩schema，把旧done分类legacy_unverified；召回要求validated。现役113旧回执无这些字段，直接重启可能失去旧事实召回 | 源只读、一致性backup含WAL、副本转换/重验证、召回与来源/忘记守恒、失败回退；不能仅批量改validated或直接cp活跃主库。真实旧原文外呼与生产迁回分别批准 |
| RR-F003 | Major；Goal权限与G4准入 | `goals.mjs:65–78`只检查authenticated，不检查principal.role；actor来自请求头并缺省local。合成viewer对POST pause-all返回200且调用fake controlAll一次，省略或显式local都可越权 | Goal路由显式按角色/动作/资源授权；viewer只读；grant等高风险动作绑定可信操作者，不能凭X-Goal-Actor=local获得权限。补全角色×所有写路由负例，以及合法operator/微信owner的正常路径；交r2。不假称已复现所有grant路线，本轮实际复现pause-all |
| RR-F004 | Major；共享authority生命周期与G2/G4准入 | `request-authority.mjs:120`命中缓存就返回，先于121行mode/uid/type检查。合成600→644保持ino/mtime/size不变，仍认证成功而非AUTH_CONFIGURATION | 每次同fd安全元数据检查必须前置于cache返回；缓存不免除mode/uid/type/size验证。补仅chmod无内容变化、危险权限下首次/缓存认证、恢复安全权限、轮换/吊销/过期/删除/符号链接负例；交r2，不能回落旧缓存 |

RR-F003/RR-F004属于既有源码/隔离返工授权范围，**执行方可立即做，不需要Markus代做技术选择**。本线程不代修。RR-F001/RR-F002的生产落盘/原文外呼/切换则仍按具体授权处理；不是所有源码都等待人类决定。

## 本轮验证与限定接受

1. `node --test tests/goal-per-client-token.test.mjs`（根目录）：6/6通过；其缺文件场景明确断言业务500、health200。这不覆盖viewer写权限及缓存chmod漂移；独立反例正是补这两项。
2. `node --import tsx/esm --test tests/telemetry.test.ts`（`vendor/wechat-acp`）：14/14通过。曾在仓库根误指vendor测试路径导致文件不存在，已纠正cwd单独成功；不计为产品失败或完整回归。
3. 独立重放此前SKEY-F003四条canary：当前源码默认关闭true，原Error正文/stack不再外发，event属性、event tag、exception tag、commonProperties旧四条泄漏观察均false。**原四条路径限定接受/关闭于本sourceRef**；不自动接受所有SDK行为、元数据来源、整个P0或生产部署。
4. RR-F003、RR-F004再次独立复现，均仅tmp/fake，productionWrites=0、modelCalls=0。未触真实Goal、真实auth文件或消息。
5. 官方DeepSeek V4.1 Flash只读对照8份暂存公开计划/交接；job `1791456810-ca4bceb30e6c`成功，暂存文件哈希未变。仅文档对照，不是真实产品Worker测试/源码独立发布签字。前一次`1791456618-8f4569b19c3b`结构不合格未采纳，同官方路由仅有界重试一次。

本轮20条选定既有测试通过不能当作52项验收、全部联合测试或整版本完成。

## 下一阶段的最小施工与放行顺序

### A. 当前可继续：源码/fake与隔离副本

先返工RR-F003/004，固定sourceRef复核；并行完成当前M01/M02依赖审计、统一身份/预算/所有权与微信后台闭环。`/acp-more`与Submission登记是新交付，应按各自交接审，而不是继续引用旧地图说它们完全未实现。

新实例用独立端口/状态目录、合成数据或经允许的一致性副本，不连接生产DB，不消费真实微信游标。不运行两个相同微信token的poller，不启动第二个生产owner。未授权的真实模型/native/消息外发仍不做。

### B. 第一次受控真实测试准入（不是正式发布）

- 已关闭本批与被测链条的安全/数据阻断项，候选构件、依赖、客户端与启动参数版本一致；先在隔离实例确认身份/权限、业务API、后台生命周期及恢复。
- 明确测试账号/命名空间、专用合成Native会话、白名单任务、预算/期限、允许读写/外发范围与操作者；至少两条目标Worker通道逐一测认证、load/prompt、取消/并发，失败不偷偷另建旧会话。
- 若切现役微信或Memory，完成一致备份、待办/未发正文/clientId/活动Native盘点、单owner与停写/回退演练、旧记忆副本准入和私有凭据映射。新的测试命名空间可先验，不因等待43旧事实外呼而停止所有安全试验；不能把新命名空间试验当旧记忆迁移已完成。
- 获得对应真实调用/重启/生产范围确认后，按模块依赖做小范围canary并核对新PID/构件和实际加载；不一键全重启或用健康200验收。

**第一次灰度不必已通过24h和全部发布项。** 但不可绕过角色/数据/单owner等被测路径的安全准入，不能拿新白名单/新request ID重放uncertain旧任务。

### C. 正式日常使用与0.3.0完成

真实微信文字/语音→后台执行→固定验收/独立review→Outbox通知闭环；超时、崩溃、不明副作用、补发不重复执行；主模型/fallback有完整或压缩上下文与记忆；至少两个真实Worker及中文实页/手机抽验；迁移与回退、命名批次2、C01–C15/G5c裁剪；真实24h合盖/电源/网络/期限/补发。按G0–G6含G5c及52项适用条目签收，之后获批发布并验证构件加载。

这些是已有合同门槛，不新增验收数量、不冻结执行Goal，也不把审计文档当Grant/Approval。本轮**没有重启/迁移/外发/裁剪/推送**。共享交接不等于外部App已收到消息。

证据入口：[只读现场、反例、测试与sourceRef](evidence/2026-10-08-restart-review/README.md)。
