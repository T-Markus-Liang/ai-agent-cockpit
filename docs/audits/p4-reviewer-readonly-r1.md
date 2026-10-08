# P4 reviewer read-only r1 审计

交接：[p4-reviewer-readonly-r1](../handoffs/p4-reviewer-readonly-r1.md)。主审未参与本批实现，反例在自建tmp使用真实macOS Seatbelt与受控Node脚本；无真实Agent、模型或网络，未触生产/用户文件。

## 裁决

**CHANGES_REQUESTED / RO-F001（Major，阻断V25/V27/V28/G4独立验收）。** 角色字段和strip写列表可接受为接线子项，但“真实Reviewer只读”未成立。

问题跨两层：`native-acp-executor.mjs`的`applyReviewerReadonlyConstraint`只清空writeLiterals，却保留workspaceDir；`native-sandbox.mjs`在写权限allow列表里无条件加入workspaceDir的subpath。数组空并不等于系统不给workspace写权限。

独立OS反例调用这两个**真实生产函数**组合：构造reviewer spec、denyNetwork=true、writeLiterals=[]，再经wrapWithSandbox实际启动Node builtin fs写入自建artifact。结果readonly.applied=true、sandboxExit=0，artifact实际改写。它没有替换真实sandbox为spy，也没有启动CLI/App。

现有native-acp-executor套件 **55/55通过**（包含后续切片），但reviewer相关断言检查spec数组/marker而非实际workspace写失败。不能把这些绿测或只读Evidence文案当OS执法。

Source：sandbox `74b155ba49acb3f945d3d03654453a0354ef63e6b72be63c1fade8f1c46de81e`；executor进入当前合成版 `0ebe00c8b39b8a50a824b9dd47e1442dfe3016681487c81a90ee0f9efb80d7a8`，已加入其他scope/占用切片。初始冻结executor曾为`ea3127dd…`，本报告需以再次OS重放及最终sourceRef核对为准，不给所有额外切片签字。

### RO-F001返工合同

1. 将workspace的读权与写权显式区分，Reviewer工作区/工件/固定验收必须在最终Seatbelt规则下不可写；不能只清空一个写列表或把workspace字段删掉导致不可读。
2. 新spec字段必须严格校验、兼容worker已有授权正常路径，不给宽Grant、路径别名或重叠scratch写权限恢复受保护workspace写权。
3. Reviewer可读目标、可输出到受控独立位置；如真实CLI运行必须写私有运行元数据，分离可信宿主分配的scratch/会话目录和只读artifact，而不是放回工作区写权限。
4. 新增真实OS负例：reviewer写现有/新文件、改检查脚本、rename/delete/alias/显式写Grant均失败，原字节不变；读正常；worker获准写正常；无Seatbelt诚实失败，不得fallback裸跑。保留spy测试但不冒充真实执法。
5. 只有OS规则真正生效后才记录“已强制只读”；签字要同artifact/attempt并保持独立身份。交r2附hash、反向负例及原结果；本批源码/隔离返工无需人类另作技术决定。

本发现不证明真实Reviewer已修改过用户工件或伪造过完成；只证明当前宣称的安全边界不成立。生产启动/真实native调用仍按原授权。
