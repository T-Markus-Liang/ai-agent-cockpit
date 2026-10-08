# 执行交接包：I02/P1 purge 真实 SDK 隔离验证（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。

## 批次身份与状态

- batchId / revision：i02-memory-purge-live / r1
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；branch `main`；cwd `/Users/markus/ai-agent-cockpit`；脚本由该会话 subagent（deepseek-flash）编写，主 Agent 设计取证点并亲自复跑取证
- 已读并确认协作协议：是。允许写入：scripts/、package.json script、docs/handoffs/、检查点与台账执行条目；purge.py/ForgetStore 未改
- 对应：I02/P1（第三切片，live 证据）；验收 V36 的 L 级（真实服务隔离）证据
- 本批目标：真实 Mem0 SDK（本地 Qdrant + 离线 fastembed）下 purge 删除链路的隔离验证。明确不做：生产 Mem0、真实模型调用（generativeModelCalls=0）、archive 擦除、commit/push

## 固定来源

- base HEAD：`e8c4317`；工作树含 0.3.0 在途历史未提交内容
- 本批文件（SHA256，2026-10-08 冻结）：
  - `scripts/test-memory-purge-live.py`（新增）`8e3bda86…cb81db`
  - `package.json`（新增 `test:memory-purge-live` 一行）`992df9e6…4cd88db`
- 被验对象（冻结未改）：`services/memory/purge.py 984aa617…`、`services/memory/lifecycle.py 8d71c3d0…`
- 运行环境：Mem0 SDK 2.2.1、本地 Qdrant、fastembed MiniLM-L12-v2（HF_HUB_OFFLINE=1 本机缓存命中，零联网）、临时目录 0700、隔离 user_id（uuid4）
- 与前十三份交接包无文件交集

## 实现、自测与证据

主 Agent 亲自运行 `npm run test:memory-purge-live`：exit 0，**16/16 PASS**，报告 `{"type":"IsolatedMemoryPurgeLiveReport","ok":true,"generativeModelCalls":0,"productionWrites":0,"productionStateDirTouched":false,"wechatMessagesSent":0,"nativeSessionsResumed":0}`。

| 取证点 | 真实证据（主 Agent 复跑输出） |
| --- | --- |
| 真实写入与召回 | 3 条中文事实经真实 fastembed embedding + Qdrant 写入；purge 前语义检索 topScore 0.8506 命中目标 |
| 真实删除 | 接 SDK `memory.delete`（main.py:1883，缺失 id 抛 ValueError）；向量计数 3→2；被删事实不再召回、其余两条仍召回 |
| 凭据保留 | turn payload 擦除为 `[purged]`、purged=true、digest 逐字保留；非目标行零影响 |
| 幂等 | 重复 purge 报 already_purged，无重复删除 |
| 复活防护 | ForgetStore.match 三级全命中（by_event_id / by_source_hash / by_sentence_hash 均 true）；全新事实不误伤；tombstone 不被 purge 删除 |
| 回归 | `npm run test:memory-purge` 22/22、`npm run test:memory-service` 85/85 |

- 真实模型/原文外呼/生产读写/原生会话/微信外发：**均未发生**（evaluator 为本地假评估器，0 生成调用；embedding 全离线）。
- 失败、部分结果和不明副作用：无。运行期打印 spaCy/BM25 可选组件警告，与 README 一致，不影响语义检索判定。
- **发现的契约缝隙（如实登记）**：`lifecycle.ForgetStore.controls()` 返回的 tombstone 不含 `user_id` 键，而 `purge.plan_purge` 的 tombstone 校验要求精确键集含 user_id——上层协调器接线时必须显式补 user_id（脚本已按此处理）。建议列入接线切片的修正项。
- 活动进程/job/handle：无。artifact 目录为私有临时目录（0700），可整体删除。
- 状态分列：实现完成 ✅（本批范围）；自测通过 ✅（主 Agent 亲自复跑两轮，不同命名空间均 16/16）；独立审计：⏳ 待审计 AI；部署/真机：未做。

## 要求审计方做什么

- 审计范围与重点风险：`scripts/test-memory-purge-live.py` 的取证设计。建议重点：① 断言点是否足以支撑 V36 的 L 级证据；② SDK delete 契约（ValueError on missing）与 purge-incomplete 语义的衔接；③ 上述契约缝隙的修正归属（purge 侧放宽 vs ForgetStore.controls 补 user_id）。
- 已知不足/需决定的方案：真实 Jev 提炼链路的 purge 端到端（需批准的 live 范畴）；user 级擦除；archive 擦除 vendor 专项。
- 等待期间将继续的无冲突独立任务：I02 剩余两项（活跃原生会话隐私重置、质量UI）设计提案，或等审计结论后做 service.search / purge 接线切片。
- 非返工 revision（r1 为首次交接）。
