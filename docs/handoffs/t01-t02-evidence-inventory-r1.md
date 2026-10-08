# 执行交接包：T01/T02 验收证据盘点（r1，盘点非实施）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。**本包是证据盘点，不含代码改动**。目的：标清 T01/T02 各 V 项的证据现状——已有（出处）、可纯合成补（几乎无）、卡接线/生产/真机（关键路径）。

## 核心结论

**接口级（U/I）合成证据已由 21 份交接批次基本覆盖完毕；T01/T02 的剩余缺口全部位于接线（T01）、真实长后台/真实模型（T02/L 级）与真机（R 级）。继续在纯合成环境新增用例的边际收益已趋近于零——关键路径是审计放行后的接线切片与 Markus 批准项。**

## T01（P2 · V01–05/09/13/15–18/20）逐项

| V 项 | 证据现状 | 出处 |
| --- | --- | --- |
| V01 重复提交执行计数 1 | ok 接口级已有 | legacy-adapter 测试 11（prompt 计数 1）、route-binding V01 幂等 |
| V02 同 ID 不同 digest 拒绝 | ok 合同子项已有 | contracts 冲突检查、route-binding V02 |
| V03 写提交↔入队注入失败 | ok 接口级已有 | route-binding-store 崩溃原子性（未 COMMIT 行重开不存在） |
| V04 重开转 pending + 权限注册前不执行 | warn 部分 | runtime-recovery（running→pending）；权限注册前不执行由 runtime-tools:209（未知 profile/scope 漂移先于调度拒绝）覆盖接口语义；**正式权限接线（T01）仍缺** |
| V05 safe/unsafe 四组合 | ok SDK 级已有 | runtime-recovery 4 组合 |
| V09 等待取消不杀生成 | ok 已有 | runtime-contract:270 |
| V13 SIGKILL 完成步骤不重做 | warn SDK 级已有 | runtime-recovery；**产品 effect 恢复（T01）缺** |
| V15 混用 Pi/Pocket 拒绝 | warn pin 分离已证 | 依赖审计；**混用负例（T01）缺** |
| V16 缺定义/迁移失败可见阻塞 | warn 部分 | route-binding-store 版本拒绝、runtime-tools:209；**task 定义专项（T01）缺** |
| V18 双 owner/别名 | ok I 级已有 | runtime-owner 套件；生产现场 T08 |
| V20 重启退避有界/权限先恢复/无重复计划 | no 缺 | T01/T07 |

## T02（P2/P3 · V09–14/31/37/39）逐项

| V 项 | 证据现状 | 出处 |
| --- | --- | --- |
| V09–V12 取消族 | warn 接口级已有，审计开放 | ownership r1 + r2（诚实降级 stalled/partial；审计已注明不足关闭完整 V11/V12，需 durable ownership 设计） |
| V10 真实长后台 | no L 级缺 | 审计 M02-E001 明确短 faux 测试不可替代 |
| V13/V14 断连与视图重建 | no 缺 | T03/T07 |
| V31 预算耗尽/到期 | ok 接口级已有 | budget-policy 13 用例；跨 runtime/native 接线缺 |
| V37 idle/thinking/心跳/进展分离 | no 缺 | P3 链路前置 |
| V39 有界 fallback 保上下文 | ok 接口级已有 | fallback-policy 12 用例 + 桥侧现行行为证据（session.ts:1374-1421） |

## 判定：为什么不再新增纯合成用例

1. V04/V13/V15/V16 的"部分"缺口全部指向**正式权限/effect/混用/task 定义接线**（T01 本体），合成环境无法提供"正式"语义；
2. V10/V11/V12 的完整关闭需要 **durable 独立 ownership 设计**（审计两轮均指向），属于设计级工作而非测试级；
3. 其余缺口（V14/V20/V37、L/R 级）按定义需要真实链路/真机。

## 要求审计方做什么

- 核对本盘点与证据出处的对应关系；如认为某个"接口级已有"判定不成立，按 Finding 流程提出，执行方按 ID 补证。
