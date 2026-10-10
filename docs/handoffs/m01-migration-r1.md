# 执行交接包：M01 旧记忆版本化私有副本迁移 converter（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。

## 批次身份与状态

- batchId / revision：m01-migration / r1
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（用户当面指派为执行方）；branch `main`；cwd `/Users/markus/ai-agent-cockpit`；实现由该会话 subagent（deepseek-flash，官方 V4.1 Flash）完成，主 Agent 负责设计契约、diff 复核与测试复跑
- 已读并确认协作协议：是。允许写入：功能源码/测试（本批仅新增）、`docs/handoffs/`、`docs/plans/0.3.0-resume.md`、台账执行方条目；不写审计方维护的计划/矩阵/裁剪文件
- 对应：M01（台账 D13 后续）、B05 前置；V08/17–22 的部分前置证据
- 本批目标：版本化私有副本 converter + 全合成守恒测试。明确不做：生产迁移、真实 Jev/模型外呼、服务重启、真实 113 条处理、commit/push

## 固定来源

- base HEAD：`e8c4317`；工作树含 0.3.0 在途历史未提交内容，本批为其中新增部分
- 本批新增文件（SHA256，2026-10-08 冻结）：
  - `services/memory/migration.py`（866 行）`679b2ae3…d1cb6`
  - `tests/memory_migration_test.py`（958 行）`3b790359…b9a8e`
  - `package.json`（新增 `memory:migration-copy` 一行）`5b0ca353…f60eb`
- 直接依赖（历史共享未提交内容，非本批新增，仅 import 未修改）：`service.py be325f69…`、`quality.py 858d3a6e…`、`lifecycle.py 8d71c3d0…`、`migration_preflight.py cee181ac…`、`tests/memory_service_test.py 486886d2…`、`tests/memory_migration_preflight_test.py 5a885cf0…`
- 依赖/运行环境：Python 3.11（`.venv-memory`）、Mem0 SDK 2.2.1（既有 lock）；无新依赖、无生命周期 scripts
- 这些来源已冻结；审计期间若漂移，以新 revision 重交
- 自测前后 sourceRef 一致（hash 于 2026-10-08 复测前后各取一次）
- 内部 subagent 两轮复核属执行方内部质量关，**不充当产品独立审计 Evidence**；正式独立审计以审计 AI 的 `docs/audits/` 为准

## 实现、自测与证据

| 要求/Case（协议§7） | 当前实现 | 验证命令与 cwd | 退出码/断言/效果 | evidenceRef | 尚未覆盖 |
| --- | --- | --- | --- | --- | --- |
| §7.1 sourceRef 固定 | 上表文件级 SHA256 + 新增/共享区分 | `shasum -a 256`（仓库根） | 清单见上 | 本文件 | — |
| §7.2 源只读/目标拒绝/WAL 守恒 | `_open_readonly` + `Connection.backup()`；`_check_target_alias`（同目录/hardlink/同 inode→`target_alias`）；`_is_known_copy` 未知库→`unknown_existing_db`；`verify_conservation` 源侧只读 | `memory_migration_test.py` TargetGuardTests / SnapshotTests / ConservationTests | 28/28 OK；WAL 未 checkpoint 源主库与 -wal 逐字节不变；被拒时源字节不变 | 同上 | "冒名库"（有 turns 基线列但内容不符）仅靠 conservation 兜底，未加指纹校验 |
| §7.3 dry-run×2/重入/漂移/篡改/半写入/manifest 漂移 | dry_run 不写 turns/journal；journal digest 键控续跑；`_assert_consumable` 区分半写入（可重做）与源新增行（拒绝）；manifest converterVersion 不符→`manifest_version_drift` | IdempotencyTests / ResumeTests / HalfWriteTests / SourceDriftTests / ManifestDriftTests | 全部 OK；spy 调用计数证"只重跑丢日志的行" | 同上 | 重复 digest 行的 journal 边界未覆盖（记录项） |
| §7.4 助手归档/用户重验证/不直升/tombstone/秘密/needs-review | assistant→`assistant_archived` 不可召回；user→ForgetStore.match 三级（event_id/source_hash/quote_hash 各有测试）→ 未命中置 pending；凭证行→needs_review 且 `evaluator.calls==[]` | AssistantArchiveTests / TombstoneTests / PrivacyTests | 全部 OK；evaluator 断言为零调用（最强形式） | 同上 | 非 done assistant 行统一归档的语义边界（记录项） |
| §7.5 向量效果/回执结算/store 故障恢复/召回原文绑定 | reverify 写 `_save_plan` 超集回执；`engine.store` 失败→`store_error` 可重试子集，语义/凭证类终态不重试；validated 经 `validate_plan` quote 绑定后可被 MemoryService.search 召回 | ReverifySuccessTests / ReverifyFailureTests / PartialStoreTests | 全部 OK；失败行原文不丢，二次 reverify 恢复并召回 | 同上 | `FakeMem0.search` 忽略 query（替身取舍，验的是 trust 管线非检索相关性） |
| §7.6 联合结果/环境/未覆盖 | 三命令本批复跑；macOS 本机，Python 3.11 venv；未触碰生产目录/真实模型/真实 jev-eval/服务重启 | `python -m unittest discover -s tests -p 'memory_migration_test.py' -v`（28 OK）；`-p 'memory_*test.py' -v`（132 OK）；`npm run test:memory-service`（85 OK），执行方主 Agent 亲自复跑两轮一致 | exit 0 ×3 | 同上 | 真实 113 条迁移、43 用户条目的真实 Jev 重验证、副本→生产迁移与服务重启（均须用户具体批准） |

- 真实模型/原文外呼/生产读写/原生会话/微信外发：**均未发生**；无任何新增授权使用。
- 失败、部分结果和不明副作用：无；实现偏差已在本文件"尚未覆盖"列如实登记。
- 活动进程/job/handle：无（本批无后台任务）。
- 数据守恒、回退和恢复方法：snapshot 不改源（只读+backup API）；convert 结束自动 conservation 校验，不一致抛 MigrationError；副本可整体删除重来，源库零依赖本批。
- 日志/私有 artifact 位置：无（测试均用 tempfile，已清理）。
- 状态分列：实现完成 ✅（本批范围）；自测通过 ✅（上表三命令）；独立审计：⏳ 待审计 AI；部署/真机：未做（不在本批范围）。

## 要求审计方做什么

- 审计范围与重点风险：`services/memory/migration.py`（866 行）与 `tests/memory_migration_test.py`（958 行）。建议重点：① backup 快照一致性；② 目标拒绝完备性（alias/未知库）；③ reverify 凭证屏障顺序与注入边界（CLI `--allow-real-engine` fail closed）；④ `_assert_consumable` 的半写入 vs 源漂移判定；⑤ 守恒判定的完备性。
- 已知不足/需决定的方案：重复 digest 的 journal 边界；非 done assistant 行归档语义；"冒名库"指纹校验是否值得加；`memory:migration-copy` 用系统 python3（非 venv）是否接受。
- 等待期间将继续的无冲突独立任务：M02 / I03a–c（后台 ownership、取消范围、provider/fallback/ContextAssembler、legacy route）的源码实现与隔离测试，与记忆模块无文件冲突。
- 非返工 revision（r1 为首次交接）。
