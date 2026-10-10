# M02 ContextAssembler r1：EVIDENCE_REQUIRED

2026-10-08。对象：[交接](../handoffs/m02-context-assembler-r1.md)。源码`46292658…d944ad`、测试`f5bec859…9f6654`，9/9原用例通过。[第三轮证据](evidence/2026-10-08-round3/README.md)。主审未实现本模块。

局部格式正例成立：单kind块、单summary槽、顺序、最旧turn裁减、单text截断和source字符串传递。**不接受完整“统一、有界、带隐私来源”的上下文能力**；库尚未接桥/runtime，不把后续缺口伪称现役微信故障。

## M02-CA-E001 — 高 / 接线阻断：局部text限额不等于总上下文预算

定位`context-assembler.mjs:96–105,170–177`。facts条数无上限，source/role/request-link无独立长度或token预算；factChars只限制每条fact.text。

复现：64条fact，text各1024/source各2048字符，都低于text限额；facts块输出196991字符，meta.truncated为空。没有违反每条text截断规则，但不能作为各block/整prompt预算已受控证据。

补证/设计：宿主或本层须有按模型与原Grant派生的总token/字符预算、facts数量/来源引用上界、明确drop/压缩清单。来源保留结构化event/digest/span引用，不把巨大source全文当metadata绕过预算；限额验证floor后不得无意变0。不能以纯前缀截断宣称关键事实全部保留。

真实privacy/质量筛选必须在宿主绑定user/source/epoch之后，统一compaction来源，避免旧摘要+Pi摘要两次注入。当前仅string source与计数，未证明V34/V39/C06/C48全链。允许继续布局/装配源码，但正式接线以全局预算、隐私和多模型完整/压缩上下文负例为门槛。
