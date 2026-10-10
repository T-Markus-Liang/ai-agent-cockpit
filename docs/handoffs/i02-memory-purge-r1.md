# 执行交接包：I02/P1 永久擦除策略与执行模块（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。

## 批次身份与状态

- batchId / revision：i02-memory-purge / r1
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；branch `main`；cwd `/Users/markus/ai-agent-cockpit`；实现由该会话 subagent（deepseek-flash）完成，主 Agent 设计契约（先软忘记后硬擦除、擦除内容保留凭据）、亲自复跑
- 已读并确认协作协议：是。允许写入：services/memory/ 新模块、tests/、package.json script、docs/handoffs/、检查点与台账执行条目；service/quality/lifecycle/migration/reconcile 均未改
- 对应：I02/P1（第二切片）；验收 V36（依用户选择停止检索/再提炼或确认删除；无旧摘要复活）的接口层
- 本批目标：永久擦除策略/计划/执行纯模块 + 合成测试。明确不做：真实 SDK delete 接线、archive 物理擦除（vendor 桥归属）、生产数据、commit/push

## 固定来源

- base HEAD：`e8c4317`；工作树含 0.3.0 在途历史未提交内容
- 本批文件（SHA256，2026-10-08 冻结）：
  - `services/memory/purge.py`（新增）`984aa617…c851a4`
  - `tests/memory_purge_test.py`（新增，22 用例）`b1368443…e14f24`
  - `package.json`（新增 `test:memory-purge` 一行）`ff260825…706647`
- 依赖：无新依赖（纯标准库）；删除经注入函数，未调真实 SDK/DB
- 与此前十二份交接包无文件交集
- 自测前后 sourceRef 一致

## 实现、自测与证据

| 要求/Case（V36） | 当前实现 | 验证命令与 cwd | 退出码/断言/效果 | evidenceRef | 尚未覆盖 |
| --- | --- | --- | --- | --- | --- |
| 先软忘记后硬擦除（主 Agent 决策） | tombstones_required 非空 → `tombstone-required`，零副作用（delete_vector 零调用，有测试锁） | `npm run test:memory-purge`（仓库根） | 22/22 OK，exit 0 | 本文件 | 真实 SDK delete/delete_all 接线（后续切片） |
| 擦除内容、保留凭据（主 Agent 决策） | turn 行 payload 清除 + purged=1，**digest 原样保留**（删除行为本身可审计）；验证强制 digest 不变 | 同上 | DigestPreservation 用例通过 | 同上 | — |
| 无旧摘要复活 | tombstone 不删；复活防护用例用**真实 lifecycle.ForgetStore + 内存 sqlite** 证明同文新 event_id 重放被 source_hash 拦截 | 同上 | RevivalProtection 用例通过 | 同上 | quote_hash 级复活拦截需原文（store 重放时兜底，已注释） |
| 不静默半擦除 | 任一 delete/scrub 失败 → `purge-incomplete` 带 completed/failed 清单；擦除后验证（vector 不存在 + purged + digest 一致）不符 → `verify-failed` | 同上 | PartialFailure/Verification 用例通过 | 同上 | — |
| 隔离与幂等 | 跨用户目标永不触及；空选择器 empty:true 如实报告；重复执行报 already_purged 不重复删除 | 同上 | 对应用例通过 | 同上 | user 级擦除（本切片不支持，mode 仅 event/fact） |
| archive 归属 | plan 仅含 archive_refs 引用，执行面无任何 archive 调用（有断言） | 同上 | ArchiveReference 用例通过 | 同上 | vendor 桥 archive 擦除（归属 vendor，另行专项） |
| 回归 | memory 联合 discover 与 service 套件 | `python -m unittest discover -s tests -p 'memory_*test.py' -v`；`npm run test:memory-service` | 181/181 OK（159→181）、85/85 OK | 本文件 | — |

- 真实模型/原文外呼/生产读写/原生会话/微信外发：**均未发生**；纯内存 fake + 真实 ForgetStore（内存 sqlite）。
- 失败、部分结果和不明副作用：无。偏差如实登记：返回带 already_purged 字段；mode 与 selector 强制配对；冻结后集合为 tuple。
- 活动进程/job/handle：无。
- 数据守恒、回退和恢复方法：删除两个新文件即完全回退；digest 凭据保留语义有测试锁定。
- 状态分列：实现完成 ✅（本批范围）；自测通过 ✅（主 Agent 亲自复跑）；独立审计：⏳ 待审计 AI；部署/真机：未做。

## 要求审计方做什么

- 审计范围与重点风险：`services/memory/purge.py` 与测试。建议重点：① tombstone-required 判定的两级匹配与 ForgetStore 三级匹配的差距（quote_hash 级无原文时的兜底路径）；② 擦除后验证的完备性；③ purge-incomplete 清单的诚实性；④ digest 保留 + payload 清除的语义是否满足"确认删除"的用户预期与法规语义（这是策略问题，建议人与审计共同确认）。
- 已知不足/需决定的方案：真实 SDK delete 接线的验收路径（需要真实 Mem0 隔离命名空间 live 测试，产生少量调用）；user 级擦除的语义与授权边界；archive 擦除的 vendor 专项。
- 等待期间将继续的无冲突独立任务：I02 剩余项（活跃原生会话隐私重置、质量UI——均涉 vendor，先出设计提案入交接包）或等审计结论后接线。
- 非返工 revision（r1 为首次交接）。
