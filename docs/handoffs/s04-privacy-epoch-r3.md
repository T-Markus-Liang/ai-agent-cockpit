# S04 隐私 epoch r3：审计 P1×3 返工闭环（D84）

- 批次/revision：D84，基线 HEAD `0206c05`（D83 台账之后）
- 性质：源码 + 隔离合成测试返工；**未部署、未重启、未迁移、未触碰生产状态目录**
- 触发：审计线程 2026-10-09 晚裁决三个 P1 阻塞（全部在临时合成目录复现，未接触生产数据）
- sourceRef：`docs/handoffs/evidence/2026-10-09-s04-privacy-r3/r3-source-ref.sha256`

## P1-1 `initialize_user` 把已有 epoch 从 3 重置为 0

**反例（修复前实测）**：`bump_epoch` ×3 到 era 3 → `initialize_user(state, user)` → 文件被覆写为 epoch 0，era 3 事实重新可检索。

**修复**（`privacy_epoch.py` `initialize_user`）：在 epoch 锁内先查任何建立痕迹——epoch 文件存在（含权限异常，先 `_validate` 再拒绝）→ 抛 `PrivacyEpochError("already-established")`；文件缺失但 durable marker 在 → 抛 `PrivacyEpochError("epoch-state-missing")`。两者均不写任何字节。只有零痕迹的新用户可初始化。`_ensure_marker` 移入锁内、写在 epoch 文件之后，避免"刚建的 marker 把自己判成已建立"。

## P1-2 epoch 文件丢失后 `bump_epoch` 从 0 递增复活旧时代

**反例（修复前实测）**：era 3 → 删除 `privacy-epochs/<user>.json` → `bump_epoch` 读出 0 → 写 1 → 原 era 1 事实重新可检索（`get_epoch` 同时返回 1 而非 EPOCH_UNKNOWN）。

**修复**（`privacy_epoch.py` `bump_epoch`）：锁内 epoch 文件缺失时，先查 `is_user_established`；已建立（marker 在，含 fail-closed 的损坏/权限异常路径）→ 抛 `PrivacyEpochError("epoch-state-missing")`，**绝不从 0 重启计数**。零痕迹新用户保持原语义（bump → 1）。模块 docstring 的 bump 语义同步更新。操作员 reconcile 路径变为：恢复一份携带最后已知 era 的合法状态文件（带外进行，模块不提供"按调用方输入重写 era"的 API——那本身就是复活向量），此后 bump 从恢复值继续。

## P1-3 迁移 prepare/store 期间 reset 仍写 done/validated 与旧 era 回执

**反例（修复前实测）**：`reverify` 每行只在进入 `_reverify_one` 前读一次 epoch；fresh plan 绑定 era 0 后，store 期间 `bump_epoch` → 1，结算仍写 `done/validated` 且回执盖 era 0。

**修复**（`migration.py` `_reverify_one`，镜像 `service.py` live 管线的两段既有检查，错误码统一 `privacy_epoch_changed`）：

1. **store 前 fence**（`_persist_plan` 之后、`engine.store` 之前）：重读 `get_epoch(state_dir, user_id)`，为 `EPOCH_UNKNOWN` 或不等于绑定 era → 写 needs_review 回执、return，store 永不启动。
2. **store 后 fence**（stored/reused 计数校验之后、done 回执之前）：重读 epoch，变了 → `_delete_effects(engine, stored)` 尽力补偿（与 forget fence B 同机制）+ needs_review 回执，**绝不落 done/validated**。
3. `reverify` 调用点传入 `copy_dir` 作为 `state_dir`。

reset 落在 done 回执**之后**无需 fence：回执是历史事实记录（"era N 下已验证"），新 era 不召回该 era 事实，语义无害——与 forget fence 的"事后必须改判"不同类。

## 回归测试（+10，合成目录，零生产接触）

`tests/memory_privacy_epoch_test.py`（MarkerEstablishedUserTests +6，EpochCorruptionTests 改写 1）：
- `test_initialize_twice_fails_closed`（替代原幂等测试：第二次调用必须抛错，era 不变）
- `test_initialize_after_bumps_fails_closed_and_keeps_epoch`（审计原反例：era 3 拒绝重置）
- `test_initialize_with_explicit_epoch_on_established_user_fails`
- `test_initialize_with_marker_but_lost_file_fails_closed`（epoch-state-missing，读保持 EPOCH_UNKNOWN）
- `test_bump_after_file_loss_fails_closed_never_resurrects`（连续两次 bump 均拒绝，无复活）
- `test_bump_after_epoch_directory_loss_fails_closed`（父目录删除，marker 幸存）
- `test_bump_after_operator_reconcile_works_again`（改写：删文件≠reconcile，须恢复合法文件后才继续计数）

`tests/memory_migration_test.py`（新增 EpochDuringReverifyTests +5，仿 ForgetDuringReverifyTests 的 prepare/store 包装注入竞态）：
- `test_reset_during_prepare_holds_row_before_store`（store 未启动，memory.rows == []）
- `test_reset_during_store_compensates_and_holds`（效应被补偿，memory.rows == []）
- `test_epoch_file_loss_during_store_holds_row`（UNKNOWN 分支，同样补偿+扣留）
- `test_reset_before_reverify_validates_under_new_era`（负例对照：reset 在管线前 → 正常 validated，回执盖新 era）
- `test_no_reset_validates_under_initial_era`（负例对照：无竞态 → validated era 0）

## 验证证据（真实命令与退出码）

- `.venv-memory/bin/python -m unittest tests.memory_privacy_epoch_test tests.memory_migration_test` → 133 tests，OK，exit 0
- `.venv-memory/bin/python -m unittest discover -s tests -p 'memory_*test.py'` → **407/407**，OK，exit 0（前基线 397 → +10）
- `node --test tests/*.test.mjs` → **674/674 pass / 0 fail**，exit 0
- secret scan：tracked 命中均为合成 fixture（sk-ABCDEF…、RSA fixture、AWS 文档示例 AKIAIOSFODNN7EXAMPLE），WIP diff（AGENTS.md/x.lock 除外）零命中
- Python 退出期 Qdrant `sys.meta_path` / unclosed lock warning 保留登记，未写成零警告

## 覆盖 / 未覆盖与剩余门槛

- 覆盖：三个 P1 反例路径全部修复 + 每路径至少一个回归测试 + 两个负例对照防误伤。
- 未覆盖：P1-2 的残余微窗（stat 与 open 之间文件被并发删除）与同锁外删除者竞争——需要删除方配合锁的原语重设计，超出本次限定范围，登记为已知限制。
- 剩余门槛（0.3.0 完成条件不变）：本批为施工者（主模型）自测，**Jules/独立复核签字待补**；生产部署、真实 Worker/CLI、真实迁移与回退、24h 验证均未动。版本升级由审计线程复核本批后裁决。
