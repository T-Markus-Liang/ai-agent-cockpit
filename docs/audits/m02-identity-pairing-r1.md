# M02 identity pairing r1：限定COMPONENT_ACCEPTED

第二轮审计，2026-10-08。对象：[执行交接](../handoffs/m02-identity-pairing-r1.md)。本批新pairing模块主审未参与实现；共享request-authority只核对接口，不对其全部历史逻辑自签独立验收。

结论：**COMPONENT_ACCEPTED，仅纯内存配对核心和直接authenticate生命周期**。导出到HTTP后的持续撤销/过期为**EVIDENCE_REQUIRED**；不接受完整身份接线，不把已披露缺口假装新增隐蔽漏洞，也不标V26/V42/G2/全产品已通过。

## 接受的精确范围

- 受信宿主已经验证role/admin操作与时钟/random来源的前提下：短期配对code单次消费、直接authenticate、rotate/revoke/expiry、既有toJSON/fromJSON结构校验、明文code/token不留snapshot，以及一个有效principal的request-authority形状兼容。
- 接受的是代码组件，不是让模型自行beginPairing(operator)、批准高风险动作、对外暴露配对API或证明磁盘持久化/多进程安全。未连接真实客户端/生产；pending code不持久、rotate不续原expiry的已披露选择本轮不要求返工。
- base HEAD `e8c4317201d70e75cabe279da5e7736a9aab20a0`；源码 `a27c0df45df1540a5dd9b7aae972f78bb95fe4d8ae31425f5cee759e4ab9df6a`；测试 `fb8f372328aae397256ae008c09ba0920644d49d90f2f83f87c468e8a285b9b8`。
- 读完205行源码、214行测试与交接，hash捕获/复测/live核对一致。13项实跑通过，包含于[联合27项原输出](evidence/2026-10-08-round2/security-suite.log)。[sourceRef/OS隔离/限制](evidence/2026-10-08-round2/README.md)。共享package不同于交接script追加时版本，不给live npm入口背书。

## M02-ID-E001 — 高 / 阻断完整接线：静态导出不继承生命周期

定位：`identity-pairing.mjs:190–198`仅在export当时过滤isActive，输出id/role/tokenDigest；没有expiry、revocation/generation或运行时查询连接。`request-authority.mjs:20–42`构造时捕获digest，不再读取pairing状态。

[接口探针](evidence/2026-10-08-round2/security-probes.mjs)/[实际结果](evidence/2026-10-08-round2/probe-results.json)证明：

| 情况 | 直接pairing.authenticate | 已构造HTTP authority |
| --- | --- | --- |
| rotate后的旧token | 拒绝 | 仍接受 |
| revoke后的token | 拒绝 | 仍接受 |
| clock超30天 | 拒绝 | 仍接受 |

这不是新pairing核心自身失效；交接已披露authority启动时载入、动态重载待做。本审计将“JSON形状兼容”与“持续身份生命周期兼容”分开，后者仍须正式解决。没有读取真实token或断言现役HTTP在用本配对模块。

下一接线包：HTTP/MCP/工具Gate每次从权威身份状态取当前expiry/revocation epoch，或用经证明的同步重载/fence方案；重启/缓存不得恢复旧凭据。roles、最多16 principal/空active集合、bootstrap/admin边界、撤销在途工具权限与持久状态来源都要明确。

验收：上述三种变化在不重启整个服务时立即拒旧token；当前有效token仍可用；并发rotate/revoke、进程恢复、跨HTTP/MCP与实际工具scope一致。否则只是核心组件通过，不能宣称token全路撤销已经部署。

## 非阻断建议与下一动作

- 导出的`Object.freeze(new Set(...))`不是不可变Set；在真实宿主集成前避免调用方修改角色常量，统一HTTP/MCP角色来源。此建议未被当作外部攻击或当前阻断代码漏洞。
- 输出字段/secret hygiene与现有13项证据范围保持；未来schema/role变化需重审，不无限要求本批承担所有未来功能。
- 执行方可继续依赖此限定核心的无冲突工作；完整身份路径必须补ID-E001的接线证据。组件接受不授权生产改凭据、外发、部署或重启。

Jev只审合成措辞；独立工程结论由主审给出，不是模型概率/官方Worker代签。
