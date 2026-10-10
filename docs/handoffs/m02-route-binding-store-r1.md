# 执行交接包：M02/I03c route-binding SQLite 持久化存储（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。

## 批次身份与状态

- batchId / revision：m02-route-binding-store / r1
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；branch `main`；cwd `/Users/markus/ai-agent-cockpit`；实现由该会话 subagent（deepseek-flash）完成，主 Agent 设计契约、亲自复跑
- 已读并确认协作协议：是。允许写入：runtime/ 新模块、tests/、package.json script、docs/handoffs/、检查点与台账执行条目；冻结文件（contracts/pi-adapter/route-binding）只 import 未改
- 对应：M02 / I03c（第二切片）；验收矩阵 V03（写提交与入队之间注入失败→原子无半条状态的接口层）
- 本批目标：route-binding 的持久化适配（write-through SQLite，逻辑与持久同事务）。明确不做：legacy adapter 本体、真实路由接管、WAL 化、符号链接防护（对齐 full-sqlite 的后续项）、生产、commit/push

## 固定来源

- base HEAD：`e8c4317`；工作树含 0.3.0 在途历史未提交内容
- 本批文件（SHA256，2026-10-08 冻结）：
  - `runtime/route-binding-store.mjs`（新增，289 行）`1a5fc542…0b35c6`
  - `tests/route-binding-store.test.mjs`（新增，10 用例）`92e72416…9ae02a`
  - `package.json`（新增 `test:route-binding-store` 一行）`c9efadc1…40423a`
- 直接依赖（冻结未改，只 import）：`runtime/route-binding.mjs a5eb6fde…`
- 依赖：无新依赖（node:sqlite 内置）；测试全 mkdtemp 临时目录
- 与前五份交接包无文件交集
- 自测前后 sourceRef 一致

## 实现、自测与证据

| 要求/Case | 当前实现 | 验证命令与 cwd | 退出码/断言/效果 | evidenceRef | 尚未覆盖 |
| --- | --- | --- | --- | --- | --- |
| V03 原子性接口层 | 写路径 write-through：内存注册表为逻辑权威，每个持久写在单条 BEGIN IMMEDIATE…COMMIT 内；COMMIT 失败从 DB 重载内存回滚；未 COMMIT 行重开不存在（测试 5） | `npm run test:route-binding-store`（仓库根） | 10/10 pass，exit 0 | 本文件 | 多写者并发（单写者设计，owner 化属后续） |
| 冲突/幂等零写入 | binding-conflict 后 DB dump 逐字节不变；全同重绑不再 INSERT（行数恒 1）；intent 重复 planEffect 幂等（行数恒 1） | 同上 | 对应用例通过 | 同上 | — |
| 持久化与恢复 | close/reopen 字段完整恢复；过期 legacy 记录可加载（时钟无关），读取门在 resolve（`binding-expired`）；schema_version 不符 → `unsupported-schema-version` 且外来 DB 零改写 | 同上 | 对应用例通过 | 同上 | schema 迁移策略（v2 出现时另行设计） |
| 权限 | store 文件 0600、目录 0700 | 同上 | 通过 | 同上 | symlink/非普通文件拒绝（对齐 full-sqlite，后续） |
| 回归 | 相邻套件 | `npm run test:route-binding` / `test:runtime-ownership` | 12/12、11/11 pass | 本文件 | — |

- 真实模型/原文外呼/生产读写/原生会话/微信外发：**均未发生**；全合成临时目录。
- 失败、部分结果和不明副作用：无。偏差如实登记：只读 getter 三个（观测便利）；序列化信封常量与 route-binding 隐式耦合（已注释指向）；rollback journal 而非 WAL（正是崩溃原子性语义所需）；无 symlink 防护（切片外）。
- 活动进程/job/handle：无。
- 数据守恒、回退和恢复方法：删除两个新文件即完全回退；DB 语义由 SQLite 事务保证。
- 状态分列：实现完成 ✅（本批范围）；自测通过 ✅（主 Agent 亲自复跑）；独立审计：⏳ 待审计 AI；部署/真机：未做。

## 要求审计方做什么

- 审计范围与重点风险：`runtime/route-binding-store.mjs` 与测试。建议重点：① 内存/DB 一致性方案（头注释 MEMORY/DB CONSISTENCY SCHEME 五条）是否有遗漏窗口；② schema 引导顺序（版本检查先于建表）对外来 DB 的保护是否完备；③ 信封常量与 route-binding 的隐式耦合是否接受；④ rollback journal vs WAL 的选择是否认可。
- 已知不足/需决定的方案：多写者/owner 化（建议随 legacy adapter 本体一起设计）；symlink 防护对齐 full-sqlite（小项，可并入下批）。
- 等待期间将继续的无冲突独立任务：I03c 第三切片 legacy adapter 本体的设计（包装桥侧执行路径、消费本 store）或转 I03d 探索——下轮先选择。
- 非返工 revision（r1 为首次交接）。
