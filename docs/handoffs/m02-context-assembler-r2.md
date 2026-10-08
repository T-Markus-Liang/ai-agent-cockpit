# 执行交接包：M02/I03b 统一 ContextAssembler r2（按审计 Finding 返工）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包为 r2 revision，回应 [m02-context-assembler-r1 审计](../audits/m02-context-assembler-r1.md)（EVIDENCE_REQUIRED + M02-CA-E001 高/接线阻断）；r1 原文件与证据保留不覆盖。

## 批次身份与状态

- batchId / revision：m02-context-assembler / **r2**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；branch `feat/0.3.0-progress`；cwd `/Users/markus/ai-agent-cockpit`；实现由该会话 subagent（deepseek-flash）完成，主 Agent 设计返工契约、决策偏差、亲自复跑
- 已读并确认协作协议：是。允许写入：`runtime/context-assembler.mjs`、`tests/context-assembler.test.mjs`、`docs/handoffs/m02-context-assembler-r2.md`
- 对应：M02 / I03b；验收矩阵 V34（关键值保持）、V39（保留上下文来源）；修剪 C06（不重复摘要）前置
- 本批目标：源码级硬化“总上下文预算 + 各字段独立上限 + 失败关闭校验”。明确不做：桥侧（`enrichPromptWithMemory`）/runtime 接线、provider/凭据 resolver、真实模型/生产、`package.json` 变更、任何 git 操作
- **未改 `package.json`**：`test:context-assembler` 沿用 r1 已登记脚本，测试命令路径固定

## r2 固定来源（新 hash）

| 文件 | r2 SHA256 | r1 SHA256 |
| --- | --- | --- |
| `runtime/context-assembler.mjs`（修改） | `3cb2c722be90ab3da4002730ac0f28b8e9ec6a767b9674a2c2e70aaba75a2764` | `46292658…d944ad` |
| `tests/context-assembler.test.mjs`（修改，9 → 18 用例） | `2cf2df22957648cb34f6ca4d9f57defd693b1ab7611e8865bf279f6dc1d9c80d` | `f5bec859…9f6654` |

- base 基线：r1 审计基线 `e8c4317`；分支 `feat/0.3.0-progress`
- 依赖：无新增；纯 ESM，新增唯一 import 为 Node 内建 `node:crypto`（与 `runtime/contracts.mjs` 一致），用于 provenance digest，无网络/DB/凭据/副作用
- 参照（只读未改）：`vendor/wechat-acp/src/bridge.ts:916-931`、`vendor/wechat-acp/src/storage/memory.ts:222-271`
- 与 m01/m02 其他批次无文件交集；自测前后 sourceRef 一致
- 历史 r1 文件、审计与证据均未改动

## Finding 逐条回答

### M02-CA-E001（局部 text 限额 ≠ 总上下文预算，高/接线阻断）→ 全局预算 + 独立上限 + fail-closed

- **全局总预算（new, 必填）** `limits.totalChars`：以“所有 block 文本用 `"\n"` 合并后的字符数”为口径（`meta.totalOutputChars` 如实回填），合并输出**永不超过**该值。缺失 / 非有限 / 非正整数 / 低于 floor（1）一律 `TypeError` 拒绝（fail-closed）。r1 会接受该调用并输出 196991 字符、`meta.truncated` 为空；r2 直接拒绝。
- **裁减优先级（源码级契约）**：超出 `totalChars` 时按固定顺序裁减，**先裁 → 后留**：① 最旧 turn（保留 r1“最旧 turn 先裁”语义）② 最旧 fact（把该语义**扩展到 facts**）③ lossy summary 摘要段 ④ request-link ⑤ persona（persona 最后保留）。每一步均可复现、顺序稳定；全部裁完时 blocks 为空且必然 ≤ 预算（预算 floor ≥ 1）。
- **如实记录、不记正文**：`meta.truncated` 为受影响类别名（`persona/turn/summary/fact/factSource/role/requestLink`，规范顺序）；`meta.cutCounts` 为每类被裁/被截**条目数**；`meta.cuts` 为被裁/被截条目逐条记录 `{kind, action, reason, index?, role?, source?, digest}`，`digest = sha256:<64hex>`（**原始**内容哈希）、`source` 为**有界**来源引用，**不写正文全文**。
- **facts 数量上限（new, 必填正整数）** `limits.factsMaxCount`：超上限时**最旧 fact 先裁**（与 turn 规则一致），记录 `reason: "facts-max-count"`。
- **fact source 独立上限（new）** `limits.factSourceMaxChars`（默认 512），另有 `limits.roleChars`（默认 64）、`limits.requestLinkChars`（默认 512）：source/role/request-link 各自独立截断，使巨大 source/role 不能作为“metadata 旁路”绕过预算；截断写入 `meta.truncated` 并记原始 digest。
- **floor 校验（修 r1 静默变 0）**：每项限额要求**有限整数且 ≥ floor**（floor 见导出常量 `LIMIT_FLOORS`，均为 1）。r1 的 `Math.floor` 会把 `0.5` 静默变 0；r2 对 `0.5`、`10.5`、`0`、`NaN`、`Infinity`、字符串、布尔一律拒绝。`REQUIRED_LIMIT_KEYS`/`LIMIT_FLOORS`/`CUT_CLASSES` 已导出供宿主派生预算。
- **不静默丢字段 / 输入不可变**：预算内正常输入全字段与 source 原样保留，`cuts` 为空；函数不改动传入对象/数组（新增测试断言 `JSON.stringify(input)` 前后一致）。

## 关键 diff 摘要（`runtime/context-assembler.mjs`）

- 新增导出：`REQUIRED_LIMIT_KEYS`、`LIMIT_FLOORS`、`CUT_CLASSES`；`DEFAULT_LIMITS` 增加 `factSourceMaxChars:512`、`roleChars:64`、`requestLinkChars:512`（`totalChars`/`factsMaxCount` **无默认、必填**）。
- `resolveLimits`：原“`limits` 可缺省 → 默认”改为**必填对象**；逐项要求有限整数且 ≥ floor；缺必填键 → `TypeError`。
- `assembleContext`：新增 `SEGMENT_SACRIFICE_ORDER` 与 `renderBlocks`/`mergedLength` 纯函数；装配后按“turn→fact→段”三段降级循环直到合并长度 ≤ `totalChars`；`record()` 统一写入 `cuts`/`affected`；`meta` 扩展为 `{truncated, droppedTurns, summaryCount, totalChars, totalOutputChars, budgetExceeded, cutCounts, cuts}`（r1 前三字段语义保留，`droppedTurns` 现含预算裁减计数）。
- 头部注释升级为 r2 硬化说明；`node:crypto` 仅用于 `digestOf`。

## 反向负例清单与原始结果摘要

审计复现路径已固化为固定测试（`tests/context-assembler.test.mjs`）：

| 负例 | 输入 | 断言结果（原始） |
| --- | --- | --- |
| r1 可复现的无预算调用 | `assembleContext({facts: 64×(text 1024/source 2048)})` | **拒绝**：`TypeError: limits is required and must be an object`（r1 曾输出 196991 字符） |
| 缺单个必填项 | `limits:{factsMaxCount}` / `limits:{totalChars}` | 各自 `TypeError`（缺另一必填项） |
| 审计复现 + 预算 | `totalChars:20000, factsMaxCount:1000` | 合并输出 **18647 ≤ 20000**；保留 12 条 fact、裁 52 条、source 独立截断 64 条；`meta.truncated=["fact","factSource"]`、`budgetExceeded=true`；最旧被裁 fact（index 0）`digest=sha256:5eeee4a934665929ae984a42c58f7635187f7d8a036bd38ee17b1d0e4d04f72a`，`source` 为 `factSourceMaxChars` 有界引用 |
| 每类被裁条目数 | 同上 | `cutCounts.fact(=52) + 保留行数(=12) == 64`，逐条记账无遗漏 |
| 不记正文 | 遍历 `meta.cuts` | 每条 `digest` 匹配 `^sha256:[0-9a-f]{64}$`；无 `text` 字段；字符串值长度 ≤ `factSourceMaxChars + marker` |
| floor / 类型 | `totalChars ∈ {0,-1,NaN,Infinity,-Infinity,10.5,"100",true}`、`factsMaxCount ∈ {0,0.5,undefined}` | 全 `TypeError`；`factSourceMaxChars/roleChars/requestLinkChars` 的 `0`、`0.5` 亦拒绝 |
| factsMaxCount 边界 | 3 条 fact，上限 3 / 2 / 1 | 3=不裁；2=裁最旧 1 条（`reason:"facts-max-count"`, `index:0`）；1=裁 2 条 |
| factSourceMaxChars 独立 | source 100 字符，上限 200 / 10 | 200=原样；10=截断为 `slice(0,10)+marker`，`cutCounts.factSource=1`，digest 为原始 source |
| role / request-link 上限 | `roleChars:5`、`requestLinkChars:20` | 分别按上限截断并记入 `truncated`/`cuts` |
| 裁减优先级 | `turns→facts→summary→request-link→persona` 各级预算 | 各级只裁该级及更早级：先裁 turn、再 fact、再 summary、再 request-link，persona 最后保留 |
| 裁减顺序稳定 | 满预算减 1；同输入调用两次 | 恰好裁**最旧** turn（index 0，TURN-TWO 保留）；两次输出 `deepEqual`、`cuts` 顺序一致 |

## 验证（主 Agent 亲自复跑，仓库根，cwd `/Users/markus/ai-agent-cockpit`）

| 命令 | 结果 |
| --- | --- |
| `npm run test:context-assembler` | **18/18 pass，exit 0**（原 9 语义用例 + 9 新负例/边界） |
| `npm run test:runtime-contract` | 14/14 pass，exit 0 |
| `npm run test:control-plane` | 21/21 pass，exit 0 |

- 真实模型/原文外呼/生产读写/原生会话/微信外发：**均未发生**；纯离线合成、无副作用；无 `chmod`/用户文件改动；无生产 DB/服务/launchd 接触。
- 失败、部分结果和不明副作用：无。活动进程/job/handle：无。
- 数据守恒/回退：无状态纯模块，删除两个改动文件即完全回退到 r1。

## 未覆盖项与诚实边界（如实）

- **仍未接线**：本模块不被桥/runtime 调用，`enrichPromptWithMemory` 单入口替换与 provider/凭据 resolver 属后续切片；不宣称现役微信 `V34/V39/C06/C48` 全链通过。
- **元数据规模**：约束的是发给模型的**合并 prompt 输出**（≤ `totalChars`）；`meta.cuts`/`cutCounts` 随**输入条目数**增长（每裁/截一条记一条 digest + 有界来源），未对超大输入条目数设元数据上限——审计若要求，可另设 meta 记录上界。
- **段牺牲顺序为设计决策**：审计只硬性规定 “最旧 turn 先裁并扩展到 facts”；本批把 summary→request-link→persona 定为后续段顺序（persona 最后保留）。**待审计裁决**。
- **超预算时 persona/summary/request-link 为整段丢弃**（非部分保留）：内容级部分保留由各段自身限额（`personaChars`/`summaryChars`/`requestLinkChars`）负责，预算阶段只做整段降级，避免“纯前缀截断冒充关键事实全保留”。
- **隐私/质量筛选与“旧摘要 + Pi 摘要两次注入”的最终防护**必须在宿主绑定 user/source/epoch 之后完成，本批仅提供预算/计数/来源引用，未证明全链。
- digest 用 `node:crypto` sha256（内建，确定性、离线），非外部依赖。

## 要求审计方做什么

- 按 Finding ID 复核 r2 diff / hash / 负例与审计复现镜像（18647 ≤ 20000、52 裁 / 12 留、64 源截、digest 样例）。
- 特别裁决：① 段牺牲顺序（summary→request-link→persona）是否可接受；② 超预算时“整段丢弃 vs 部分截断”的取舍；③ 是否要求对 `meta.cuts` 条目数设上界。
- 裁决 M02-CA-E001 是否可关闭为“总预算/数量/来源/字数上界已受控”，或需进一步降级为限定接受（本模块仍未接线，不得据此宣称现役上下文受控）。
