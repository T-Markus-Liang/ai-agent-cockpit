# 执行交接包：P5/B04 + P6/B05·B06 就绪地图（r1，只读探索）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。**本包是只读探索成果，不含代码改动**。

## 批次身份与状态

- batchId / revision：p5-p6-readiness / r1
- 状态：**READY_FOR_REVIEW（探索）**
- 执行AI：Kimi Code 会话（执行方）；探索由 subagent 完成，主 Agent 核对关键结论
- 对应：B04（P5 中文可视化与配对）、B05/B06（P6 迁移回退与命名批次 2）；T07/T08、V14/19/42/43/46/51、V08/17–22/52

## B04：中文可视化现状与差距

**现状资产**：持续目标中文卡片（continuous-goals.tsx，直连 4326，状态/阶段/token/恢复/review/范围明细俱全，aria 较好）；系统连接（system-connections.tsx，四路数据源）；待审批卡片（control-plane-approvals.tsx）；控制面工作流图（**纯静态常量，无数据源**）；Task 简版列表（只显示前 5 条，无详情）。

**有数据无 UI（施工时直接消费）**：`GET /api/control-plane/tasks/:id`（task+executions+evidence，gateway/control-plane.mjs:156-157）、`/tasks/:id/completion-plan`（中文 reasons 现成：缺终态/缺 succeeded/缺 artifactRef/缺 test/缺 review——store.mjs:242-291）、Execution 状态机八态、Evidence 六种 kind。预算（Goal limits+tokensUsed 已有 UI；runtime budget-policy 未接）、`nextWakeAt` 下一检查（无 UI）、recoverOnStartup 的 blocked outcome（无 UI）、投递分层（完成/投递/已读三态全缺）。

**差距清单**：Execution 级列表/详情（零）、completion-plan 面板（零）、Pi 内部图（零，现图为静态）、review 证据 Task 侧（零）、投递分层（零）；硬编码中文不经 `t()`（locale 切换不一致）；approvals 按钮与 Status 组件缺 aria-label；核心导航需改 nav-items.ts。

## B05/B06：迁移回退资产与缺口

**已有资产**：记忆 converter（WAL 一致快照+两次 dry-run+守恒，**审计 r2 复核中不得宣称已验收**）；route-binding-store（单 owner/fence 原子写）；命名批次 2 清单（rename-personal-ai-os.md）；pruning manifest C01–C15。

**缺口（按 P6 六步）**：① 冻结新增派发——无产品级开关（部分）；② **全系统一致性停写快照编排（零）**——控制面/goals 原子写但无 backup API，mem0 必须用 backup API（实测 WAL 1.2MB vs 主库 28KB，直接 cp 必丢数据），微信实例无统一快照；③ 副本转换两次一致——仅记忆有；④ shadow 投影层（零）；④ 白名单 canary+drain 编排（零）；⑤ 命名批次 2 未执行；⑥ 回退冻结点编排（零）。

**停写顺序建议**（依赖分析：桥是最大写入者）：keepawake 保持 → wechat-control → **wechat-bridge（先断入站）** → goals → memory → control-plane → kimi-shim → cezar → antigravity 不动。

**勘误**：命名决策文档写"8 标签"，实际 9 个 plist（8 本仓 + antigravity-proxy 不动）；执行前须重新生成精确 manifest（venv shebang、config 路径等历史盘点数不可直接引用）。

## 施工面（等审计放行后按序）

B04：Execution 列表/详情 + completion-plan 面板 + Evidence 列表 → 预算/nextWakeAt/recovery outcome/投递分层 badge → i18n 统一 + aria 补齐 → 导航收敛 → 真浏览器/手机实页验证（T07 明确组件测试不等于实页）。
B05：一致性停写快照编排器（四类状态统一，记忆用现有 snapshot）→ converter 范式推广到 control-plane/goals → shadow 投影层 → canary+drain 编排 → 回退冻结点 → 命名批次 2 执行。

## 要求审计方做什么

- 核本地图；特别裁决：停写顺序、mem0 WAL 快照编排的归属（migration.py 硬边界禁读写生产目录，生产备份须新编排且需 Markus 批准）、命名批次 2 的"8 vs 9 标签"勘误。
