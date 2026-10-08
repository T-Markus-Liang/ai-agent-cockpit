# I02 memory purge r1：CHANGES_REQUESTED

第二轮审计，2026-10-08。对象：[执行交接](../handoffs/i02-memory-purge-r1.md)。主审未参与本批purge实现。

结论：**需修改验证与效果前保护后重交r2**。22项原测试通过；故障回调和已漂移目标各复现一项缺陷，不能接受“永久擦除已验证”保证。不是说本轮删除过真实用户数据，也不以未做archive接线本身充当本批代码错误。

## 版本、范围与证据

- base HEAD `e8c4317201d70e75cabe279da5e7736a9aab20a0`；purge `984aa617252fdd116a74455c953db5286bf920ec8eaab19f4a0049923ac851a4`；测试 `b136844368cbba31fec509adde56573dfb21ac1c7894704b1a6af0181de14f24`。
- 读完315行源码、450行测试及交接；本批/依赖/交接捕获、复测与live核对相同。[完整sourceRef/沙箱](evidence/2026-10-08-round2/README.md)。共同package后续变化另记，不接受其历史script版本。
- [联合49项原输出](evidence/2026-10-08-round2/memory-suite.log)，包含purge22和reconcile27；OS拒网络与真实home。不是完整memory181项或SDK真实删除的复跑。
- [探针](evidence/2026-10-08-round2/memory-probes.py)/[实际结果](evidence/2026-10-08-round2/probe-results.json)：均纯合成回调/内存turn，exit 0代表缺陷成立。
- 阅读相邻`i02-memory-purge-live-r1`交接的声明，但未审脚本/原始artifact、未运行它；其16项happy-path不能在本审计自动成为已确认L证据，也不能反驳故障负例。

## I02-PG-F001 — 高 / 阻断：打标成功被当作正文已擦除

定位：`purge.py:299–309`，postcheck检查vector不存在、`purged`为真、digest相等，却不验证实际内容擦除。`turn_get`合同仅要求标记与digest，无法支持更强的永久擦除宣称。

实际复现：注入`delete_vector`正确删除向量；`scrub_turn`只设`purged=True`，保留原payload；`turn_get`返回含原payload的当前对象。`execute_purge()`返回`verified=True`，明文仍在。测试是故障注入，不是已观察真实SDK/生产擦除失败。

影响：非可信成功标记不能成为最终verify。现有正例的FakeTurns总正确清内容，所以原22项漏掉“标记正确、内容错误”的路径。

返工：明确本层的可核对擦除后置条件和类型化读取接口，按真实字段验证擦除标记/正文及本层拥有的plan、quote等内容副本。字段缺失或只能取flag时返回不可验证/不完整，不报告永久擦除已验证。跨层archive/备份等未完成范围单列，不能靠缩窄措辞把V36删掉。

补测：不清正文但打标、清payload但其他记忆原文副本残留、擦除字段缺失、scrub返回成功但无持久效果、重新打开后检查。失败不得`verified=True`；正确scrub正常通过。

## I02-PG-F002 — 高 / 阻断：目标已漂移，删除之后才拒绝

定位：`purge.py:284–293`，效果前只检查`purged`；预期digest到`:308`才比较。`plan_purge`选目标时的receipt不等于执行时当前数据。

实际复现：使用真正`plan_purge()`生成的冻结计划，目标预期digest为old；执行前turn已为new。模块先调用一次vector-delete和一次turn-scrub，清除了合成新内容，再抛`verify-failed`。这不是回调在scrub中改坏digest的既有测试，而是**效果开始前已存在漂移**。

返工：任何不可逆效果前，宿主从权威存储检查user/event/source/digest/向量所属、当前tombstone与原审批范围；把版本/隐私epoch检查与效果派发置于单owner/fence下。整批先核对再删，已漂移目标零delete/scrub。不确定效果按部分状态核对，不能换计划或把晚到错误当作已回滚。

补测：执行前目标/身份/digest/vector绑定改变、批次后段目标已漂移、检查与效果交错、部分delete后崩溃。前置漂移时零效果；真实部分效果诚实记录，不宣称恢复原文。

## 接线与策略事项（不计已修复）

- 仍保留先soft-forget、tombstone不删、跨用户选择隔离、digest审计引用等设计；它们的局部正例不能代替上述验证。
- 相邻交接披露ForgetStore.controls不含user_id、purge要求含user_id；在宿主绑定中显式处理，不靠不明全局用户推断。真实SDK缺失id的ValueError、部分delete恢复、user级擦除与archive协调另验。
- “保留digest/tombstone”不是法律合规认证；须向用户明确删除范围与保留的审计元数据，不能承诺所有历史副本已物理消失。
- r2按PG-F001/002提供diff、反向负例和固定hash，再复核SDK/产品链。原V36/G1-memory、裁剪守恒/隐私原门槛不降低。

没有进行真实删除、模型外呼、生产迁移/重启；本线程只写审计/计划。辅助源码定位和Jev措辞检查另列证据，不签最终权限。
