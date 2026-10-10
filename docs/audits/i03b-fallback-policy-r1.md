# I03b fallback policy r1：CHANGES_REQUESTED

2026-10-08。对象：[交接](../handoffs/i03b-fallback-policy-r1.md)。源码`f8a17519…08e6af`、测试`b113e8ae…645000`。12/12原用例通过，但两组专项缺陷成立。[完整版本/命令/复现](evidence/2026-10-08-round3/README.md)。审查源码、相关原用例与独立负例，未参与实现；库尚未接生产，不声称已重复执行真实任务。

## I03b-FB-F001 — 高 / 阻断：错误种类绕过副作用屏障

定位`fallback-policy.mjs:196–215,254–287`。仅timeout检查hasProducedMessage/hasUsedTools严格false；startup_error/protocol_error/rate_limit不看标记。

复现：三个kind均带`hasProducedMessage=true,hasUsedTools=true`，classify仍eligible，nextAttempt给fallback；protocol_error缺两个标记也eligible。确认的是策略允许不安全重驱，不是已发生真实重复effect。

返工：副作用/不明状态应在所有可降级kind前统一屏障；只有宿主证明未执行/零effects、原预算与原上下文有效时才允许。同名错误可能发生于多轮tool过程，不能只靠kind推断“干净”。auth配置失败/unknown继续拒绝，不能换引擎绕过。

补测：所有eligible kind × 两个标记true/false/missing；工具后protocol/rate_limit、结果不明、真正未开始的startup、auth拒绝、日志与尝试计数。脏/不明路径无新的candidate授权或请求效果。

## I03b-FB-F002 — 中 / 阻断上下文合同：克隆/冻结不完整

定位`:124–155,296–313`。plain-ish判断接受Date/Map等对象，枚举own keys会静默变空对象；结果只Object.freeze顶层和fallback marker，nested内容可改。

复现：原context.sourceTime为Date(1234)，输出为`{}`且不报错；输出turns[0].text可在溯源marker生成后修改，原context不变。Date不属于声称支持的JSON input，本应拒绝而非静默丢；不是证明正常JSON用户记忆已丢。

返工：严格拒非JSON类型/非有限数/不明原型，保护特殊键，深克隆并深冻结或提供immutable snapshot+digest合同；不静默删字段。若允许后续修改，应生成新版本/来源并记录，不保留旧marker装成同一快照。

补测：Date/Map/Set/自定义原型/undefined/NaN、嵌套数组/对象与特殊键；正常JSON全字段/来源保持、输入不改、输出不可在异步候选切换间漂移。

全局一次自动fallback、reset新周期与多候选链只是纯策略；宿主还须绑定原request/Grant/期限/效果账本，不能让模型reset或按新request ID重放unknown。V38/V39与真实Kimi等候选认证/联合上下文仍待验。
