# 执行交接包：接线放行后施工序列提案（r1，提案非实施）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。**本包是序列提案，不含代码改动**。依据四份就绪地图（[P3](../handoffs/p3-readiness-r1.md)、[P4](../handoffs/p4-readiness-r1.md)、[P5/P6](../handoffs/p5-p6-readiness-r1.md)）与审计两轮 Finding 整理，供审计 AI 与 Markus 裁决施工顺序；不是开工令。

## 批次身份与状态

- batchId / revision：construction-sequence / r1
- 状态：**READY_FOR_REVIEW（提案）**
- 执行AI：Kimi Code 会话（执行方）；主 Agent 综合
- 覆盖：M01 收尾 → P3/B02 → P4/B03 → P5/B04 → P6/B05·B06 → P6c/P7

## Wave 0：放行前置（阻塞中）

| 项 | 等谁 |
| --- | --- |
| 五份 r2 复核（m01-migration、ownership、session-permission-broker、reconcile、purge） | 审计 AI |
| 剩余 8 批审计（assembler/resolver/route-binding/store/legacy-adapter/budget/fallback/native-sandbox/purge-live） | 审计 AI |
| @getpaseo/\* 许可处置、6 处 chmod、会话重置语义 | Markus |
| M01 收尾：43 条用户旧事实真实 Jev 重验证、副本→生产迁移与服务重启 | Markus 批准 |

## Wave 1：P1/P2 接线收尾（审计放行后）

按依赖排序，同文件冲突已错开：

1. **service.search 接 reconcile**（services/memory/service.py）：current/superseded/conflicts 三态进检索；宿主先绑定用户/来源/质量/forgotten/epoch（审计 RC 报告接线要求）。
2. **purge 生产接线**：真实 SDK delete + ForgetStore.controls 补 user_id（I02-R3 发现的契约缝隙）+ live 验证扩展负例。
3. **pi-adapter 预算准入**（runtime/pi-adapter.mjs）：budget-policy 接入 submit 路径；V31 跨 runtime 预算。
4. **native-acp-executor 接线**（V25+V47）：裸 spawn 换 native-sandbox.wrapWithSandbox（先做真实 CLI 间接 exec 探测定 execLiterals）；tool call 拒绝路径改接 session-permission-broker。
5. **身份生命周期接线**（ID-E001）：HTTP/MCP 每次从权威身份状态取当前 expiry/revocation，或经证明的同步重载——三种变化不重启即拒旧 token。
6. **goals token 每客户端化**：identity-pairing 的 exportPrincipals 接入 goals/control-plane 服务。

每步独立验收 + 交接包；2/3/4 互相无文件交集，1/5/6 无交集，可两两并行。

## Wave 2：P3 微信闭环（B02）

按 P3 就绪地图插入点：

1. `/acp-more` 断链修复（handler 接 replyOutbox.retryBlockedForUser）——小、独立、先摘；
2. admitIncoming 处登记唯一 runtime Submission（复用 route-binding-store）；
3. 前台等待与后台执行分离（onTurnEvent 四 phase 检查点 + Grant 期限通道；替代单一 promptTimeoutMs 整轮终结）；
4. `/消息` 六类显示（新增"后台/验收"两态数据源）；
5. 派发小窗口中间态（sent-unconfirmed，recover 转 uncertain 而非 queued）。

每步真实微信由 Markus 抽验（B02 验收要求）。

## Wave 3：P4 真实 Worker（B03）

按 P4 就绪地图九步：SessionRef 加 accountId → launch intent 前置 + executionGuard → Codex+OpenCode 合成隔离会话真实 prompt → sandbox 接线（Wave 1.4 已做则复用）→ permission broker 接线（Wave 1.4 同）→ native cancel → plan scope 含 sessionRefId → 第二 Worker 独立 Reviewer + 只读约束 → Evidence/Completion Proof。T06 要求**两个**真实 CLI Worker 闭环。

## Wave 4：P5 可视化（B04）

Execution 列表/详情 + completion-plan 面板（中文 reasons 现成）→ 预算/nextWakeAt/recovery outcome/投递分层 badge → i18n 统一 + aria 补齐 → 导航收敛 → 真浏览器/手机实页（T07）。vendor 前端，与 Wave 1–3 无文件交集，可全程并行。

## Wave 5：P6 迁移回退（B05/B06）

一致性停写快照编排器（四类状态，mem0 必须 backup API，实测 WAL 1.2MB）→ converter 范式推广到 control-plane/goals → shadow 投影层 → 白名单 canary+drain → 回退冻结点 → 命名批次 2（9 标签勘误后执行，停写顺序：keepawake 保持→bridge 先断→goals→memory→control-plane→shim→cezar）。**每步需 Markus 批准停机窗口**。

## Wave 6：P6c/P7

C01–C15 强制裁剪（V46–V52/G5c）→ 24h 合盖/网络/停滞真机 + 微信文字/语音抽验（Markus 参与）→ 发布核对。

## 全局约束

- 每个 Wave 的每步：独立交接包 + 反向负例 + 真实证据等级（U/I/L/R 按验收矩阵），不以组件测试冒充实页/真机。
- 生产切换、真实旧会话写入、外发、物理裁剪、停机窗口：逐步取得 Markus 具体范围确认，不因序列获批而自动放行。
- 任一 Wave 的审计 Finding 优先于后续 Wave 新工作。

## 要求审计方做什么

- 裁决序列与并行度；标注需要调整依赖关系或授权级别的步骤。
