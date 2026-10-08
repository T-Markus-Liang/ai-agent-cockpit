# 执行交接包：I02/P1 活跃原生会话隐私重置 + 质量UI 设计提案（r1，提案非实施）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。**本包是设计提案，不含代码改动**；两项均涉 vendor（wechat-acp 桥 / cezar 前端），按协议先提案、经审计与 Markus 排期后另开实施批次。

## 批次身份与状态

- batchId / revision：i02-vendor-proposals / r1
- 状态：**READY_FOR_REVIEW（提案）**
- 执行AI：Kimi Code 会话（执行方）；提案由主 Agent 基于 I02 探索证据撰写
- 对应：I02/P1 剩余两项（活跃原生会话隐私重置、质量UI）；V36（原生 reset 部分）、V34/V35（来源/质量呈现部分）
- 本批目标：把两项 vendor 工作的设计定到可施工深度。明确不做：任何 vendor 文件改动、实施、commit/push

## 提案 A：活跃原生会话隐私重置

### 问题与现状证据

记忆服务 `forget` 只能阻止**未来**召回（tombstone + 桥侧本地屏障）；**正在运行的 ACP 原生会话已把被忘记的内容加载进活动 transcript**，记忆层够不到（`docs/decisions/runtime-0.3.0.md:62`："当前ACP/GUI原生会话还没有自动隐私重置"）。现状只有一个硬编码为 true 的声明位 `PrivacyState.activeSessionResetRequired`（`vendor/wechat-acp/src/storage/memory.ts:41,409-413`），**全仓库无消费者**（grep 仅命中定义处与一条测试断言）。

### 设计

1. **检测（真实 epoch 驱动，替代硬编码）**：`ForgetStore` 已有 per-user `user_epochs` 表（`lifecycle.py:175-178`，forget 时 epoch+1）。桥侧在**每轮 prepare 前**读取该用户的 memory epoch（经记忆服务 `/v1/controls`，`service.py:798-800`），与该 ACP 会话创建时记录的 epoch 比对：**epoch 变大 → 该会话重置必需**。`privacyState()` 从硬编码 true 改为真实比较结果。
2. **重置语义（turn 边界生效，不杀在飞）**：命中重置时——会话**空闲**：直接废弃持久 sessionId，下轮用全新 ACP 会话（旧会话永不 resume，与桥侧 fallback 不持久规则一致）；会话**有在飞 prompt**：标记 `resetPending`，在飞请求跑完或进入核对，**不静默 kill**，turn 结束后再重置。
3. **作用域**：只重置**该用户**的会话（其他用户不受影响）；不删除原生 Agent 的历史文件（原生所有权），只废弃桥侧的会话绑定。
4. **防遗忘内容再注入**：重置后的首轮 prepare 走正常记忆装配——被 forget 的内容已被 tombstone 拦截（已有机制），不会经记忆上下文重新进入。
5. **失败语义**：`/v1/controls` 不可达 → 保持现状不重置（fail-safe：宁可多保留一轮也不误杀会话），并记 needs_review。

### 实现面（vendor/wechat-acp，另开实施批次）

- `src/storage/memory.ts`：`privacyState()` 改真实 epoch 比较（新增 epoch 缓存与 `/v1/controls` 调用）。
- `src/bridge.ts`：prepare 前置检查；`src/acp/session.ts`：`resetPending` 与 turn 边界重置。
- 测试：vendor 套件合成用例（forget 后下一轮用新会话、在飞不静默 kill、其他用户不受影响、controls 不可达 fail-safe）。

### 验收

合成证据：活跃会话期间发生 forget → 下一轮用全新会话且被忘内容不再出现；在飞 prompt 完成或进核对，零静默 kill；epoch 未变的会话零打扰。

## 提案 B：记忆质量 UI

### 问题与现状证据

仪表盘"系统连接"仅有 Mem0 连接状态与 pending/retrying 两个计数（`vendor/cezar/packages/web/src/routes/dashboard/system-connections.tsx:13,36,48`），**没有** validated / needs_review / legacy_unverified 分解与来源呈现。后端数据已具备：`/health` 的 quality 块（`services/memory/service.py:755-791`）与 `/v1/status`（按 event 返回处理/质量/版本/安全错误类型，**不返回原文**，`:709-753`）。

### 设计

1. **面板内容**（全部只读、零原文）：质量分布三档计数（validated / needs_review / legacy_unverified）+ tombstone 与 epoch 摘要；最近事件列表只显示 `event_id 尾缀 + 状态 + extraction_version + error_kind + 时间`——**永不渲染 payload/quote 原文**（与 /v1/status 的无原文契约对齐）。
2. **来源一致**：计数以服务端 quality 块为唯一来源，前端不做本地推算（避免"界面说一套、服务存一套"）。
3. **操作**：本版只读；forget/purge 操作入口等 purge 接线审计通过后另行提案。
4. **技术形态**：vendor/cezar 前端新路由组件（复用系统连接的拉取模式）；按 vendor AGENTS 的 Vitest/typecheck 流程验收，不以生产 build 代替隔离测试。

### 实现面（vendor/cezar，另开实施批次）

- `packages/web/src/routes/dashboard/` 新增记忆质量组件；数据来自 4325 的 `/health`+`/v1/controls`（回环只读 GET）。
- 测试：组件级 Vitest（fake fetch），断言无原文字段被渲染、三档计数与服务端一致、错误态展示。

### 验收

组件测试 + 类型检查通过；面板任何状态不含原文；计数与 `/health` quality 块一致。

## 共同边界与所需授权

- 两项均需 **vendor 文件改动**（wechat-acp / cezar），属"修改既有交付文件"的实施批次，建议等审计 AI 对在手十七份交接包出结论后排期；不阻塞其余工作。
- 提案 A 的"废弃用户会话绑定"是用户可见行为变化，实施前建议 Markus 确认语义（尤其 resetPending 的在飞处理）。
- 两项均不触碰：记忆服务端代码、原生历史文件、生产配置。

## 要求审计方做什么

- 评审两提案的设计完备性与边界（尤其 A 的 epoch 驱动检测与在飞语义、B 的无原文契约）；裁决排期建议与所需授权级别。
- 等待期间执行方继续：等审计结论后做接线切片（service.search 接 reconcile、purge 生产接线、runtime 各模块接线）；或 P3 前置探索（B02 微信闭环需 P1/P2 接线通过，暂依赖审计）。
