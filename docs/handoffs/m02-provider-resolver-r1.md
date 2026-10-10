# 执行交接包：M02/I03b provider/凭据引用 resolver 纯模块（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。

## 批次身份与状态

- batchId / revision：m02-provider-resolver / r1
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；branch `main`；cwd `/Users/markus/ai-agent-cockpit`；实现由该会话 subagent（deepseek-flash）完成，主 Agent 设计契约、裁决偏差（多账号别名）、亲自复跑
- 已读并确认协作协议：是。允许写入：runtime/ 新模块、tests/、package.json script、docs/handoffs/、检查点与台账执行条目
- 对应：M02 / I03b（第二切片）；验收矩阵 V38（错误认证/代理失败/秘密输出，不重试风暴、不改全局配置、URL/key 只留私有引用）
- 本批目标：统一引用解析纯模块 + 合成测试。明确不做：pi-adapter/桥/control-plane 接线、fallback 联动、真实凭据读取、生产、commit/push

## 固定来源

- base HEAD：`e8c4317`；工作树含 0.3.0 在途历史未提交内容
- 本批文件（SHA256，2026-10-08 冻结）：
  - `runtime/provider-resolver.mjs`（新增）`a9fc0115…8691a7`
  - `tests/provider-resolver.test.mjs`（新增，12 用例）`e6628053…01725d`
  - `package.json`（新增 `test:provider-resolver` 一行；叠加在前批之上）`9797d8e7…9ddfdb`
- 依赖：无新依赖；纯 ESM、零副作用、无网络/文件读写/凭据硬编码
- 与前三份交接包（m01-migration、m02-runtime-ownership、m02-context-assembler）无文件交集
- 自测前后 sourceRef 一致

## 实现、自测与证据

| 要求/Case（V38） | 当前实现 | 验证命令与 cwd | 退出码/断言/效果 | evidenceRef | 尚未覆盖 |
| --- | --- | --- | --- | --- | --- |
| 引用只留私有引用 | registry 条目只含 `credentialRef` 引用名；凭据值只经调用方注入的 `lookup` 获得，模块不读文件/环境/网络 | `npm run test:provider-resolver`（仓库根） | 12/12 pass，exit 0 | 本文件 | 生产 tokenFile/凭据库的 lookup 适配（接线切片） |
| 不重试风暴 | lookup 每次 resolve 恰好一次；空结果 `unresolved-credential` 不二次调用；未注册 `unresolved-model` 零调用 | 同上 | 调用计数断言通过 | 同上 | 与 fallback 联动时的上下文/副作用约束（V39，后续） |
| 不改全局配置 | registry 构造后深冻结；失败 resolve 注册表不变；模块无写操作 | 同上 | 深冻结与无副作用用例通过 | 同上 | — |
| 秘密输出卫生 | lookup 抛错包装为 `credential-lookup-failed`，丢弃原始 message；所有错误路径只含引用名，综合断言假 token 不出现在任何错误串 | 同上 | 秘密卫生用例通过 | 同上 | — |
| 多账号别名 | 同一 provider/modelId 允许不同引用名（不同 credentialRef），解析严格按引用名；凭据互不串（主 Agent 裁决，纠正了初版过严的"同对即拒"） | 同上 | 别名独立解析用例通过 | 同上 | — |
| 回归 | 相邻套件 | `npm run test:context-assembler` / `test:runtime-contract` | 9/9、14/14 pass | 本文件 | — |

- 真实模型/原文外呼/生产读写/原生会话/微信外发：**均未发生**；纯离线合成，lookup 为测试注入的假函数。
- 失败、部分结果和不明副作用：无。主 Agent 裁决记录：多账号别名合法化（初版"同 provider/modelId 对即拒绝"被纠正，新增别名凭据不串用例）。
- 活动进程/job/handle：无。
- 数据守恒、回退和恢复方法：无状态模块，无数据面；删除两个新文件即完全回退。
- 状态分列：实现完成 ✅（本批范围）；自测通过 ✅（主 Agent 亲自复跑）；独立审计：⏳ 待审计 AI；部署/真机：未做。

## 要求审计方做什么

- 审计范围与重点风险：`runtime/provider-resolver.mjs` 与测试。建议重点：① 秘密卫生是否真的滴水不漏（错误对象全字段，不只 message）；② lookup 恰好一次的并发语义（并行 resolve 同一条目是否可能双调——当前未做去重，是否需要在接线层处理）；③ 注册表校验完备性（原型污染已防：`Object.hasOwn`）；④ 深冻结对数组型 registry 条目的覆盖（当前按对象设计）。
- 已知不足/需决定的方案：并发同条目 resolve 的 lookup 去重（建议接线层或后续切片加单飞语义）；fallback 链的注册表表达（顺序/触发条件）属 I03b 后续切片。
- 等待期间将继续的无冲突独立任务：I03c（有期限 legacy adapter 与唯一 route binding）现状探索与设计；与 runtime 既有文件的接线仍等审计结论后另行切片。
- 非返工 revision（r1 为首次交接）。
