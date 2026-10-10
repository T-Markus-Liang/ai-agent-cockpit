# 第三轮审计证据

2026-10-08。固定根`/tmp/personal-ai-os-review-round3.ClxFrw/input`，43个批次/依赖/交接文件见[source-ref](source-ref.sha256)。捕获前后和副本一致，15:59:22的[live-check](live-check.sha256)也一致。随后本地分支变为`feat/0.3.0-progress`、HEAD c9e09b69d2ea11fdcd86f36df83b877f890e1d84；结论按文件hash而非只按旧e8c4317基线。code r2只指ownership返工，其他7个新模块仍r1。

## 实际复测与范围

| 组 | 已确认结果 | 原输出 |
| --- | --- | --- |
| resolver/context/fallback/budget | 46/46，exit0 | [policy](policy-suite.log) |
| route/route-store | 22/22，exit0 | [route](route-suite.log) |
| ownership r2及合同/恢复/owner/tools | 72/72，exit0 | [ownership](ownership-suite.log) |
| native结构精确筛选 | 7/7，exit0 | [native](native-structural-suite.log) |

147是**选定原套件的实跑数**，不是全部最新测试数、唯一历史case数或V01–V52完成数。原native13项未称全部复测通过。未复测M01/其他四份r2、真实SDK删除、真实模型/CLI/微信/24h。

Node24、pi1.0.4与现有lock；无安装/脚本生命周期。常规套件和policy/route/ownership探针用`env -i`、私有TMPDIR，OS profile为：

```lisp
(version 1)(allow default)(deny network*)
(deny file-write* (subpath "/Users/markus"))
(deny file-read* (subpath "/Users/markus"))
```

命令采用`/usr/bin/sandbox-exec -p <profile> /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin TMPDIR=<round3>/suite-tmp /usr/local/bin/node --test <frozen absolute test paths>`。四组名称/退出码在原输出；native结构筛选pattern为`^(buildSandboxProfile|DEFAULT_DENY_READ_SUBPATHS|spec validation|quotes and|wrapWithSandbox|sandboxEnv|assertSandboxAvailable)`。

## 失败不隐藏

- [第一回导入缺依赖](ownership-suite-missing-deps-1.log)、[第二回缺canary依赖](ownership-suite-missing-deps-2.log)来自审计副本组装，不是peer代码bug。补齐native-acp、executor、adapter/canary源码并逐文件校验后72项通过；全部失败保留，不计成功。
- [原native套件嵌套失败](native-nested-failure.log)：外层Seatbelt不允许再次sandbox_apply；network listen在外层被EPERM阻断。负pattern没有将该case排除；未连接既有4324。不能把这次9个表面pass的deny当作被审profile执法证据。
- 4324预检发现已有listener，因此另用**自建**回环端口0+随机nonce，而不是借生产服务或外来listener。

## 主审专项探针

[policy](policy-probes.mjs)、[route](route-probes.mjs)、[ownership r2](ownership-r2-probes.mjs)、[native](native-probes.mjs)与[实际JSON](probe-results.json)。前3脚本使用上述OS隔离；native驱动**未再包外层Seatbelt**，因OS不允许嵌套，改为只在受测child应用profile。父驱动源码已读审、env-i、仅临时夹具/系统binary；没有读取用户私有文件/钥匙串或连接现役应用。

native实际运行：echo/cat/sh/curl，stdout只合成字符串或nonce；创建自有private/tmp与`/var/tmp/personal-ai-os-audit-native-*`夹具；仅自身随机端口HTTP；curl以-q禁用用户curlrc并noproxy，允许/拒绝请求与nonce比对。所有自建server/夹具均清理，不删除用户数据。不同于真实CLI/Agent接线，也不是整个父进程受OS文件隔离。

5个代码Finding：dirty fallback、context clone/freeze、异常clock预算、task intent冲突/重复恢复、写失败/重载失败ghost成功。其他实际观察分为设计/接线缺口（总上下文、未知DB bootstrap、未列private temp树）与非阻断Boolean配置建议，不为凑数一律叫新生产bug。源码均尚未接管生产；探针exit0表示当前缺陷/限制成立，不是修复通过。

ownership镜像证明新admission F003子项关闭；F001/F002仅状态/返回值诚实，仍stalled/无法精确取消。已有限定进展，不标完整G2/G3通过。

## 并行与独立性

主审未参与这次新模块/r2返工，只对peer delta作独立实质review；历史共享工具/helper不自签全部独立发布验收。Official DeepSeek异步读取独立staging3个policy源码，主审同时复测/看其他组。

[Worker](worker-result.json) job `1791443295-4592018fca03`，官方doctor核验`deepseek-flash`→`DeepSeek-V4.1-Flash`，success/files_changed=[]/tests=[]；实际4文件与[Worker hash](worker-source-ref.sha256)前后相同、没有额外文件。它只定位代码，不做测试或工程/发布签字。没有切全局provider、第三方fallback、原生失败Reviewer重试或虚称Terra。usage原样留存，不相加推断费用。

辅助模型外呼与本地faux/零真实应用模型分开。没有生产数据迁移、chmod、旧事实外呼、真实历史load/prompt、微信发送、服务重启、Git commit/push或GitHub review提交。本线程实现Goal仍paused。固定副本保留；hash不能重建丢失源码，执行方覆盖旧revision前需保存真正commit/归档。

补充Jev措辞检查：读实时官方llms/Noul，wrapper调用只含合成授权/完成范围，[输入](jev-wording-input.json)/[结果](jev-wording-result.json)。jev-1.13.0，限定草稿越界概率0.10、夸大对照0.98，input759/output44，745.19ms。概率不作工程、法律或授权决定，无阈值动作/用户原文/key。
