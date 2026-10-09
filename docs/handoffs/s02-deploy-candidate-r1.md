# 执行交接包：S02 候选部署包生成器（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包交付[整改执行方案 S02](../plans/0.3.0-remediation-2026-10-09.md)第 60-67 行（§4"把重启准备变成可验证的部署包"）的**源码/隔离部分**：候选配置迁移器、四客户端身份映射与 authority 候选、服务 authority 路径解析、goals 业务鉴权隔离预检，以及审计要求登记的具体迁移器入口 CLI。**候选包未部署、未写任何现役路径、未做任何生产路径读探针。**

## 批次身份与状态

- batchId / revision：s02-deploy-candidate / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；本批由该会话 subagent（deepseek-flash，官方 V4.1 Flash）实现与自测，主 Agent 定设计合同
- 分支 / cwd：`feat/0.3.0-progress` / `/Users/markus/ai-agent-cockpit`
- 基线：HEAD `c0125a8d4719783aad1e1acef8a0af45346f43cf`（审计文档所记 HEAD；本批未执行任何 git 命令）
- 本批目标：§4 源码/隔离部分全部落点 + 验收（两次 dry-run 一致、未知键、非法时间、客户端漏映射、配置回滚、候选路径不触现役）
- 明确不做：生产路径读写探针与 chmod（属后续 chmod/部署批）、候选包部署、memory 服务侧实机预检（见诚实边界）、UI 代理真实接线（属 S05）、`package.json` 变更
- 铁律遵守：本批只新建下列四个文件，其它任何文件未碰；全部测试夹具为 `fs.mkdtempSync` 自建临时树；未执行任何 git 命令（含只读）；无外呼（goals 预检为 127.0.0.1 临时端口 in-process 服务）；未读写 `~/.local/state`、`~/.wechat-acp` 等生产路径

## 固定来源（完整 sha256）

| 文件 | 行数 | sha256（完整） | 状态 |
| --- | --- | --- | --- |
| `control-plane/deploy-candidate.mjs` | 499 | `d887a1caae6d5599ec3da68c650de30c05b8ca90a0ade7d33b95317897d5f797` | 新建 |
| `scripts/prepare-deploy-candidate.mjs` | 144 | `25263e1d4ed3cc1a2a9b8c97dc5886e19702a6ea8c083ba1b2cebdbb059c039c` | 新建 |
| `tests/deploy-candidate.test.mjs` | 399 | `777303efdaa1bddd49b562579b095f5eda4ca10fff5a52c7d3a5077e8ad4c17a` | 新建 |
| `docs/handoffs/s02-deploy-candidate-r1.md` | — | （本文件，自检不计 hash） | 新建 |

复用未修改的既有模块：`control-plane/identity-pairing.mjs`（createPairingAuthority/exportPrincipals/PRINCIPAL_TTL_MS）、`control-plane/request-authority.mjs`（writeAuthorityFile/createRequestAuthority）、`gateway/goals.mjs`（createGoalServer）、`control-plane/store.mjs`。运行时依赖仅 Node 标准库（`node:fs`/`node:path`/`node:crypto`，Node v24.15.0），**未新增任何依赖**。

## 逐项应答（§4 每条要求的落点）

### "复用 identity-pairing/exportPrincipals/writeAuthorityFile。生成候选 Goal/Memory authority 与客户端映射；绑定用户命名空间、最小角色、有效期、撤销关系。秘密只写私有位置，公开记录不含 token。"

- `generateAuthorityCandidates({ candidateDir, clients, now, random, expiresInMs })`（control-plane/deploy-candidate.mjs L207-276）：每个 service（goals|memory）建独立 `createPairingAuthority` 实例（注入时钟/随机源），按 client mint principal——**principal id = client 名**（绑定命名空间）、`expiresAt = now + (expiresInMs ?? PRINCIPAL_TTL_MS=30天)`。因 `completePairing()` 不支持调用方指定 id/TTL，principal 经 `fromJSON()`/`exportPrincipals()` 校验往返注入，导出文档仍是 request-authority 逐字消费的合同（头注释如实说明）。
- `writeAuthorityFile(<candidateDir>/<service>/authority.json)`：goals 与 memory 各一份（先 mkdir 0700；writeAuthorityFile 先 `createRequestAuthority` 校验再 tmp+rename 原子落盘 0600）。
- 秘密位置：明文 token 仅写 `<candidateDir>/tokens/<name>.token`（mode 0600，内容仅 token+换行，每 client 一份）。公开 `mapping.json`（原子写 0600）只含 `{ version:1, clients:[{ name, service, principalId, role, expiresAt, tokenDigest }] }`——测试递归扫描候选目录内 tokens/ 以外所有文件字节，断言四个明文 token 零命中。
- 撤销/轮换关系写在模块头注释：撤销 = 对该 service pairing authority `revoke(principalId)` 后重新 export+writeAuthorityFile；服务侧每请求重校验（createLiveRequestAuthority / memory LiveAuthority），**不重启生效**——预检第 6 条实测证明。

### "不只检查默认路径：解析实际服务环境覆盖、launchd 参数……候选文件与配置先在独立 stateDir/端口验证。"

- `resolveServiceAuthorityPaths({ env, homeDir, plistTexts })`（纯函数，L313-327）：goals = `env.GOALS_AUTH_FILE ?? ~/.local/state/personal-ai-os/goals/authority.json`；memory = `env.MEMORY_AUTH_FILE ?? ~/.local/state/personal-ai-os/mem0/authority.json`。`plistTexts` 文本注入提取 `<key>GOALS_AUTH_FILE</key><string>…</string>`（plist XML 简单匹配），优先级 **env > plist > default**，返回每服务 `{ path, source: 'default|env|plist' }`。现役两个 launchd plist（launchd/com.markus.personal-ai-os.{goals,memory}.plist）当前均无 authority 覆盖，CLI 实读两 plist 注入解析，输出 source: default（见验证节实跑输出）。
- **与任务简报的一处事实偏差（如实上报）**：简报称"memory 服务无 authority 路径环境覆盖"，但 `services/memory/service.py:921-923` 实际存在 `MEMORY_AUTH_FILE` 覆盖（`os.environ.get("MEMORY_AUTH_FILE") or state_dir/"authority.json"`）。代码为准，本模块实现了该覆盖的解析并在头注释记录此偏差，请审计方确认。
- 文件 owner/mode/无 symlink 的现役核对未做——本批不触生产路径，属后续 chmod/部署批。
- 独立 stateDir/端口验证：见下条预检。

### "覆盖微信 bridge、Goal client、Memory client、UI 服务端代理；浏览器不得获得私有 token。禁止签发一把共用 operator token 图省事。"

- 默认四 client（CLI 用默认，调用方可覆盖）：`wechat-bridge-goals`(goals/**operator**)、`wechat-bridge-memory`(memory/**chief**)、`ui-proxy-goals`(goals/**viewer**)、`ui-proxy-memory`(memory/**viewer**)。每 client 独立 principal+独立 token，无共用 token；goals 与 memory 各 2 个 principal，远低于 request-authority 16 上限。
- UI 代理两面均为 viewer（只读），token 文件 mode 0600 位于候选 tokens/ 私有目录；浏览器不经手任何 token（真实接线属 S05）。
- **bridge-goals 用 operator 的正当性（供审计裁决）**：vendor/wechat-acp/src/goals.ts 的真实动作面为 list/get/**grant**/pause/resume/cancel/**pause-all/resume-all**；goals 角色矩阵中 grant 与 pause-all/resume-all 是 operator 独占，故 operator 是覆盖 bridge 真实动作面的**最小**角色（chief 缺 grant 与 pause-all）。**备选**：后续收窄 bridge 命令面（去掉确认/暂停全部命令）后可降 chief。本包如实标注，请审计裁决是否要求收窄后降权。

### "部署预检需同时检查 health 与已认证业务：合法成功、未知/过期/吊销 401、低角色写 403 且零变更、缺坏 authority 明确失败；轮换不重启生效。"

- `verifyGoalsAuthorityCandidate({ candidateDir, stateDir, mapping })`（async，L345-499）：用 `createGoalServer` 起**真实 goals 服务**（in-process、127.0.0.1 `listen(0)` 临时端口、调用方给的合成 stateDir、stub engine、合成 wechatStateFile——零生产接触），启动前设 `GOALS_AUTH_FILE` 指向候选 authority，finally 中恢复 env 并关 server。逐条记录 `{ check, expected, actual, pass }`，**任一失败不抛**、返回 `{ pass:false, results }` 保完整报告：
  1. 无 Authorization → 401 ✔
  2. 伪造 token → 401 ✔
  3. viewer GET 200；viewer POST → 403；再 GET 集合为空（零变更）✔
  4. operator POST → 201（带 idempotency-key，create 的硬性要求），GET 可读回 ✔
  5. 过期 principal：篡改候选 authority 加入已过期 principal → 401，随后恢复原文件 ✔
  6. 吊销轮换：revoke bridge principal + 加入替换 principal 重写 authority → 旧 token 401、新 token 200，**服务不重启**；随后恢复并记录 `authority-file-restored`（恢复后与原文件逐字节相等，自证候选包完整）✔
  7. authority 文件缺失：第二服务实例指向不存在路径 → 业务请求 500 fail-closed ✔
- health 面：goals 服务 `/health` 无需鉴权由既有 `goal-per-client-token` 套件覆盖；本预检聚焦已认证业务矩阵。

### "配置升级显式处理 promptTimeoutMs=300000……冲突则拒绝并要求确定值，不静默采用 30min 默认。不能改变正式 Grant 的绝对期限。"

- `migrateWechatAcpConfig({ sourcePath, targetPath, dryRun })`（同步，L122-205）：
  - 有旧键无新键 → `grantDeadlineMs = promptTimeoutMs 同值`（300000），删旧键，deprecations 记录；`foregroundWaitMs` 不动（旧键无对应语义，落新默认 120000，头注释说明）。
  - 两键同在且相等 → 删旧键+deprecation；**不等 → `config-conflict` 零写入**，绝不静默采用任何默认。
  - 已知时间字段（session.promptTimeoutMs/foregroundWaitMs/grantDeadlineMs/startupTimeoutMs/idleTimeoutMs、recovery.*Ms）必须是正整数且 ≤ MAX_SAFE_INTEGER，否则 `config-invalid-time` 零写入；坏 JSON/非对象顶层 → `config-invalid`。
  - 未知键（顶层/session 内）不拒绝、原样保留、逐个列入 report.warnings（前向兼容）。
  - 确定性：对象键递归排序（数组不动）后序列化，report 只含 sha256/记录，无墙钟时间戳；两次 dryRun 逐字节相等（测试与 CLI 双重验证）。
  - 非 dryRun：原子写 targetPath（0600，tmp+fsync+rename+fsync dir，已存在则原子替换可重跑），source 原始字节原子写 `targetPath + '.rollback'`（0600，总是反映本次 source）。回滚演练测试：读 rollback 写回与原始逐字节相等。
  - Grant 绝对期限：本迁移只映射旧键同值，不引入/修改任何 grant 期限语义。

### "验收包括两次 dry-run 一致、未知键、非法时间、客户端漏映射、配置回滚；候选路径不得触现役状态。具体迁移器入口由执行方交付后登记。"

- 迁移器入口登记：**`node scripts/prepare-deploy-candidate.mjs --out <candidateDir> [--config config/wechat-acp.json] [--dry-run]`**。--dry-run 只跑两次迁移比对+打印，不落任何文件（--out 目录也不创建）；完整跑生成迁移配置+authority 候选+路径解析摘要；打印 deprecations/warnings/解析路径/文件清单与 tokenDigest 前 12 位前缀，**绝不打印明文 token**。--out 解析后落在 `~/.local/state` 或 `~/.wechat-acp` 下 → 拒绝，**退出码 2**。
- 验收测试（tests/deploy-candidate.test.mjs，15 用例）：两次 dryRun 字节一致+键序打乱后 candidateSha256 相同；未知键保留+warnings；非法时间 8 种坏值×5 个 session 键+recovery.*Ms（0/负/浮点/字符串/2^53/null/bool → config-invalid-time 零写入）；冲突→config-conflict 零写入；坏 JSON→config-invalid；配置回滚（rollback=原始字节、模拟恢复逐字节相等、重跑原子替换 rollback 反映最新 source）；默认四 client 生成与角色矩阵；mapping/authority 递归扫无明文 token；token 文件 0600；authority 被 createRequestAuthority 逐字消费+正反向认证；**客户端漏映射/重名/未知 service/未知 role/路径逃逸名 → invalid-client 零写入**；路径解析四情形（默认/env/plist/优先级）；预检七矩阵全过+二次运行（端口清理、env 恢复、authority sha 前后不变）；坏候选 → pass:false 不抛。全部断言在 mkdtemp 树内。

## 验证（原始退出码）

| 命令 | 结果 |
| --- | --- |
| `node --test --test-reporter=dot tests/deploy-candidate.test.mjs` | **15 pass / 0 fail，exit 0** |
| `node scripts/prepare-deploy-candidate.mjs --dry-run --out /tmp/s02-selfcheck-$(date +%s)` | **exit 0**；输出：migrated=true、`session.promptTimeoutMs migrated to session.grantDeadlineMs=300000`、warnings none、source sha256 `d2d686fb…97971`、candidate sha256 `71ba28c1…f85f`、4886 bytes、**two dry runs byte-identical: true**；候选目录未创建 |
| `node --test --test-reporter=dot tests/goal-per-client-token.test.mjs tests/request-authority.test.mjs tests/goal-role-authz.test.mjs tests/goal-http.test.mjs` | **34 pass / 0 fail，exit 0**（相邻回归，只跑不改） |
| `node scripts/prepare-deploy-candidate.mjs --out /tmp/s02-fullcheck-*`（完整跑，非合同命令，补充自检） | **exit 0**；9 个文件生成（迁移配置+rollback+mapping+2 authority+4 token），全部 0600；四个明文 token 在 mapping/authority/迁移配置中递归零命中；路径解析 goals/memory 均 source: default（现役 plist 无覆盖） |
| `node scripts/prepare-deploy-candidate.mjs --out ~/.local/state/...` 与 `--out ~/.wechat-acp/x` 与无 --out | 均拒绝，**exit 2** |

基线声明：HEAD `c0125a8`；未改生产状态、未重启服务、未外呼、未执行任何 git 命令；候选包未部署。

## 偏差与诚实边界（未覆盖项）

- **memory 服务侧实机预检未做**：本批只起 Node goals 服务做业务矩阵；memory authority 语义由 305 项 Python 测试与镜像合同（同一 exportPrincipals/writeAuthorityFile 文档、LiveAuthority 每请求重校验、viewer/coordinator=read、chief=+ingest、operator=+forget）保证，本批未起 Python 服务。memory authority 候选文件的结构正确性由"createRequestAuthority 逐字消费"测试与同构合同覆盖。
- **MEMORY_AUTH_FILE 事实偏差**：简报称 memory 无 authority 环境覆盖，实际 `services/memory/service.py:922` 存在；已按代码实现解析并请求审计确认。
- **生产路径读探针未做**（文件 owner/mode/无 symlink、客户端 tokenFile 现役核对）：本批铁律不触生产路径，属后续 chmod/部署批。
- **UI 代理真实接线属 S05**：本批只产出 ui-proxy-* 的 viewer 身份候选，未接 Execution 面板。
- **候选包未部署**：所有产物在 /tmp 自检树内验证后删除；`config/wechat-acp.json` 现役文件未动。
- **非 macOS 平台未验证**：全部验证在 macOS（Darwin，Node v24.15.0）。
- **mint 路径说明**：principal 经 fromJSON/exportPrincipals 注入（completePairing 不支持指定 id/TTL），未走 pairing 仪式；签名/摘要/过期/吊销语义由 exportPrincipals 合同与 request-authority 校验保证。

## 要求审计方做什么

- 复核 §4 逐条落点与上表验证证据，特别是：bridge-goals 用 **operator** 的裁决（真实动作面含 grant/pause-all；备选为收窄 bridge 命令面后降 chief）；`promptTimeoutMs → grantDeadlineMs` 同值迁移是否符合"迁成同等 300000ms 操作上限"的预期（旧 5min 行为作为单轮硬上限保留，前台通知时点落新默认 120s）。
- 裁决 **MEMORY_AUTH_FILE** 偏差（简报与代码不一致，以代码为准是否可接受）。
- 复核预检矩阵第 5/6 条的"篡改-恢复"方法学是否构成过期/吊销/轮换不重启的有效证据（恢复后逐字节相等已自证候选包完整）。
- 确认未覆盖项的批次归属（memory 实机预检、生产读探针/chmod、S05 接线）。
- 本包非 Grant/Approval；不授权部署、生产写、chmod 或服务重启。
