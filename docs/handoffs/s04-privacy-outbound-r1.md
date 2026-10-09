# 执行交接包：S04a 记忆隐私 epoch + 旧记录出站清单与秘密筛查（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包按[整改执行方案 §6](../plans/0.3.0-remediation-2026-10-09.md)第 80/84 行的**第 1 条（隐私重置）与第 3 条（旧记录外呼）**施工：新增每用户隐私 epoch（存储后置、单调、fail-closed 未知语义）与本地出站盘点/秘密筛查工具，并在既有 needs-review/错误通道上接线（不发明新状态机）。**本批只交清单与筛查工具与源码闸门，真实外呼零发生；不触生产路径、不改 vendor/、不改 control-plane/、不执行任何 git 命令、不把真实历史原文写入测试或文档。**

## 批次身份与状态

- batchId / revision：s04-privacy-outbound / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；本批由该会话 subagent（deepseek-flash，官方 V4.1 Flash）实现与补测，主 Agent 定设计合同并亲自复跑验证
- 分支 / cwd：`feat/0.3.0-progress` / `/Users/markus/ai-agent-cockpit`
- 基线：HEAD `1e6ef85f6ae303d6af429ca257f2364896d3db86`（直读 `.git/HEAD` → `.git/refs/heads/feat/0.3.0-progress` 得到；本批**未执行任何 git 命令**，含只读）
- 已读并确认的前序交接：[i02-memory-per-client-auth-r1](i02-memory-per-client-auth-r1.md)（authority/角色矩阵）、[i02-memory-purge-r3](i02-memory-purge-r3.md)（边界重验语义）、[m01-migration-r3](m01-migration-r3.md)（113/43 历史数字的来源与"未核验"定性）
- 本批目标：§6-1 隐私 epoch 的读取/组装/投递边界 hold 语义 + §6-3 外呼清单与 secret-screen dry-run 工具；明确不做：真实外呼/真实 Jev 调用、生产记忆库盘点、质量 UI 服务端代理（§6-2，见未覆盖项）、向量元数据 epoch 打标（见未覆盖项）、部署/重启
- 铁律遵守：全部夹具为自建 tmp 目录/合成 sqlite；无网络（测试用 `patch socket.socket` 断言）；未读写 `~/.local/state/**`；未执行 git；未改 `package.json`、`docs/audits/**`、`docs/plans/**`、`vendor/**`、`control-plane/**`、`gateway/**`、`config/**`、`migration.py`、`lifecycle.py`、`quality.py`

## 固定来源（完整 sha256，2026-10-09，`shasum -a 256`）

| 文件 | 行数 | sha256（完整） | 状态 |
| --- | --- | --- | --- |
| `services/memory/privacy_epoch.py` | 240 | `0950f86cb189865b60dd9eb6c220107e521db22e4d2b6af581979b650decd496` | **新** |
| `services/memory/outbound_inventory.py` | 396 | `47d1a4dd4ca1da5c2be38a8555d8613731c2d5c3bc47863064a1c1f2bd7e6f9f` | **新** |
| `services/memory/service.py` | 1080 | `e659db1a1923d24b9a17f16be96c625f043f63ef53c658021cdafad81416b76d` | 改（1006 → 1080 行；上一次的记录 hash 见 [i02-memory-per-client-auth-r1](i02-memory-per-client-auth-r1.md) `c4e25f28…`，其后至本批前该文件是否漂移本批无法在无 git 条件下核验，请审计方按流程复核） |
| `tests/memory_privacy_epoch_test.py` | 489 | `37ed4c85d9972e47c86bf9b06594efda8b915816404fdcc971f913709ea353f6` | **新**（31 用例） |
| `tests/memory_outbound_inventory_test.py` | 283 | `614435c7b3a331770bdfcde2608aaf3c053f5700a18c486a33b3d23d255567c5` | **新**（25 用例） |
| `docs/handoffs/s04-privacy-outbound-r1.md` | — | （本文件，最后登记） | **新** |

依赖：**无新依赖**（两新模块仅标准库 `json/os/re/sqlite3/time/pathlib`；service.py 只增加对本包两模块的相对 import）；未改 `requirements.txt`/`requirements.lock`。两新测试文件前缀 `memory_`，被既有联合 glob `memory_*test.py` 自动纳入。

## §6-1 隐私重置：逐项应答

**存储后置 epoch（`privacy_epoch.py`）**

- 每用户单调整数，持久化在 `<state_dir>/privacy-epochs/<user_id>.json`（目录 0700、文件 0600、原子写 tmp+fsync+`os.replace`），刻意**放在 ingestion SQLite 之外**，隐私重置不需要对被保护存储加写锁。
- `get_epoch(state_dir, user_id)`：无记录=已知初值 `0`；**任何失败（损坏/篡改/不可读/非法 user_id）→ `EPOCH_UNKNOWN`(-1)**——不是 0、不是旧值；非法 user_id 读也 fail-closed 为 UNKNOWN。
- `bump_epoch(state_dir, user_id)`：隐私重置入口，**只抬 epoch，不删任何原生历史**（测试断言 bump 前后 `ingest.sqlite` 字节 digest 不变、原始 payload 仍可读）；对损坏存量**拒绝 bump**（`epoch-state-corrupt`，绝不覆盖不可读状态静默重置）；原子写失败不留残件。
- 严格 schema（键集恰为 `version/user_id/epoch/updated_at`，epoch 为非负 int 拒 bool）：篡改（改 user_id、加键、负值、字符串、bool、非 JSON、非 UTF-8）全部 → UNKNOWN（8 种 tamper 用例）。
- `filter_by_epoch(records, epoch)` 纯函数：内部会话重建只保留**写入时 epoch 标记恰等于已知当前 era**的记录；无有效标记的记录 fail-closed 排除；以 UNKNOWN 查询恒为空。支持 dict 与带 `epoch` 属性的对象，原记录原样返回。

**边界接线（`service.py`，全部走既有通道，不发明新状态机）**

| 边界 | 挂点（探明依据） | 语义 |
| --- | --- | --- |
| 生成回复上下文组装 | `MemoryService.search` 入口（`/v1/search` 唯一组装点；微信桥 README 载明服务不可用即降级本地上下文） | epoch UNKNOWN → 抛 `PrivacyEpochError`，端点渲染 503（既有 `except Exception → 503` 错误通道），**向量库零查询**（测试断言 `engine.search` 未被调用），不投递任何旧上下文；组装末重读：已变/不可读 → 丢弃结果集返回空（镜像既有 forget-epoch 末重查的同款语义） |
| 异步提取/worker 准入 | `MemoryService.process_one` 准入后（仅 user turn；assistant 归档无生成/投递，明确不拦） | UNKNOWN → `_fail(..., QualityError("privacy_epoch_unknown"))` 有界重试，终态 **needs_review、原文保留**、prepare/evaluator/向量零调用 |
| 异步投递边界 | `process_one` 向量效果前（紧邻既有 `_suppress_if_forgotten` 重查） | 不可读 → 有界重试；**epoch 已变 → 丢弃该批次结果**：`_finish(event_id, "needs_review", plan+error_kind="privacy_epoch_changed")` 终态落 needs_review，persisted plan 与原文保留，store 零调用。在飞任务不 kill/replay：存量输入带到自然边界诚实结算（ racing 用例：prepare 恰好一次、store 零次） |
| 引擎 prepare 准入 | `Mem0Engine.prepare`（credential/bounds 检查之后） | 经 `epoch_reader`/`outbound_screen` 两个**显式构造缝**（默认 None=无闸门，注入式测试引擎零行为变化）；create_app 生产装配接线真实现 |

- 挂点选择理由：回收/投递必须各有一个**确定性**边界。search 是上下文的唯一组装点；worker 的准入+投递双点覆盖"生成"（prepare）与"投递"（store）两段异步窗口；引擎 prepare 缝覆盖 `add()` 直调与迁移 `reverify` 共用的生成入口。
- 与既有 forget `memory_epoch` 关系：**两套 epoch 并存不混用**——forget epoch 管 tombstone 信任域（lifecycle），privacy epoch 管隐私时代（本模块）；search 末重查两者都查，任一漂移都丢结果集。
- 中间态诚实声明：投递边界丢弃时落库为 `status=needs_review` + `validation_status=validated`（内容确实通过质量门）+ `error_kind=privacy_epoch_changed`；`trusted`/可信回执均要求 `status='done'`，该中间态不会被任何读取面提升为可信。

## §6-3 旧记录外呼：逐项应答

**本地清单（`outbound_inventory.inventory_outbound`）**

- 只读盘点：注入路径 + SQLite URI `mode=ro&immutable=1` + `query_only`（镜像 `shadow.py`；测试断言源目录文件清单前后一致、无 `-wal/-shm/-journal` sidecar）。
- 记录类别（哪些会出站）：`user_text`、`candidate.quote`/`selected.quote`、固定 `questions`（full 模式）；`approved_quote`（minimal 模式）。
- **用户与助手数据分开统计**：assistant turn 本地归档、**outbound_candidates 恒 0**（"never sent" 明示）；user 侧按 status 直方图 + 候选/排除分解（`forgotten` 永不出站；`needs_review` 保留不自动重发——**不把旧状态批量改 validated**；pending+done 为候选，done legacy 经转换器 re-queue 后才会外呼）。
- 目的 provider：默认 jev-eval 本地包装器 → 其配置指向的远程 Jev 服务；凭据由包装器自持，本模块不接触。
- 建议调用上限：取自 `QualityConfig`（`max_text_chars`/`max_facts`/`jev_timeout`）+ 每记录 2 个有界批次（source-span 管线合同），给出 `total_batches_upper_bound = candidates × 2`。
- 清单只含计数/字段名/表名：测试断言报告序列化后不含任何原文、event_id、user_id。
- **113/43 等历史数字零固化**：全部是运行时盘点结果；本批未对生产库执行盘点（见未覆盖项）。

**秘密筛查（`secret_screen` / `build_outbound_dry_run`）**

- 七类形态（token/AWS/GitHub/JWT/bearer、key=value 与中文"密码是/密钥为"赋值、≥32 长 base64、邮箱、手机号、文件路径、私钥块）；命中**只返回类别名，永不返回秘密本体**（测试断言 secret 字符串不在结果与 dry-run 报告内）。
- 误报控制：正常中英文正文全部 clear（含"我们三个人后天动身"这类数字句不命中手机号）；启发式性质在 docstring 明示。
- `build_outbound_dry_run(record, mode)`：`full_user_text` = **现状如实路径**（确认 `quality.selection/completeness/no_facts/semantic_state` 均把整个 `user_text` 放进评估器 state——与审计 2026-10-09 第 67 行结论一致）；`minimal_quote` = 最小引用路径（仅 approved quotes；无批准 quote 的 legacy 记录 → `hold_needs_review / no_approved_quote`；含秘密的 full text 在 minimal 模式下**确实不再外泄**——scope 缩减差异有专项用例）。两种模式都过筛查、都产出 `send_authorized: False`、`network_calls: 0`。
- **真实调用入口显式不存在**：本模块无 transport、无 send 函数；闸门接线（create_app 的 `outbound_screen=outbound_inventory.secret_screen`）在**评估器调用之前**于 `prepare` 内拦截：命中 → needs_review 计划（`error_kind=outbound_screen_hit`）、评估器调用零次（测试断言）。

## 验证（命令、计数、退出码）

| 命令（cwd=仓库根，`.venv-memory` Python 3.11.15） | 结果 |
| --- | --- |
| `.venv-memory/bin/python -m unittest discover -s tests -p 'memory_privacy_epoch_test.py'` | **31/31 OK，exit 0** |
| `.venv-memory/bin/python -m unittest discover -s tests -p 'memory_outbound_inventory_test.py'` | **25/25 OK，exit 0** |
| `.venv-memory/bin/python -m unittest discover -s tests -p 'memory_*test.py'`（联合套件） | **361/361 OK，exit 0**（基线 305 = service 91 + authority 15 + purge 45 + reconcile 40 + migration 72 + preflight 19 + shadow 23；本批 +56 项） |
| `npm run test:memory-service` | **91/91 OK，exit 0**（零回归） |
| `npm run audit:secrets` | **PASS（0 undispositioned），exit 0**（新模块的 secret 形态正则字面量未产生新命中） |
| `python3 -m pytest tests/ -k "privacy or outbound or memory" -q`（按指令字面试跑） | **不可运行：`No module named pytest`**——本仓库从未安装 pytest；既有 memory 测试全部为 unittest 风格（`tests/memory_*_test.py` 头部与 `package.json` test:memory-* 脚本均如此），对齐的实际运行方式即上表 unittest 命令 |

- 负例/正例要点（31 项 epoch）：读写往返、bump 单调 [1..5]、用户隔离、原子写形态（0700/0600、无 tmp 残留、严格键集）、**bump 不删原生历史**（字节 digest 前后一致）、8 种篡改→UNKNOWN、损坏文件 bump 拒绝且文件原样、operator 清理后 bump 恢复（不复活旧值）、`filter_by_epoch`（era 精确匹配/未标记排除/UNKNOWN 查询为空/属性对象/原样返回）、非法 user_id 与非法 state_dir fail-closed；边界：search UNKNOWN→抛错且向量零查询、search 已知→正常、search 中途 reset/中途损坏→丢结果集、worker UNKNOWN→needs_review 且原文保留且零 evaluator 调用、**worker 中途 bump→批次丢弃 needs_review（prepare 恰一次/store 零次）**、稳定 epoch 路径不变（done）、assistant turn 不被 epoch 门拦截、引擎四缝（未接线无门/UNKNOWN hold/screen hit hold/双门 clear 正常/assistant 绕过）、create_app lifespan 真引擎接线断言。
- 负例/正例要点（25 项 outbound）：用户/助手分列计数、候选与排除分解、字段/provider/上限、上限取自 config、只读零 sidecar、缺库/坏库 fail-closed、报告零原文零 id；筛查：中英文正文 clear、token 五形态、中英赋值、长 base64（含过短 clear）、邮箱/手机号（含非手机号中文数字句 clear）、路径（含纯中文"目录和文件"clear）、私钥块、嵌套 payload、类别不含本体；dry-run：full/minimal 差异、scope 缩减使含秘密 full text 在 minimal 下 clear、双模式命中 hold 且报告无本体、无批准 quote hold、非法 mode/record fail-closed、报告零内容；零网络（`patch socket.socket` 下 inventory+screen+dry-run 全通过）。

- 真实模型/原文外呼/生产读写/launchd/微信外发/服务重启/生产库盘点：**均未发生**，与 r1 边界一致。

## 偏差与诚实边界（未覆盖项）

- **真实外呼零发生属设计而非已验证执行**：本批交付的是"本地清单+筛查工具+源码闸门"；"闸门在真实 Jev 调用前拦截"由代码位置与合成测试证明，真实 provider 链路下未执行过任何调用（本批禁止）。生产行为变化（见下）须经部署批生效并经真实链路验证。
- **生产接线随下次重启生效**：create_app 的闸门接线只在生产 memory 服务重启后生效（本批未重启）。重启后：含邮箱/手机号/路径/长 base64 等形态的 user turn 将落 needs_review 而非外呼——**这是对 §6-3 的意图性收紧**，上线前须经部署批确认接受该行为变化。
- **evaluator 现状如实披露**：接线筛查的默认模式是 `full_user_text`——评估器 state 确实携带完整 `user_text`（审计第 67 行同款结论）。若批准范围仅最小 quote：需先实现 minimal 状态构造（改 `quality.*_state` 或在引擎侧重组 payload）并测试，再调用；本批未做该改动。
- **迁移 CLI（`migration.py reverify`）的引擎不经 create_app**：其 `main(--allow-real-engine)` 自建引擎、不带闸门（`migration.py` 不在本批改动面）。旧记录真实外呼的闸门接线属迁移部署批；`engine.prepare` 缝已就绪，调用方传入 `epoch_reader`/`outbound_screen` 即得同款闸门。
- **生产记忆库未盘点**：盘点器已就绪（注入路径+只读），对生产库的运行时盘点属部署批；113/43 等数字在本批代码与测试中零固化。
- **向量元数据不打 privacy epoch 标**：`filter_by_epoch` 假定记录带写入时 epoch 标记；给向量/plan 打标涉及 store 绑定面，超出最小侵入范围。当前 reset 后旧 era 事实的可信性由"投递边界丢弃 + 读取时代 UNKNOWN/变更丢弃"双重兜底；带标记重建是后续内部会话协调方接入时的增量工作。
- **`_finish` 中间态配对**（投递边界丢弃时 `status=needs_review` + `validation_status=validated`）：如实反映"内容通过质量门、因隐私时代变更被 hold"；请审计方确认该配对或可接受性。
- **UNKNOWN 的有界重试**：worker 准入/投递边界的 UNKNOWN 走 `_fail` 有界重试（瞬时 FS 故障可恢复），与"失败保留 needs-review"不冲突（终态即 needs_review 且原文保留）；投递边界的"epoch 已变"是**即时终态**（不重试），因批次确属旧时代。
- **质量 UI 服务端认证代理（§6-2）不在本批**：属 AUI-03 同源 API 方案范围，本包零触碰。
- **bump 的并发合同**：单服务进程内 per-user 重置为 operator 低频操作；文件级原子写保证读者不见半写，但 bump 非 CAS（并发双 bump 后写覆盖先写）。当前调用面（operator 手动重置）无此并发；如需并发安全请后续批次加锁/版本校验。
- 测试文件含合成 secret 形态样例（如 AWS 文档公开的 EXAMPLE key、纯合成 sk-/ghp- 样例），非真实凭据；`audit:secrets` PASS。

## 要求审计方做什么

- 复核 §6-1 四挂点（search 入口/末重查、worker 准入/投递、引擎 prepare 缝）是否覆盖"生成/投递边界重新核对"的合同字面；特别是**投递边界"epoch 已变→即时终态 needs_review"**与**UNKNOWN→有界重试**的区分是否认可。
- 裁决：① `_finish` 中间态配对（needs_review+validated+error_kind）；② 引擎闸门采用显式构造缝（默认 None）而非全局默认的收敛是否认可；③ 中文赋值形态（"密码是 X"）等筛查启发式的误报容忍度（命中即 needs_review 保留，不删除）。
- 复核 §6-3：清单的用户/助手分列与"不把旧状态批量改 validated"分解是否满足第 84 行字面；`full_user_text` 现状如实披露是否充分；minimal_quote 路径的实现排期是否纳入下一批。
- 非返工前请确认：本包未触碰 `vendor/**`、`control-plane/**`、`gateway/**`、`config/**`、`package.json`、`docs/audits/**`、`docs/plans/**`、`migration.py`、`lifecycle.py`、`quality.py`；未执行任何 git 命令；基线 HEAD 为直读 `.git` ref 得到。
- 本包非 Grant/Approval；不授权真实外呼、生产盘点、服务重启或部署。
