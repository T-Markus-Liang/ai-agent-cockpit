# S04 隐私 Epoch r2：PE-F002/PE-F003 修复 + AUI-03 核对

日期：2026-10-09。批次：D80。HEAD 基线 `1e6ef85`（未提交 WIP 之上）。实施者：主模型（副模型派单通道三连故障：agent-91/92/93 provider 错误、agent-94 reviewer 503，均中途死亡，任务由主模型接管完成）。**本包为施工者自测交付，独立复核因通道故障未竟，按"待独立复核"登记。**

## 1. Finding 应答

### PE-F002：重置状态丢失被当新用户（P1）——修复

**反例（修复前实测）**：`bump_epoch` 后删除 `user.json`，`get_epoch` 返回 0（应 -1）。

**修复**（`services/memory/privacy_epoch.py`）：
- durable marker：`<state_dir>/privacy-markers/<user_id>.marker`（目录 0700/文件 0600/owner 校验/O_NOFOLLOW safe walk），与 `privacy-epochs/` 平级，目录级删除不连带。
- 新 API：`initialize_user(state_dir, user_id, initial_epoch=0)`（原子建立用户）、`is_user_established(state_dir, user_id)`（无痕迹才 False；目录损坏/权限错 fail-closed True）。
- `get_epoch` 语义重写：新用户（marker 与文件均无）→ 0；已建立用户文件缺失/父目录丢失/损坏/篡改/权限 0000 → `EPOCH_UNKNOWN`；文件有效而 marker 缺失 → 返回 epoch 并自愈补写 marker。
- `bump_epoch` 在 epoch 锁内原子写文件并确保 marker。
- **真实竞态修复**：macOS APFS 两进程并发 `O_CREAT` 同名锁文件偶发 ENOENT（纯 C 最小复现 131/400 失败，与 O_NOFOLLOW 无关）。`_locked` 对该 ENOENT 做 5 次有界重试（线性退避 5–25ms），不再把内核竞态误读为隐私状态丢失，也不引入无限等待。

**反例转回归**（`tests/memory_privacy_epoch_test.py` 39→51）：新增 MarkerEstablishedUserTests 12 项——新用户 0/未建立、initialize 建立、幂等 initialize、建立后删文件→UNKNOWN、bump 后删文件→UNKNOWN、**rm -rf privacy-epochs 后 marker 存活且 UNKNOWN**、bump 确保 marker、marker 自愈、chmod 0000→UNKNOWN、损坏 JSON→UNKNOWN、marker 权限 0700/0600、双进程并发 bump=[1,2] 且 marker 在。

### PE-F003：时代未绑定旧记录/重试/结算（P1）——修复

**反例（修复前实测）**：时代 0 写入事实 → `bump_epoch` → 时代 1 `search` 仍召回旧事实；持久化 plan 重试以新 epoch 为基线。

**修复**（`services/memory/service.py`、`services/memory/migration.py`）：
- plan 在 prepare 时绑定 `privacy_epoch`（向量效果之前）；turns 表新增 `privacy_epoch` 列；向量 metadata 打标。
- 持久化 plan 重试（process_one 与 migration reverify 两路）：plan 的 epoch ≠ 当前或未打标 → 终态 needs_review（`privacy_epoch_changed`），**零向量效果**，原 payload/plan 保留。
- store 完成后、`_finish("done")` 之前终结算复查：reset 竞态落 needs_review，物理向量永不提升为可信回执。
- `_trusted_receipts(user_id, current_epoch)`：只信任当前时代的 done/validated 回执；未打标（legacy NULL）或旧时代行 fail-closed 排除 → **reset 后旧时代事实 0 召回**（results 与 conflicts 同口径，conflicts 经 receipts 映射天然隔离）。
- 迁移 `reverify`：逐行取 copy 的当前 epoch（UNKNOWN 即 hold），fresh plan 打标、persisted plan 校验、`_write_receipt` 写列；`_QUALITY_ADDITIONS`/`_ensure_copy_schema` 补列。

**反例转回归**（`tests/memory_epoch_binding_test.py` 新增 8 项）：reset 后旧事实 0 召回；新时代事实正常召回（假内存全返回下按 ID 验证隔离）；unknown epoch search 拒答；旧时代持久化 plan 重试→needs_review 零向量；未打标 plan→needs_review；同时代 plan 正常重试；store 中 reset→needs_review 不可召回；metadata epoch=[0,1]。`memory_service_test.plan_dict` 补 `privacy_epoch: 0`（fixture 代表持久化 plan 合同）。

### AUI-03 安全投影核对（C 线，只读未施工）

交付 [docs/audits/2026-10-09-aui-03-security-projection.md](../audits/2026-10-09-aui-03-security-projection.md)：AUI3-F001（直连面 8 处 + bookmarklet 4321–4330 扫描新增）、F002（wechat-control CORS `*`、GET /status 断连拉起 bridge）、F003（decision 伪造 approvedBy 无 Auth）、F004（actor 头未绑 principal，RR-F003 已堵 viewer 写）、F005（goal token 入浏览器）。含最小施工顺序（同源只读代理先行）。

## 2. 验证证据（主模型亲自复跑）

| 命令 | 结果 |
| --- | --- |
| `node --test --test-reporter=spec tests/*.test.mjs` | 674/674 pass，exit 0，零 skip |
| `.venv-memory/bin/python -m unittest discover -s tests -p 'memory_privacy_epoch_test.py'` | 51/51，exit 0（3 连跑） |
| `.venv-memory/bin/python -m unittest tests.memory_epoch_binding_test` | 8/8，exit 0 |
| `.venv-memory/bin/python -m unittest discover -s tests -p 'memory_*test.py'` | 397/397，exit 0 |
| `npm run audit:secrets` | PASS，0 未处置命中 |
| 并发复现脚本（真实 test helper，10 轮） | 修复前 10/10 复现 ENOENT；修复后 10/10 [1,2] |

已知噪音如实登记：Python 退出期 `sys.meta_path is None` ImportError 与 unclosed `.lock` ResourceWarning（本地 Qdrant），exit 0，未修不称零警告。

## 3. 改动文件与 hash

| 文件 | SHA256 |
| --- | --- |
| services/memory/privacy_epoch.py | 见 evidence（见下） |
| services/memory/service.py | 见下 |
| services/memory/migration.py | 见下 |
| tests/memory_privacy_epoch_test.py | 见下 |
| tests/memory_epoch_binding_test.py | 见下 |
| tests/memory_service_test.py | 见下 |
| docs/audits/2026-10-09-aui-03-security-projection.md | bfcc9a25d8a055cfd94ad21b6a0b55ecfa788c5cd1ee74939232e293535444e1 |

证据文件：[source-ref.sha256](evidence/2026-10-09-s04-privacy-r2/source-ref.sha256)；全部 7 文件 SHA256 见该清单（privacy_epoch.py bc28cf71… / service.py 6ac82ad2… / migration.py 9d62392c… / privacy_epoch_test de41f3b4… / epoch_binding_test 14ce5e6c… / service_test 74bc7c60…）。

## 4. 未覆盖与剩余门槛

- 独立复核未竟（agent-94 503）：本包全部结论为施工者自测，待审计线程或通道恢复后的 reviewer 复核签字。
- 生产状态目录未触；真实 reset 流程在微信链路端到端抽验属 S05/S06 范围。
- 旧时代向量的物理清理（非召回隔离）不在本批——按设计原生历史永不删除。
- AUI-03 未施工；真实适配器/两 Worker/迁移 cutover/裁剪/真机/24h/发布未动。
