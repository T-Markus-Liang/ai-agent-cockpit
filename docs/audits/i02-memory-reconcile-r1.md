# I02 memory reconcile r1：CHANGES_REQUESTED

第二轮审计，2026-10-08。对象：[执行交接](../handoffs/i02-memory-reconcile-r1.md)。主审未参与本批实现；实现Goal仍paused。

结论：**需修改更正链的环检测后重交r2**。27项原测试通过，但三事件负例保留了环。仅阻断本批版本/来源链正确性，不停止其他独立工作，也不把纯解析器未接search的事实说成生产故障。

## 版本、范围与证据

- base HEAD `e8c4317201d70e75cabe279da5e7736a9aab20a0`；源码 `a696cf7323f3a81f4b0c2ad1f35a7beedcb33777b79ef9fcb5fd2d51a2491523`；测试 `72f926192a4e535ebb1f1788c96c09cc8ba03ddf0967a36ad5cc15c84c87ce25`。
- 读完267行源码、321行测试和交接；捕获与复测后hash一致，live核对也一致。完整[版本和边界](evidence/2026-10-08-round2/README.md)。package为共同后续版本，不给旧交接npm script版本背书。
- 使用冻结副本、纯合成receipt，OS禁止网络/真实用户目录读写；49项联合子套件包含本批27项和purge22项，[exit 0原始输出](evidence/2026-10-08-round2/memory-suite.log)。没有复测交接声称的全记忆159/181项。
- [主审探针](evidence/2026-10-08-round2/memory-probes.py)与[结果](evidence/2026-10-08-round2/probe-results.json)。Probe exit 0是错误被复现，不是修复通过。

## I02-RC-F001 — 高 / 阻断本批：存在终点不等于图中无环

定位：`reconcile.py:195` 显式边覆盖时间线；`:202–209` 的cycle guard只判断 `not any(value is None ...)`，没有遍历所有连通分量。

复现：同用户、同slot，A时间1且`supersedes=B`，B时间2，C时间3。实际输出：

```text
current = [C]
successors = {A: B, B: A, C: None}
conflicts = []
```

A/B形成独立环，C终点使guard不触发。与docstring `:71–74` 的矛盾显式边回退规则不一致，也使版本链不能沿successor抵达current。本轮没有证明已在微信召回中使用该环，search尚未接入；确定结论是解析器输出的来源链错误。

返工：对完整successor图做确定性环/可达性校验，不只数None。按已约定规则处理矛盾边（回退时间线或明确conflict，若改变策略需记录设计决定）；输出不可带环或悬空边，不靠“仍有一个current”掩盖。

补测：当前三节点断开环、四/更多节点内部环、所有节点成环、合法跳过中间版本的显式更正；所有输入排列结果相同。每个resolved节点在有限步内抵达合法终点，version/chain/superseded_by一致。

## 限定正面证据与接线缺口

- 可保留原用例证明的确定性、同slot时间序、跨用户显式更正拒绝、forgotten过滤、原字段保留与同刻conflict；不足以整批接受。
- 输入是**调用方已信任的receipt**；模块没有校验role/validation_status，不据此虚构“助手事实已被生产召回”的缺陷。接search时必须由宿主先绑定用户、来源、质量、forgotten与隐私epoch，不能直接喂原始对话。
- 缺省slot=event_id、全局event ID唯一是现有明确合同。槽位提炼、service.search接线、跨事件真实语义、质量UI还需要独立证据，V35/G1-memory不计全通过。
- r2按Finding提供diff/hash、负例和实际结果。官方DeepSeek仅做无改动源码定位，主审负责复现/审结；不是另一位发布签字。

本报告未改peer功能/测试、未部署/删除生产数据，不是新的Grant/Approval。
