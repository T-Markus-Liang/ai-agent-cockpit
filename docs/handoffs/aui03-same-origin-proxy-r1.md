# AUI-03 第一片：cezar 同源只读代理 r1+r2

日期：2026-10-09。批次：D81（r1）/ D81 追加（r2 同日）。基线：D80（HEAD `1e6ef85` + 未提交 WIP）。实施者：主模型。性质：源码 + 隔离测试，未部署未重启，生产 wechat-control/goals/control-plane 未改。

## 1. 交付内容

**AUI-03 最小施工顺序第 1–2 步的首个切片**：cezar :4321 同源只读代理层 + 第一张卡片切换。

- `packages/contract/src/personal-ai-os.ts`：proxy envelope schema（`{available, reason?, upstreamStatus?, body?}`）+ control-plane section 枚举（tasks/executions/approvals/capabilities）；contract index 导出。
- `packages/cezar/src/server/personal-ai-os.ts`：代理模块。
  - 两条 GET-only 路由：`GET /api/v1/personal-ai-os/control-plane/:section`、`GET /api/v1/personal-ai-os/goals`。
  - 固定 loopback upstream（4324 / 4326），无任意 URL 转发面；3s 超时。
  - token 仅服务端持有：读 `CEZ_PAI_OS_AUTHORITY` 指向的 JSON 文件（`{controlPlane?, goals?}`），mtime 缓存支持不重启轮换；文件缺失/损坏/缺该 upstream token → `200 {available:false, reason:'authority-unavailable'}`（零配置降级：缺凭证缩小功能，不 fail boot）。
  - upstream 5xx 原样透传（`upstreamStatus`+`body`），不重写；envelope 永不携带 token。
  - 注入缝：`deps.personalAiOsFetch` / `deps.personalAiOsAuthorityPath`（测试用）。
- `server.ts`：family 挂入 workspace 链（chained `.route`），ServerDeps 加两字段。
- `control-plane-tasks.tsx`：列表卡改走同源 `/api/v1/personal-ai-os/control-plane/tasks`，解 envelope；`available:false` 走既有"控制面暂不可用"UI。浏览器不再触 4324、不再可能见 token。
- `.env.example`：`CEZ_PAI_OS_AUTHORITY` 入文档（vendor env 合同）。
- `BACKWARD_COMPATIBILITY.md` §2：两条路由入册（bc-route-inventory 通过）。

## 2. 验证证据（主模型亲自复跑）

| 命令 | 结果 |
| --- | --- |
| `npm run typecheck`（vendor 四包） | exit 0 |
| `npm test`（vendor vitest 全量 8868） | 8855 pass / 8 fail / 5 skip；8 fail 为既有环境依赖失败（tracker×5、forge-git×2、copilot-acp×1），已在 HEAD 干净 worktree 复跑确认与本次零重叠 |
| `npm run test:unit` | 35 pass / 0 fail / 1 skip |
| proxy 定向 10 例 | 10/10（降级 envelope×3、token 注入与 URL 路由×2、token 不泄漏、5xx 透传、超时降级、枚举外 section 400、POST 404） |
| contract-parity / typed-bodies / versioned-surface / bc-route-inventory / parity-tracker | 全过 |
| web 卡片 15 例 | 15/15（新增降级渲染用例：请求打到同源代理、零条 127.0.0.1:4324） |

## 3. r2 追加（同日）：executions 详情/completion-plan 切同源

- 代理新增两条 GET-only 路由：`GET /api/v1/personal-ai-os/control-plane/tasks/:taskId` 与 `.../tasks/:taskId/completion-plan`；`:taskId` 经 zod 单段校验（`A-Za-z0-9_-` ≤200），非法值 400 且不产生任何 upstream 调用（反例测试锁定）。
- `control-plane-executions.tsx` 的 task 详情与 completion-plan 改走同源代理；`readProxied` 对 `upstreamStatus >= 400` 抛错，卡片保持"不可达 + Retry"诚实渲染（不用空 body 假装成功）。
- BACKWARD_COMPATIBILITY §2 补两条路由；bc-route-inventory 通过。
- 验证：proxy 定向 12/12（新增详情/plan URL 与 token 注入、非法 id 400 零调用）；web 15/15（stub 改 envelope 透传，dStatus/planStatus 语义经 upstreamStatus 保留）；vendor typecheck exit0；vitest 8857 过 / 8 失败（同前既有环境失败）/ 5 skip。

## 4. 明确未做（后续片）

- executions 详情/approvals 写面/continuous-goals 写面/system-connections/local-agents 探测卡仍是直连（按 Finding 文档顺序逐片切）。
- wechat-control 只读拆分（AUI3-F002）未做：代理暂不代理 wechat status（避免代理带副作用的 GET）。
- 代理未部署：生产 authority 文件属 S02 部署批；未设 `CEZ_PAI_OS_AUTHORITY` 时卡片如实显示不可用。
- goals 写面 actor 派生（AUI3-F004）未做。
- 独立复核未竟（副模型通道故障，登记为待审）。

## 5. sourceRef

`docs/handoffs/evidence/2026-10-09-s04-privacy-r2/aui03-proxy-r1.sha256`（9 文件）。
