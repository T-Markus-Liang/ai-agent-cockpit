# API Key 专项审计与执行交接

日期：2026-10-08，Asia/Shanghai。项目名 `personal-ai-os`，本机目录仍为 `ai-agent-cockpit`。本轮是审计及测试样例清理，不恢复实现 Goal，不操作生产服务。

## 结论

本次扫描没有确认真实账户 API Key 在项目源码、可达公开 Git 历史或已扫描本地日志中泄漏。用户指出的 `vendor/cezar/packages/cezar/src/core/secret-redaction.test.ts:66` 确实含有完整 Google Key 形状，且 GitHub secret scanning 告警 #1 仍 open；但其值与公开上游的人工合成测试样例完全一致，可由固定前缀、连续数字及连续字母构造，不是从本机凭据读取的值。

这不是整套系统安全签字：**SKEY-F002：微信连接器默认遥测将异常原样交给第三方 SDK，潜在密钥外发通道尚未修复。** 静态扫描未发现真实密钥，不能证明运行中所有异常都安全。

## 扫描范围及证据

最终冻结工作树基于 `19e4e274a9306aa3fee0515b86ac22c90e8ca7d7`，包含并行执行方当时未提交的源码。复制后逐文件复核，无漂移；结论仅绑定该快照，不覆盖之后的修改。

| 范围 | 方法 | 结果 |
| --- | --- | --- |
| 当前可提交源码 | 1,747 个 tracked/untracked 非 ignored 文件，27,053,616 bytes；无跳过文件 | Gitleaks 原始命中 6→4；目标测试文件 2→0 |
| 公开 Git 历史 | 从 GitHub 只读创建独立 mirror；110 commits、2,099 blobs、32,980,928 bytes | 检查分支、3 个标签、PR #1 head/merge；原始命中 6，逐项分类 |
| Git 暂存差异 | `gitleaks git --pre-commit --staged`，当时 index 干净 | 0；这只是暂存差异，不冒充完整 index 扫描，HEAD 内容已由历史扫描覆盖 |
| 本地日志及项目状态 | 22 个 ignored 本地文件、6,091,155 bytes | 模式与已加载凭据值均无泄漏命中；合法私有 launch-key 存储不算日志泄漏 |
| 本机凭据对照 | 凭据只在本机内存读取；12 个唯一 secret-like 值，排除扫描器自己的非凭据选项 | 当前源码、可达历史及日志均无完整值命中；不打印值或真实凭据指纹 |

使用 Gitleaks **8.30.1**，Darwin arm64 发布归档 SHA256 已对照官方 release digest 校验。未安装全局工具，未改变用户配置。使用默认检测规则，忽略 `gitleaks:allow` 注释，不使用 baseline 或仓库忽略项；递归解码深度 5、归档深度 3。另用本地确定性扫描交叉检查凭据赋值、Google/GitHub/OpenAI/Anthropic/AWS/TypeSafe/GitLab/Slack/JWT/private-key 形状及所有可达 blob。

范围限制：不扫描 Keychain、所有本机 App 数据库、node_modules 或虚拟环境，不验证真实密钥有效性，不向供应商发送疑似密钥，不穷尽无限层加密/编码，不保证扫描时点后新代码安全。未读取旧对话或发送微信。原始疑似值未提交给任何外部模型；Jev 只接收去值的分类描述，结果仅作 advisory，不作为安全批准。

## SKEY-F001：上游测试假密钥导致公开告警

状态：**样例清理完成；并行执行方已把修补提交到公开功能分支；告警处置尚未完成。**

18:26只读复核：远端feature分支含syntheticToken构造、不含旧Google假样例，文件SHA256为`a1ba5dde0df2ab9f5a440f30509c6ddefb621006bd93c19e7a09ae5647b06a84`。审计线程没有提交或推送；本地仅再去掉一个EOF空行并复跑188项测试。公开历史中的旧合成样例仍存在。

- 原始文件与 `open-mercato/cezar` 上游 blob `8986db859911b8b6c524feb3432c9a760752002a` 完全一致。
- 假样例指纹 `0c5019b6e84a` 对应 GitHub alert #1，位置为提交 `88aeae65b7cc3eb01b0c81bb23a881fdc38536fc` 的第66行。
- GitHub 返回 `state=open`、`validity=unknown`、`publicly_leaked=true`。后者表示字符串已进入公开提交，不表示它通过了真实账户有效性验证。**未擅自关闭告警。**
- 现测试使用 `syntheticToken(prefix, bodyLength)`，仅重复显式 `TESTONLY` 字符构造测试假数据，保留各格式长度和字符集。没有把旧值拆开、编码或埋进忽略清单。
- 保留原有行为覆盖，并增加14种格式的精确替换及重复出现测试。Google、GitHub、Anthropic 等测试值不从环境或个人配置读取。
- `npm test -- <4个相关测试文件>`：**4 files / 188 tests passed**，Vitest 4.1.10；`npm run typecheck:server`：exit 0。
- 目标测试文件 Gitleaks exit 0、0 findings。整个工作树仍有4条原始命中，不能把它报告成“Gitleaks全绿”。

这次没有发现需要吊销的真实账户密钥。不因已确认的合成样例强制重写公共历史，也不擅自 force push。正常公开修补已由并行执行方完成；将 alert #1 标记为 false positive 是独立的外部写操作，仍按既有授权处理。本审计没有提交、推送或操作远端告警。

## 剩余检测命中复核

| 位置 | 分类与依据 | 处置 |
| --- | --- | --- |
| `tests/execution-ownership.test.mjs:73` | 结构化 ownership 身份键断言，不是认证凭据 | 不删除身份断言，不全目录豁免 |
| `tests/kimi_shim_test.py:246` | 离线 mock 故障中故意注入的异常标记，验证上游错误不外泄 | 保留负例；可另改成明确 synthetic 生成样例 |
| `vendor/cezar/packages/cezar/src/core/agent-env.test.ts:21` | 本地构造的 Stripe 测试样例，验证 child env 剥离 | 保留安全测试；另批改成显式 TESTONLY 构造 |
| `vendor/wechat-acp/src/telemetry/index.ts:22` | Azure Application Insights 采集标识/连接串，不是用户模型账户 API Key | 不称为“账户密钥泄漏”；默认外发和裸异常问题按 SKEY-F002 返工 |

自定义扫描另核实了历史 `config/opencode-fallback-kimi.json` 的13字符值：它是 CC Switch 管理反代使用的公开占位标记，非当前凭据；不能仅因 URL 是 localhost 就自动当作安全。其他额外命中为合成测试材料、上下文标记、文件名及配置说明，未发现真实凭据值。

Azure 官方说明：[Connection strings in Application Insights](https://learn.microsoft.com/en-us/azure/azure-monitor/app/connection-strings) 明确指出 instrumentation identifiers 不是 security tokens/security keys。这个分类**不豁免**遥测隐私与错误正文外发风险。

## SKEY-F002：第三方遥测裸异常外发通道

严重性：**Major / CHANGES_REQUESTED**。绑定 telemetry 源码 SHA256 `fccfc087f2f15d402bbf38ca311b65cbf5224bb39a3cce7cb9400472e4f6133a`。

源码默认未设置 `WECHAT_ACP_TELEMETRY` 时会初始化外部 SDK；`trackException` 把原始 `Error`（或 `String(err)` 构成的新错误）传给 SDK，未剥离 message/stack。若 SDK 启用且错误含 key、token、请求头或私人 URL，可能外发。即使实际 Application Insights 安装/网络不可用而碰巧没有外发，也不构成源码的安全保证。

独立探针使用 Node 24 的类型擦除和 VM，所有 SDK 与文件系统均为假实现，没有真实网络及文件写入。观察：

- 默认环境：SDK 启动1次；synthetic error canary 原样出现在 `trackException` 参数；传入的仍是原 `Error` 对象。
- `WECHAT_ACP_TELEMETRY=0`：SDK 启动0次、文件系统操作0次、异常外发0次。

未验证生产进程环境，**不声称真实用户密钥已经通过遥测外发**；本轮未改生产配置或重启服务。

### 执行方下一安全批次（无需 Markus 代做技术裁决）

1. 默认禁用第三方遥测；没有明确 opt-in 与私有连接串时，不加载 SDK、不生成安装ID、不提交任何事件。删除上游硬编码连接串，不让默认安装向原作者资源发数据。
2. 若保留异常遥测，只发送经过固定 allowlist 的类别/错误码；不发送任意 Error.message/stack/cause、请求正文、headers 或任意 properties。不要仅依赖几条 token 正则处理所有错误正文。
3. 新增或变更 env 时同步 `.env.example` 及配置说明；不给浏览器传连接串或真实凭据。也可按0.3.0裁剪设计彻底移除此非必要模块，但需更新所有调用点及依赖清单。
4. 增加假 SDK 负例：缺省配置、明确关闭、缺连接串、启用失败、Error/string/nested cause 中的 synthetic credential、重复初始化、关闭后的调用。证明不外发正文和秘密，不连接真实遥测端点。
5. 保留密钥形状的功能测试；新增泄漏扫描门槛，不全量忽略 tests/vendor/docs。历史合成样例如需去误报，使用精确、可审计的独立 disposition，真实/未知新增命中必须失败。
6. 提交 sourceRef、离线原始日志及 SKEY-F002 回答，审计复核后才关闭 Finding。源码返工不必等许可、私有 chmod 或生产迁移批准；真实重启/切换、改私有权限及远端写操作仍遵守既有合同。

证据：[scope-and-results.json](evidence/2026-10-08-secret-scan/scope-and-results.json)、[探针与命令](evidence/2026-10-08-secret-scan/README.md)。已通过的样例测试不关闭 SKEY-F002，也不替代0.3.0发布验收。
