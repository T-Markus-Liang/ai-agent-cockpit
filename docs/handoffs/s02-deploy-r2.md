# 执行交接包：S02 身份与配置迁移——chmod/部署批（r2）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)。本包交付[整改执行方案 S02](../plans/0.3.0-remediation-2026-10-09.md)§4 的生产侧剩余项：生产路径探针、权限收紧、候选包安装、逐项重启与实盘业务预检。前置：r1 候选生成器（READY_FOR_REVIEW）+ owner 于 2026-10-10 明确授权"S02 部署批"。**本包已实际部署并重启四个服务中的三个（goals/memory/wechat-control/wechat-bridge）；control-plane 与 cezar web 未动。**

## 批次身份与状态

- batchId / revision：s02-deploy / **r2**
- 状态：DEPLOYED（实盘预检 11/11 PASS，待审计裁决）
- 分支 / cwd：`feat/0.3.0-progress` / `/Users/markus/ai-agent-cockpit`，部署执行时 HEAD `6af59bf`
- 执行：主模型直接实施（subagent 通道 400 geo-block）
- 证据目录：`docs/handoffs/evidence/2026-10-10-s02-deploy/`（preflight.txt / modes.before.txt / poststate.txt / live-verify-final.log / wechat-acp.json.sha256.before）
- 秘密备份（私有，不进 repo）：`~/.local/state/personal-ai-os/s02-backup-20261010-073444/`（0700；旧 config、旧 goals/mem0 api-token）

## 探针结论（部署前，只读）

- 现役 goals(:4326)/memory(:4325) 业务端点**部署前已对全部调用方 401 关闭**（authority.json 从未安装；GOALS_AUTH_FILE/MEMORY_AUTH_FILE 未设置，服务按默认 stateDir 路径找 authority.json）；health 正常。本次部署是**恢复**这两个业务面，不是收紧。
- 运行中进程为 10-06/10-07 启动的旧代码在内存版本：其 authority 语义不支持"文件出现后 live 生效"（部署后首验 401、token/摘要本地核对一致），故对 goals/memory 做**单项重启**加载现码（现码 LiveAuthority 每请求 O_NOFOLLOW+fstat 重验，轮换不重启生效）。这是重启的唯一原因，已逐项验证，非一键全量。
- 文件权限旧值（`modes.before.txt`）：goals 目录树全部 0700/0600 ✅；mem0 `history.sqlite` 0644、`vectors` 0755、telemetry-id 0644、config/wechat-acp.json 0644——后四项为本批收紧项。
- `config/wechat-acp.json` 语义 diff（排序归一后）仅 `session.promptTimeoutMs:300000 → session.grantDeadlineMs:300000`，无其它变更。

## 执行步骤与退出码

1. 备份：旧 config + 旧 api-token×2 → 私有 700 备份目录（`install -m 0600`）。
2. 候选：`node scripts/prepare-deploy-candidate.mjs --out ~/personal-ai-os-staging/s02-20261010-073444/candidate` → exit 0；迁移 deprecation 1 条、warnings none、四 client（bridge-goals operator / bridge-memory chief / ui-proxy×2 viewer）、全部产物 0600。
3. 安装：authority.json×2 `install -m 0600`（新文件）；bridge token×2 同目录 tmp+rename **原子轮换**（满足 LiveAuthority 原子轮换合同）；config 原子替换 0600。
4. chmod（逐项，旧值在证据）：mem0/history.sqlite 0644→0600、mem0/vectors 0755→0700、telemetry-id 0644→0600、config/wechat-acp.json 0644→0600。
5. 重启（单项逐一，非全量）：goals `launchctl kickstart -k` exit 0 → memory exit 0 → wechat-control exit 0（D86/D87 代码上线，:4322 status connected、CORS 未信任源 403/信任源 200）→ wechat-bridge exit 0（迁移配置生效，日志：loaded saved token Bot 65d8c34bf48a、artifact-mcp up、polling resumed；durable inbox recovery pending=0 **uncertain=1**（重启前已存在的旧项，如实登记未处置））。
6. 实盘预检：`node scripts/verify-s02-live.mjs`（本包新交付，token 零打印）→ **11/11 PASS exit 0**：health×2、无凭据 401×2、伪造 401×2、bridge-goals operator GET 200（goalCount=5）、ui-proxy-goals viewer POST pause-all **403 且 paused 零变更**、bridge-memory chief search 200、ui-proxy-memory viewer search 200、viewer turns **403**。
7. 终验：全部重启后再跑 verify → 11/11 PASS；五端口监听正常；`tokensExposed: 0`。

## 固定来源

- 新交付：`scripts/verify-s02-live.mjs`（实盘只读业务矩阵；403 探针在授权前置校验、零状态变更；token 从文件直读、永不打印）。
- 复用 r1：`control-plane/deploy-candidate.mjs`、`scripts/prepare-deploy-candidate.mjs`（未改）。
- 安装产物 sha256（证据目录 `wechat-acp.json.sha256.before` + poststate.txt 实测）。

## 偏差与诚实边界

- **bridge-goals 用 operator**：按 r1 设计上线（真实动作面含 grant/pause-all，operator 为最小覆盖角色；备选收窄后降 chief）。owner 授权 S02 视为对本项的裁决，请审计复核确认。
- **MEMORY_AUTH_FILE 偏差**（r1 登记）：按代码实现，未另设 env，authority 装默认路径。
- ui-proxy 两个 viewer token **未接线**（cezar :4321 进程未动、无 CEZ_PAI_OS_AUTHORITY），staged 于 s02-latest/candidate/tokens/，属 S05。
- bridge 端到端（真实微信发 goals 命令）未验——属 S05 真实链路；client 侧逐请求读 tokenFile 为代码事实，service 侧矩阵已实盘。
- control-plane(:4324)/cezar(:4321) 未重启；0.3.0 发布未批准；生产记忆迁移/回退、真机微信、24h canary 未动。
- 轮换不重启生效：现码语义 + r1 预检 #6 为证据；本批未在实盘做轮换演练（安装前业务面 100% 关闭，为最安全窗口，但轮换重写仍属可选项，留审计决定）。

## 要求审计方做什么

- 裁决 bridge-goals=operator 的上线事实；复核 11 项实盘预检证据是否满足 §4"合法成功、未知 401、低角色写 403 且零变更"。
- 确认四项 chmod 旧值记录是否满足 §7"逐项记录旧值"。
- 对 uncertain=1 durable inbox 旧项给出处置归属。
