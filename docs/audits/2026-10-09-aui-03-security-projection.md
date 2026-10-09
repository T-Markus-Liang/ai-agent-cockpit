# AUI-03 安全投影只读核对（C 线）

日期：2026-10-09。性质：**只读源码核对 + Finding 登记，未施工**。依据 docs/research/aui-convergence-graph.md 的 F1–F7 逐项对照现行源码（行号以本日工作树为准，符号为准）。本轮不跑服务、不发请求、不读私有状态目录与凭据。

## 核对结论总表

| Finding | 级别 | 结论（源码证据） |
| --- | --- | --- |
| AUI3-F001 | P1 | 浏览器直连面与 F1 清单一致并新增一处：bookmarklet.ts 做 4321–4330 端口扫描式发现 |
| AUI3-F002 | P1 | wechat-control 无鉴权 + CORS `*`；GET /api/wechat/status 在断连时会拉起 bridge 进程（GET 非纯读） |
| AUI3-F003 | P2 | 控制面 decision 写：浏览器硬编码伪造 `approvedBy: 'dashboard-local-user'`，且无 Authorization 头 |
| AUI3-F004 | P2 | goals 的 X-Goal-Actor 仍为浏览器可设头；RR-F003 角色门先于 actor 检查（viewer 写已堵），但 actor 与已认证 principal 未绑定 |
| AUI3-F005 | P2 | continuous-goals.tsx 把 goal 访问 token 输入浏览器页面内存（F6 坐实，页面自述临时方案） |

## AUI3-F001：浏览器跨端口直连面（P1）

逐项核对 vendor/cezar/packages/web/src（全部命中 F1 表格，另发现 1 处新增）：

| 文件:行 | 目的服务 | 读/写 |
| --- | --- | --- |
| routes/dashboard/control-plane-tasks.tsx:12 | 4324 | 读 |
| routes/dashboard/control-plane-executions.tsx:44 | 4324 | 读 |
| routes/dashboard/control-plane-approvals.tsx:11,17 | 4324 | 读 + decision POST（见 F003） |
| routes/dashboard/continuous-goals.tsx:12 | 4326 | 读 + 写（token 浏览器持有，见 F005） |
| routes/settings/wechat-section.tsx:8 | 4322 | 读 + QR 触发（见 F002） |
| routes/dashboard/system-connections.tsx:35-37,60 | 4322/4324/8080 | 读（探测） |
| routes/settings/local-agents-section.tsx:18,32 | 4324/8080 | 读 |
| lib/bookmarklet.ts:7,33 | 4321–4330 | 读（**端口范围扫描式发现，F1 未列**） |

影响：每张卡片自带端口请求，CORS 白名单（control-plane.mjs:17,29,34 只放行 4321 来源；goals.mjs:14,84-85 同）是当前唯一边界，且是隐性前提。任何本地页面（含恶意网页向 loopback 发请求）都能读这些只读面。

最小修复：同源产品 API（cezar :4321 服务端代理）逐个替换上述 fetch；bookmarklet 的范围发现改指向固定同源发现端点。

## AUI3-F002：wechat-control 无鉴权 + GET 有副作用（P1）

证据（gateway/wechat-control.mjs）：
- `:80` 所有响应 `Access-Control-Allow-Origin: *`；`:85` OPTIONS 同。
- `:89-90` `GET /api/wechat/status` → `qrStatus()`：`:63-64` 有 token 返回 connectedPayload（纯读）；**断连时 `:90` 走 `beginQr()`，`:48` spawn bridge daemon 进程**——GET 触发进程拉起与 token 生命周期推进，不是纯读。
- `POST /api/wechat/qr` 与 status 同一逻辑。
- token 保持在服务端 `~/.wechat-acp/instances/cezar-codex/token.json`（`:12,68-70`），不落浏览器——这一点现状正确，必须保留。
- 无任何鉴权；仅 loopback Host + CORS 的隐性约束。

影响：任何本地页面可轮询状态，并可在断连时反复触发 bridge 拉起（QR 生命周期被第三方页面推进）。

最小修复：拆分只读 `GET /status`（永不拉起进程）与显式写动作 `POST /qr/start`；CORS 收紧为 4321 单源；加同源代理后 loopback 面收敛为仅服务端可达。

## AUI3-F003：approval decision 伪造身份写（P2）

证据：control-plane-approvals.tsx:17-22 decision POST body 硬编码 `approvedBy: 'dashboard-local-user'`，请求**无 Authorization 头**。

影响双重：
1. 身份层面：控制面审计记录里的审批人身份是假的。
2. 功能层面：S03a 已加严格准入（未验证 Approval 在 strict 模式拒 decision），该卡片当前大概率对 hardened 控制面决策失败——即审批按钮实际不可用。

最小修复：走同源代理后由服务端以真实 principal（viewer 角色）代发 decision；控制面支持 viewer 决策路径（或显式拒绝并在 UI 如实呈现"无权决策"）。

## AUI3-F004：X-Goal-Actor 仍为浏览器可设头（P2）

证据：gateway/goals.mjs:115-120——RR-F003 角色门先于 actor 检查运行（viewer 携带 `X-Goal-Actor: local` 也无法写，注释明确），viewer 写面已堵；但 `:119` `actor = req.headers['x-goal-actor'] ?? 'local'`，非 local actor 只需等于 owner 字符串即可管理 goal（`:141` 同理）。

影响：持有合法 writer token 的本地调用方可自设 actor 头冒充 owner 管理 goal。当前 exploit 需要 loopback + 有效 writer token + 知道 owner 字符串，风险低于 F001/F002，但 actor 未与已认证 principal 绑定是设计缺口。

最小修复：AUI-03 同源代理落地时，actor 从已认证 principal 派生（或由代理校验后注入），浏览器不再直接设该头；bridge 直连路径保留现有检查作为兼容。

## AUI3-F005：goal 访问 token 入浏览器（P2）

证据：continuous-goals.tsx:137-140 密码输入框把 access token 存页面 session 内存；:135 页面自述"临时安全接口……不能证明你的身份"。与 AUI-03"server token 不交浏览器"直接冲突（F6 坐实）。

最小修复：同源代理后该输入框退役，改服务端 ui-proxy 凭证；在连续 goal 卡片完成前，该面按"临时例外"记录在案。

## 最小施工顺序建议（AUI-03）

1. cezar :4321 加同源只读代理层（control-plane tasks/executions/approvals 列表、goals 列表、wechat status 只读版、capabilities），真实 principal 映射 viewer 角色。
2. 前端 8 处直连 fetch 逐个改走同源（bookmarklet 最后，改固定发现端点）。
3. wechat-control 拆分只读/写端点 + CORS 收紧（依赖第 1 步代理接管前端访问）。
4. decision 写面：真实 principal 代发 + 控制面 viewer 决策语义明确后开放。
5. goals 写面：actor 由 principal 派生后开放；token 输入框退役。
6. 全程不新增写面直至对应身份/CSRF/权限合同补齐；每步留 Finding 关闭证据。

## 边界声明

本轮未做生产探针，未验证运行态实例；所有结论基于静态源码。F3（bridge 双活）维持原设计研究结论（未证实双活，不重复推断）。正式审计仍按双 AI 协作协议由独立线程复核。
