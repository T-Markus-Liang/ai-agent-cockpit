# 施工序列：条件接受，拆开源码与生产门槛

2026-10-08。对象：[序列提案](../handoffs/construction-sequence-r1.md)。其Wave方向基本合理，但**Wave0不能成为所有源码工作同时等待全部批准的总闸门**。

- 新Finding范围内返工：现行Goal §3已经授权，收到[第三轮索引](README.md)即可做隔离修复，交新revision；不用另等Markus许可/权限/外呼决定。
- 新ownership：[方向条件已接受](durable-ownership-proposal-r1.md)，可做新合成任务切片；旧stalled实际继续、改生产owner与迁移另审批。
- Wave1/2接口或vendor源码可在已有范围内先实现默认关闭route+fake适配与测试；真实身份切换、真实CLI启动/旧会话写入、微信发送、生产purge/重启仍分开取得原授权及门槛。代码接线不等于开启生产。
- Wave4纯中文展示/aria/阶段与投递分层可用明确fake/真实只读状态合同并行；不得展示假连接/假完成，按vendor AGENTS隔离验证，不拿生产build代替测试。privacy-reset语义待定的部分不要先实施不可逆用户会话变更。
- Wave5/6实际迁移/目录标签搬动/物理裁剪/真实24h/发布保留原批准与G5/G5c/G6。私有副本合成converter、故障/回退测试可先做，不把生产停机许可误当所有测试都要先批准。
- @getpaseo许可待核对只限制其采用/新增分发和G0放行；可先查上游覆盖/隔离这条依赖，不自动修改项目license、安装替代或扩大发布范围，也不阻止不依赖它的纯源码修复。

执行方下一轮先RBS/FB/BP/RB代码缺陷返工与ownership新任务合同；依赖未过的正式路径仍不开。提案的并行“无交集”须以实际文件清单检查，尤其pi-adapter、shared package与store，不能仅看Wave编号。

这是审计/计划裁决，不是新增生产、权限、旧原文外呼或发布批准。保持失败证据、原预算和授权，更新检查点时核对真实Goal handle，别让resume里的active文本与blocked管理器状态矛盾。
