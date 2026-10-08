# 通讯平台兼容性与连接器模板

更新：2026-10-08。当前项目维护并实际运行的通讯入口只有**现有微信通道**。飞书、WhatsApp等是可扩展候选，不是已实现/已验收能力。本轮只整理文档，没有安装SDK、登记bot、读取新平台凭据或发送外部消息。

## 1. 当前兼容表

“未接入”表示Personal AI OS尚无正式平台连接器与验收，不表示平台本身不能开发bot。平台SDK能力不能提升本项目状态。工作目录里的`connectors/`尚未创建，不能把拟议文件当已交付模板。

| 社交/工作平台 | 本项目当前状态 | 建议接入路径（未实施） | 需要单独处理的事项 |
| --- | --- | --- | --- |
| 微信（现有wechat-acp通道） | 已接入0.2.2；本轮状态connected | 保留当前二维码绑定、轮询、持久收件与回复通道，作为首个参考实现 | Pi后台联动未接管；语音仅依赖服务器转写；群聊/附件/已读不作未验承诺 |
| 飞书 / Lark | 未接入；优先候选 | 企业自建应用bot；优先官方SDK长连接/Channel适配，沿用统一Inbox/Outbox | App/租户/权限与identity；国内/国际domain分开；交互审批回调单独验证；不能直接继承微信登录 |
| WhatsApp | 未接入；候选 | 优先WhatsApp Business Platform Cloud API官方bot/HTTPS webhook | 商业账号/号码/权限、验证与签名、消息模板/发送规则、计费、送达回执；不默认接管个人WhatsApp Web |
| Telegram | 未接入；候选 | Bot API；本机优先getUpdates长轮询，webhook作为可选 | bot token、update_id/offset、群组权限/用户绑定；轮询与webhook互斥；断线保留窗口与语音处理需验证 |
| Slack | 未接入；候选 | 官方bot + Socket Mode/Events API | workspace、app/bot权限与身份、event ack/重试、thread和互动审批；仅Incoming Webhook不能代替双向助理 |
| Discord | 未接入；待专项调研 | 官方bot Gateway/Interactions候选 | bot权限、事件/命令、guild/channel/user隔离、限流/回调；语音不自动获得ASR |
| 钉钉 | 未接入；待专项调研 | 官方应用机器人/Stream或事件接口候选 | 企业应用与安装权限、事件确认、身份、消息/卡片回调；仅单向群机器人不能视为双向接入 |
| 企业微信 | 未接入；待专项调研 | 企业应用消息/事件接口候选，不复用个人微信token | corp/app身份、回调加解密/校验、可见范围和审批；群webhook与完整双向应用分开 |
| Microsoft Teams | 未接入；待专项调研 | 官方应用/bot接口候选 | 组织租户、应用注册/管理员权限、对话/卡片权限、回调与部署条件 |
| LINE | 未接入；待专项调研 | 官方Messaging API bot候选 | 账号授权、webhook验证、回复/主动发送规则、媒体权限与地域条件 |
| Signal / iMessage / QQ等个人客户端 | 未接入；暂不承诺默认支持 | 先确认官方/可靠本机接口及账号风险，再决定是否做独立试验 | 不把GUI自动化、扫码外挂或非官方协议视为稳定兼容，不改写个人历史/认证 |

浏览器Cezar/HTTP/MCP属于本机产品与开发接口，不是新的通讯平台。Codex/OpenCode/Devin等属于执行Worker，兼容性另见README Agent表；“多聊天入口”和“多Agent调度”不可混成同一“已连接”指标。

## 2. 从微信复用什么

建议做**薄连接器模板**，不为每个平台复制一份Chief、记忆、调度或目标执行器。微信目前仍有专属bridge逻辑；统一ChannelPort及下面的公共合同是待实现设计，不宣称现成模板已能一键接平台。

```text
微信 / 飞书 / WhatsApp / 其他平台SDK
    → 平台认证、验签与消息规范化（薄适配器）
    → 现有持久Inbox、payloadDigest与唯一request binding
    → 同一产品身份、授权、RuntimePort、记忆与验收
    → 现有持久Outbox
    → 平台发送适配器与实际投递证据
```

| 可复用的产品规则 | 每个平台必须实现/验证的部分 |
| --- | --- |
| 原文先持久化、重复ID去重、正文冲突不静默覆盖 | 平台event/message ID、ack时限、乱序/编辑/重推与游标语义 |
| 稳定Submission/Task/Execution关联；等待与执行分开 | 平台线程/会话引用、连接和状态反馈的展示方式 |
| 同一人格、归档、Mem0及模型fallback上下文 | 平台sender/tenant/account到产品owner的显式配对 |
| 参数digest、有效期、角色与Grant/Approval | 认证/验签、可信sender、卡片回调防伪与防重放 |
| 先保存结果、稳定delivery/clientId与持久补发 | 平台是否支持幂等发送、限流/退避、API接受/送达/已读含义 |
| 本地日志/隐私屏障、取消/暂停与错误可见 | 媒体权限、大小/时效、转写或ASR可用性、凭据撤销 |

不靠昵称或手机号相同自动合并跨平台用户。默认为`platform + tenant/account + nativeUserId`隔离；只有明确验证配对后才复用同一产品owner与记忆命名空间。不能因收到某平台消息就新增工具授权。

## 3. 模板的最小合同与验收

计划中ChannelPort只处理`connect/status`、`normalizeIncoming/ack`、`send/observeDelivery`、`revoke`及媒体能力声明。消息Envelope包含版本、平台/实例引用、原生消息与会话ID、产品身份绑定、正文摘要和必要媒体引用；key/token、二维码登录材料不进入提示、公共日志或Git。

每个平台先完成文本收发与可信用户绑定，再验证审批、状态查询、错误恢复与语音/媒体。缺少转写时明确标记待处理/不支持，不静默丢弃或假装已经理解语音。应用支持音频文件不等于项目已经接入中文ASR。

最小验收：

- 认证失败/撤销/陌生用户/错租户拒绝，群成员不能获得owner权限。
- 重复事件执行一次；同ID变更正文需要明确冲突/修订，不新造请求绕过。
- 收件先落盘再ack，SDK回调先短确认，不等待长Agent任务。
- 接收、派发、保存结果、发送四个崩溃边界可核对；补发不重新运行Agent。
- 父等待/平台断线不误取消后台；取消指向明确对象并受原授权约束。
- Outbox发送限流/断网恢复有界；平台不支持发送幂等时保留不明结果，不承诺exactly-once。
- 审批回调绑定可信身份、action/target/digest/有效期，旧按钮不能自动放行。
- 完成、API接受、平台送达和已读分别记状态，只宣称收到的证据。

这份列表是后续连接器验收子矩阵，不替代现有V01–V52，也不把全部候选平台加入0.3.0核心发布承诺。

## 4. 建议顺序与边界

先完成微信→新Runtime→持久Outbox的核心链路，再抽公共合同；随后优先飞书/Lark文本bot，验证模板确实能迁移。WhatsApp可作为下一独立工作包，先确认官方账号与HTTPS webhook部署条件。Telegram/Slack可提供无需本机公网入站端口的候选；其他平台先做专项调查。

SDK让收发“接起来”更容易，但登录、用户授权、群权限、审批防伪、可靠补发与平台消息政策不能只靠复制模板。新应用创建、账号授权、公网webhook/隧道、计费服务与真实外发都需具体范围；本轮未执行这些操作。

## 5. 本轮核对的官方依据

- [飞书/Lark官方Node SDK](https://github.com/larksuite/node-sdk)：已有WSClient和Channel，长连接可在本机接收事件而无需公网入站地址；实际采用前锁定SDK版本、应用类型和权限，卡片回调另验。
- [Slack官方Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)：WebSocket接收Events/互动，不需要公开HTTP Request URL；仍须app/bot授权。
- [Telegram官方Bot API](https://core.telegram.org/bots/api#getting-updates)：getUpdates与webhook互斥，使用update_id/offset核对重复；服务器队列保留有限，不能代替本地持久Inbox。
- [Meta官方WhatsApp示例](https://github.com/fbsamples/whatsapp-api-examples)、[Meta官方Postman webhook订阅](https://www.postman.com/meta/whatsapp-business-platform/folder/ozgs3jn/webhook-subscriptions)：官方Cloud API与webhook接入路径。Meta开发者详情页本轮未能读取，因此不在此写未经核实的具体费用/窗口/配额承诺。

Discord/钉钉/企业微信/Teams/LINE/个人客户端行仅登记候选方向，本轮没有逐个平台完成SDK/账号/策略调查或功能测试。
