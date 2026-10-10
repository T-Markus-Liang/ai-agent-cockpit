# AUI-03 后续片 r2：wechat-control 只读拆分 + approvals/goals 浏览器写面退役

日期：2026-10-09。批次：D86。基线：D85r（HEAD `6ab85d6`）。实施者：主模型（副模型派单通道 402 Insufficient Balance 失败，与 D80 同款情况，四线由主模型在共享工作树直接实施）。性质：源码 + 隔离测试，**未部署未重启未迁移**；生产 wechat-control（:4322）仍跑旧进程。

## 1. 交付内容（对应 Finding 最小修复）

**AUI3-F002 — wechat-control 只读/写拆分**（`gateway/wechat-control.mjs` 工厂化重写）：
- `GET /api/wechat/status` = 纯本地读：只回答内存态（token→connected；qr→pending/scanned/expired；否则 disconnected），**零远端调用、零 token 文件写入、零进程拉起**。原来断连时 GET 经 `qrStatus()` 拉起 bridge 的副作用彻底移除。
- `POST /api/wechat/qr` = 唯一显式写面：有 token → 幂等确保 bridge（进程内 once 守卫）；有未过期 qr → 远端推进（confirmed 落 token 0600 + spawn + connected）；无 qr/已过期 → beginQr。行为修正：重复点击不再重置进行中的 QR。
- CORS 镜像 control-plane 的 `TRUSTED_ORIGINS`（`http://127.0.0.1:4321`/`http://localhost:4321`），未信任 Origin 一律 403 `UNTRUSTED_ORIGIN`，全服务无 `Access-Control-Allow-Origin: *`。
- 可测试化：`createWechatControlServer({fetchImpl, spawnImpl, tokenPath, bridgeBin, now})`，isMain 守卫保持 `node gateway/wechat-control.mjs` 启动不变（launchd 兼容）。

**AUI3-F003 — approvals 浏览器写面退役**（`control-plane-approvals.tsx`）：
- 列表读切同源代理（复用 r1 路由 + 本轮新增 query 受控转发 `?decision=pending&limit=20`）。
- **删除** `decideApproval` mutation、Approve/Reject 按钮、`dashboard-local-user` 伪造写。strict 模式 `trustedApprovalDecision` 本就要求 operator principal（approvedBy=principal.id），dashboard 的 ui-proxy 凭据按 D73 已批准最小映射只有 viewer——写面在浏览器侧整体退役是 Finding 文档明确允许的「显式拒绝」分支。UI 如实显示只读提示（EN 源串 + t()，zh 已配）。

**AUI3-F004/F005 — goals 浏览器写面退役 + token 退役**（`continuous-goals.tsx`）：
- 读取切同源代理 `/api/v1/personal-ai-os/goals`（r1 已有路由）。
- **删除**：token 输入框、Connect/Disconnect、TOKEN_PATTERN、AuthError/ServiceError、全部写 mutation（create/revise/grant/pause/resume/cancel/pause-all/resume-all）、编辑表单。浏览器不再持有 goal token（F005）、不再发送 X-Goal-Actor（F004）。保留 GoalBadges 徽章层与列表/详情渲染。

**代理增强**（`packages/cezar/src/server/personal-ai-os.ts`）：
- approvals 段 query 受控转发：`decision`（枚举 pending/approved/rejected）+ `limit`（1-100 整数），zod 校验、未知键 strip（默认行为），非法值 400 零 upstream 调用。
- 新增 `GET /api/v1/personal-ai-os/wechat/status`：固定 upstream 4322，**不发 Authorization 头**（wechat-control 无鉴权，注入 token 是假的），也**不以 authority 文件存在为前提**（对无凭据 upstream 套凭据门禁会虚假缩小功能——代码注释写明理由）。同一诚实 envelope。

**i18n**：locale-provider 清掉约 30 个随写面退役的孤儿键（逐键 grep 确认零引用；`Connect`/`Pause`/`Resume`/`Service unavailable` 等被 automations 等他处使用者保留），新增 4 键（两卡只读提示 + Reading goals…/暂无持续目标。）。

## 2. 验证证据（主模型亲自复跑）

| 命令 | 结果 |
| --- | --- |
| `node --test tests/wechat-control.test.mjs` | 8/8 PASS（GET 纯读零远端零 spawn 锁定、POST 三分支、scanned→confirmed 落 token 0600、spawn once 守卫、本地/远端过期、CORS allowlist 镜像） |
| `npm run typecheck`（vendor 四包） | exit 0，0 个 TS error |
| `npm test -- packages/cezar/src/server/personal-ai-os.test.ts` | 16/16（12 旧 + query 转发正/负例 + wechat 无 auth 头 + wechat 不可达降级） |
| `npm test -- packages/web/src/routes/dashboard packages/web/src/routes/settings/wechat-section.test.tsx` | 213/213（28 文件：dashboard+goals+wechat 卡重写后全量） |
| `npm test`（vendor vitest 全量） | 8859 pass / 8 fail / 5 skip；8 fail 为既有环境依赖失败（tracker connections×5、forge-git×2、copilot-acp×1，与 D81 基线同类同数，本批零重叠——失败文件与 personal-ai-os 代理/卡片无涉） |
| `npm run test:unit` | 35 pass / 0 fail / 1 skip |
| `node --test tests/*.test.mjs`（根侧全量） | 682/682 exit 0（基线 674 + 本轮 wechat-control 新增 8） |
| `.venv-memory/bin/python -m unittest discover -s tests -p '*_test.py'` | Ran 416 OK（memory 口径 407 未变——本轮未改 Python，多出的 9 为 kimi_shim_test 计入；退出期 Qdrant warning 保留） |
| `npm run audit:secrets` | PASS，0 未处置命中 |

## 3. 逆向负例（承重断言）

- proxy：非法 `decision`/`limit`（0/101/abc）→ 400 且注入 fetch 零调用；未知 query 键被 strip 不到 upstream（URL 精确断言）。
- wechat-control：任何 GET 序列下注入 spawnImpl 调用恒 0（独立测试锁定）；expired 本地判读零远端。
- 卡片：goals 卡断言无 `127.0.0.1:4326` fetch、无 Authorization 头、无 token 输入框/写按钮；approvals 卡断言无 `127.0.0.1:4324` fetch、无决策按钮（`queryByRole` null）；wechat 卡断言 GET 只打同源代理、POST 写仅 `http://127.0.0.1:4322/api/wechat/qr`。

## 4. 明确未做（边界如实登记）

- **QR 写路径仍直连 4322**（POST）：按最小施工顺序 step 6，写面待身份/CSRF 合同补齐后经同源代理收敛；当前依赖 wechat-control CORS 收紧（4321 单源）+ loopback 绑定做边界。
- **approvals/goals 服务端写语义未动**：control-plane/goals 服务端代码零改动；若未来 owner 批准给 ui-proxy 签发可决策/可写凭据，可经同源代理恢复写面（服务端 trustedApprovalDecision 的 operator 强制与 goals 角色矩阵已就位）。
- **system-connections / local-agents 探测卡、bookmarklet 端口扫描未切**：不在审计点名的三片范围，按 Finding 顺序留后续。
- wechat-control 源码未部署：生产 :4322 仍跑旧进程（旧 GET 语义），CORS 收紧与拆分随部署批生效。
- `.env.example` 无新增变量；BACKWARD_COMPATIBILITY §2 已补 query 面与 wechat 路由。

## 5. sourceRef

`docs/handoffs/evidence/2026-10-09-aui03-r2/aui03-r2-source-ref.sha256`（改动文件 sha256 清单）。
