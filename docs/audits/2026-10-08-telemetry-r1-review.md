# SKEY-F002 遥测返工 r1 复核

日期：2026-10-08。范围是共享工作树中的返工源码，不证明生产进程已更新，不操作真实外部SDK。

## 裁决

**CHANGES_REQUESTED / SKEY-F003**。默认关闭、移除硬编码连接串和不外发原Error正文三项改进限定接受；不能据此关闭完整遥测隐私Finding。

被审文件：`vendor/wechat-acp/src/telemetry/index.ts`，SHA256 `4b2a7abc99469d12e3f04475624c19d4ca5f87e05608f60d31de7469540541da`。新的 `tests/telemetry.test.ts` 共 **11/11通过**，但独立假SDK反例仍复现4条泄漏路径。

## SKEY-F003：合法“token/identifier”形状不等于非秘密

严重性：**Major**，复现于 opt-in 模式；不是已观测到真实API Key外发。默认关闭路径已经被独立探针验证，无SDK初始化和文件写入。

- `TOKEN_RE` 允许1–64字符的字母、数字及 `._/+-`；常见 Google/OpenAI/DeepSeek 账户Key可完全符合此条件。把“语法像标识符”当作“隐私安全”，会让真实凭据通过。
- `coerceProp("token", ...)` 对 `optionValue`、`configId`、`agentPreset` 等直接复制输入。`trackEvent` 的属性名白名单不能证明属性值安全。
- `buildTagOverrides(sessionId)` 以同一正则放行原始 `sessionId`，事件与异常都会携带该tag。即使异常 message/stack已擦除，tag仍可漏秘密。
- `init` 写入 `commonProperties.agentPreset` 及应用version标签时未经受控分类或转换；普通event过滤也管不到这些SDK自动附加字段。

独立探针构造 `sk-` 前缀加重复 `TESTONLY` 的35字符假数据，**没有使用或外发真实密钥**。显式启用只使用假连接串和完整假SDK/fs，观察：

| 检查 | 结果 |
| --- | --- |
| 默认配置关闭 | 通过 |
| 原异常message、stack不再进入SDK | 通过 |
| `command.acp_config.set.optionValue` 原样进入SDK | 复现 |
| event `ai.session.id` tag原样进入SDK | 复现 |
| exception `ai.session.id` tag原样进入SDK | 复现 |
| `commonProperties.agentPreset` 原样进入SDK | 复现 |

## 可立即施工的下一批次

1. 保持默认关闭，不恢复上游硬编码连接串。若产品无需第三方遥测，直接裁剪此可选模块是符合0.3.0设计的方案。
2. 保留时，外发值只能来自固定枚举、有限计数、代码自己计算的哈希或可信版本元数据。不要对任意原文用“64字节合法字符”作安全批准。
3. `agentPreset` 归入已知类别，未知映射 `custom/other`；`optionValue` 不传自由字符串；session tag由代码加盐计算，不直接透传调用者字符串；同时检查commonProperties和context.tags。不能只修事件properties。
4. 对SDK包的全部出口收集完整egress序列化：init commonProperties/context、events、exceptions、tags、flush；对所有可接受字段位置注入synthetic credential、路径、URL和私有自由文本。对合法形状、非合法形状都断言不外发。
5. 复用同一个本地合成负例，证明它在r1会失败、修补后通过。保持11个已有负例，不把事件名/字段名白名单称作全部安全验证。
6. 补 sourceRef、单项与联合测试日志和本Finding回应，提交r2复核。新的源码不继承r1或本轮接受子项之外的安全签字。正常离线源码返工不需要Markus重新作技术决定，生产重启/私有变更/外部消息仍遵守合同。

证据：[独立反例](evidence/2026-10-08-secret-scan/telemetry-r1-probe.mjs)、[观察结果](evidence/2026-10-08-secret-scan/telemetry-r1-probe-results.json)。本轮只是audit反馈，不接管并行同事的实现。
