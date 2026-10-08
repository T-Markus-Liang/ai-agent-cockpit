# Paseo许可与权限的只读补证

2026-10-08。本报告仅事实/建议，不改项目许可证、生产mode或替用户批准发布。

## 许可：元数据空白不等于不存在条款

安装的@getpaseo/client/protocol/relay均0.10.3，package/lock无license，包无LICENSE文件，此事实属实。但已完整读取[getpaseo/paseo主仓LICENSE](https://github.com/getpaseo/paseo/blob/main/LICENSE)，明确“除所列第三方组件，Paseo按Apache License 2.0许可”，不是无条款。

固定v0.10.3 tree的LICENSE Git blob为2f5903143b08de0aa991ab535d9582aca6b9b44a，与已读main LICENSE相同；同tag下packages/client/protocol/relay的name/version与安装三包相同，仍未写license字段。[固定tag许可blob](evidence/2026-10-08-round3/paseo-v0103-license-blob.json)、[固定tag三包元数据](evidence/2026-10-08-round3/paseo-v0103-package-metadata.jsonl)。

建议先补发布产物来源/完整性与源包覆盖、第三方例外/NOTICE，再将“未声明元数据”登记为有对应上游条款证据；不要让Markus现在盲选“接受无许可风险”，也不要擅自在第三方package写license冒充上游。没有作法律保证或关闭完整G0，CVE/telemetry/install scripts等仍另审。源码隔离返工不依赖现在改变项目许可证。

## 私有权限：只stat，没读取token内容

[精确metadata](evidence/2026-10-08-round3/permission-stat.txt)。交接的“6处”含目录、子文件/日志范围，不能据数量递归chmod，也不动外部cc-switch库。若人类批准，只针对列出的普通文件/owner和目录确定性收紧，并保留原mode/ACL恢复记录；不得迁移、改数据或顺带重启。

0600/0700是最小保护，仍不能隔离同UID的所有AI应用；实际风险同时取决父目录遍历、ACL与OS/Grant边界。权限硬化与M01原文外呼/cutover是独立决定，不能打包成一项不透明批准。

这次stat显示cezar-codex实例目录已是0700，因此仅token文件0644不能直接推出其他UID能经正常路径读取；未检查ACL，不作全面暴露面保证。建议仍精确收紧token文件，但不夸大为已观察到泄露。

## 当前PR事实

只读核对[PR #1](https://github.com/T-Markus-Liang/personal-ai-os/pull/1)：OPEN，head c9e09b69d2ea11fdcd86f36df83b877f890e1d84，与本地feat/0.3.0-progress一致；GitHub API此时commitCount=25（转述24是旧计数），reviewDecision为空。没有代提交review/批准/合并/push。新审核在本地共享docs/audits，执行方可先读它们返工，不必等线上review绿灯才能做代码修复。
