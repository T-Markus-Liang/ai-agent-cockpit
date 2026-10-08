# M02 goals 角色授权 r1 审计

审计范围：回应RR-F003；本监督线程未参与本批功能实现，不重启生产。交接：[m02-goals-role-authz-r1](../handoffs/m02-goals-role-authz-r1.md)。

## 裁决

**COMPONENT_ACCEPTED（角色×现有路由范围）；RR-F003关闭。** 不表示Goal身份生产配置已就绪，也不是整个G4通过。

绑定 `gateway/goals.mjs` SHA256 `3f4521ab0dd9a760827817cf68abf6b3b05f50e630c7f298d48d96390cf2ce39`；新测试 `8192c1dbc2c661472798ae432b11383c36e991e23d069a2db6bdf1ba718c3eb4`。消费的request-authority为当前合成版本 `6e602a674a5ace9b3443dc0901f948c15662d6c654fe5823e9b83d636de8844d`，包含其他native输入切片，不继承这些额外变更的审结。

主审读了角色矩阵、实际处理器及测试，检查授权在认证后、actor头/存储效果前执行；现有写路由均被识别，不在矩阵的路径亦未见能落到已存在写操作的绕行。

同一原审计HTTP探针重新执行：viewer不带actor头或声称local均403，fake controlAll调用0次。原越权200/1不再复现。角色矩阵、每客户端token、request-authority及identity-pairing四文件联跑 **45/45通过**，含viewer九条写路由、chief不能grant/全局暂停、operator正常路径及合成Wechat owner路径。不是全部Goal/版本用例数。

技术裁决：grant和全局pause/resume仅operator；viewer只读。coordinator的wake是既有授权工作调度提示，不授予新Grant；chief对单Goal的管理不能通过resume扩大原期限，已读GoalStore.control的原Grant检查。接受此次保留有限动作矩阵，不要求为关闭本缺陷重建统一IAM框架。

仍未签字：不同入口矩阵统一、真实Wechat owner/客户端的配对和归属、生产authority.json签发/映射、批准者审计身份细化和真实部署。actor头不再提升角色，但保留旧owner/approvedBy语义；本报告不把它当可信主体ID的完整绑定证明。RR-F001及原生产准入限制仍在。

执行方可继续依赖角色拒绝语义的隔离接线；生产配置/服务切换仍需原授权。证据见[本轮目录](evidence/2026-10-08-followup/README.md)。
