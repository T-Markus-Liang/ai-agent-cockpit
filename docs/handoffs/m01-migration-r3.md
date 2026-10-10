# 执行交接包：M01 migration r3（按 Finding 返工：F001 未关闭的两点）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包为 r3 revision，回应 [m01-migration-r2 审计](../audits/m01-migration-r2.md)（CHANGES_REQUESTED，仅 M01-F001 两点未关闭）；r1/r2 的失败证据与旧交接（`m01-migration-r1.md`、`m01-migration-r2.md`）保留不覆盖。

## 批次身份与状态

- batchId / revision：m01-migration / **r3**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；本返工由该会话 subagent（deepseek-flash，官方 V4.1 Flash）完成，主 Agent 定返工设计、亲自复跑
- base：分支 `feat/0.3.0-progress`（PR #1），r1 审计基线 `e8c4317`
- 范围：仅返工 **M01-F001 的两点**（目标准入时序 / 无 manifest 忠实快照判定）+ 根级 symlink 豁免收窄；F002/F003/F004 的 r2 实现本包未改动（见"未覆盖项"）
- 铁律遵守：全部夹具为自建 tmp 合成库；未 chmod/触碰任何真实用户文件；未触碰生产 DB/服务/launchd；无网络/模型/微信外呼；未改 `package.json`；未执行任何 git 命令

## r3 固定来源（新 hash）

| 文件 | 行数 | sha256（完整） | 上一版 |
| --- | --- | --- | --- |
| `services/memory/migration.py` | 1302 | `2ff2d84c62dab80478f5ddc3449005fe8632ca89ad2fe9ea13028443ea2ef27e` | r2 `1caa154d…f187912`（1219 行） |
| `tests/memory_migration_test.py` | 1743 | `29de6c0fa2a99eecffb5825c980c13ca619a1d0833ea993288cc666042d7b9de` | r2 `2484bca5…a9bf84`（1535 行，57→72 用例） |

直接依赖（历史共享、本批**未修改**，仅 import）：`migration_preflight.py cee181ac112f2597ab9eaf53243655b05404accc55581acc41a59b3a74c36783`、`service.py be325f694cdad15c2f43f8673c88d3c6998417f8c592789a7038a4d654e39b37`、`quality.py 858d3a6e08da0b3da9ddecb95fdd40227ca318c57d993d507ebe68520ab7a35b`、`lifecycle.py 8d71c3d09d16a759211f94a81634259ffcc879066ab2278e104cdc5ec9504926`。`package.json` 未改动。

## Finding 逐条处置

### M01-F001（r2 两点未关闭）→ 本包全部返工

#### 点1：未知目标准入检查在 makedirs/chmod 之后（r2 :316–321）

- **修复**：`snapshot()` 中**所有**读/身份/来源校验前移到任何 `mkdir`/`chmod`/DDL/删除之前。顺序改为：`_validated_source` → `_check_target_alias` → `_validate_target_path` → `_source_provenance`（源只读）→ **目的地三分类准入** → 之后才 `os.makedirs`/`os.chmod`/`_backup`。
- **三类目的地**：① `copy` DB 不存在（`os.path.lexists(copy_path)` 为假；目录不存在或真无 `ingest.sqlite`）→ 可新建；② DB 存在且通过 `_is_known_copy`（我方 manifest+provenance，或无 manifest 的**完整**忠实快照）→ 按副本恢复/重入；③ 其余 → 拒绝，**零元数据变化**（不 mkdir/chmod/写/删）。
- **理由**：审计复现路径 `snapshot(source, 0755 未知库)` 原先把目录 chmod 0700 后才抛 `unknown_existing_db`；现在 `unknown_existing_db` 在任何写入前抛出，被拒目标 bytes/mode/目录项逐项不变。

#### 点2：无 manifest 的 faithful snapshot 只做子集判定（r2 :256–270）

- **修复**：`_copy_is_faithful_snapshot` 改为**完整 immutable 事件集合相等**：`set(target_event_ids) == set(source_event_ids)`，且每个 id 的 `(digest, payload, created_at)` 三元组与源逐项相等。空 source 由**显式集合比较**处理（两侧皆空则相等），不再因 `for` 循环为空而误判 True。
- **subset/空集不成立**：空基线目标（source 1 行、target 0 行，即审计探针 2）→ 集合不等 → 拒绝。
- **half-copy 恢复的身份门槛**：新增 `_is_stale_source_subset`（非空、逐行字节忠实、event_id 集合为源的**真子集**）；此类目标只在**无 manifest** 时判 `conservation_violation` 拒绝。`_classify` 的"补行"恢复增加二次门槛：`event_id` 缺失于副本时，只有该 `digest` 已记录在 journal（明确 resume marker）才允许 `_insert_row` 恢复，否则 `conservation_violation`。即恢复必须持有明确 converter 来源（manifest provenance）/journal 身份标记，subset 本身不成立。
- **根级 symlink 豁免收窄**：`_symlink_components` 原豁免"任意 `/` 直接子目录 symlink"；现改为仅豁免 `_ROOT_SYSTEM_ALIASES`（`/var→/private/var`、`/tmp→/private/tmp`、`/etc→/private/etc`）中**已核对 realpath 且属主为 root** 的项（`_is_root_system_alias`）。任意其它 `/` 级 symlink 一律按 `target_symlink` 拒绝。

## 关键 diff 摘要（r3 相对 r2）

```text
services/memory/migration.py
+ _ROOT_SYSTEM_ALIASES = {"/var":"/private/var","/tmp":"/private/tmp","/etc":"/private/etc"}
+ _is_root_system_alias(path)                 # 根级直接子项 + 白名单名 + realpath 匹配 + uid==0
~ _symlink_components: "parent != os.sep" → "not _is_root_system_alias(current)"
~ _copy_is_faithful_snapshot:
    - for event_id,triple in target_rows: if source_rows.get(event_id)!=triple: return False
    - return True                              # 子集/空循环误判
    + if set(target_rows) != set(source_rows): return False
    + return all(source_rows[e]==t for e,t in target_rows.items())
+ _is_stale_source_subset(copy_path, source_rows)   # 非空 + set(t) < set(s) + 逐行忠实
~ _is_known_copy docstring（明确"完整"快照）
+ _has_manifest(copy_dir)                     # manifest 文件是否存在（含损坏）
~ snapshot():
    - provenance … ; os.makedirs(); os.chmod(copy_dir,0700); if exists(copy_path): if not known: raise
    + provenance … ;
    + if os.path.lexists(copy_path):
    +     if not _is_known_copy(...):
    +         if not _has_manifest(copy_dir) and _is_stale_source_subset(...):
    +             raise _fail("conservation_violation")
    +         raise _fail("unknown_existing_db")
    + os.makedirs(copy_dir, mode=0o700, exist_ok=True); os.chmod(copy_dir, 0o700)
~ _classify(): 缺行恢复前新增 `if digest not in journal_set: raise _fail("conservation_violation")`
```

## 反向负例清单与原始结果摘要（新增 15 例，全部把审计复现路径固化为测试）

`tests/memory_migration_test.py` 新增：

- `TargetRefusalBeforeWriteTests`（点1，复现审计探针 1）
  - `test_unknown_target_0755_is_refused_without_touching_mode`：0755 未知库（无 turns 表）→ `unknown_existing_db`，且 copy DB bytes、目录 mode(0755)、目录项逐项不变。
  - `test_unknown_target_0770_is_refused_without_touching_mode`：同上，mode 0770。
  - `test_unknown_target_0755_via_convert_is_refused_without_change`：`convert()` 入口同样拒绝、零变化、不写 manifest。
- `FaithfulSnapshotSetEqualityTests`（点2，含审计探针 2）
  - `test_empty_baseline_target_snapshot_is_refused`：source 1 行 / 独立 0 行目标 → `snapshot` 拒绝（`unknown_existing_db`），bytes/目录项不变。
  - `test_empty_baseline_target_convert_is_refused_without_backup`：`convert` 拒绝，目标仍 0 行，不写 manifest（证明那 1 行未被静默"接受而不备份"）。
  - `test_non_empty_subset_target_is_refused`：source{e1,e2} / 独立忠实子集{e1} → `conservation_violation`，零变化。
  - `test_half_copy_without_marker_is_refused`：无 marker 半副本 → `conservation_violation`，零变化。
  - `test_half_copy_with_manifest_marker_is_resumed`：**有** manifest marker 的半副本 → 接受并恢复丢行（e1 回到 pending）。
  - `test_complete_same_source_snapshot_is_accepted_and_reentrant`：完整同源快照接受且可重入。
  - `test_complete_independent_same_schema_copy_is_accepted`：完整、逐行字节忠实的独立同源副本接受且守恒通过。
  - `test_empty_source_with_empty_target_is_accepted`：空 source + 空 target 接受（显式空集合，非空循环侥幸）。
  - `test_empty_source_with_nonempty_target_is_refused`：空 source + 非空 target 拒绝。
- `RootAliasExemptionTests`（symlink 收窄）
  - `test_unknown_root_child_name_is_not_exempt`、`test_alias_named_symlink_below_root_is_not_exempt`、`test_verified_root_alias_is_exempt_only_when_it_is_a_system_alias`。

独立探针（把审计 `r2-memory-review.py` 的两条复现路径改写为"修复后应拒绝"）`/tmp/m01-r3-probe.py`，原始输出：

```json
{"realModels": false, "productionTouched": false, "observations": [
 {"probe":"M01-F001-r3-unknown-target","error":"unknown_existing_db",
  "beforeMode":"0o755","afterMode":"0o755","modePreserved":true,
  "bytesPreserved":true,"entriesPreserved":true},
 {"probe":"M01-F001-r3-empty-subset","error":"unknown_existing_db",
  "acceptedManifestlessIndependentTarget":false,"bytesPreserved":true}]}
```

对照审计 r2 结果（`probe-results.json`）：点1 由 `afterMode=0700（目录被改）` 变为 `0755（不变）`；点2 由 `acceptedManifestlessIndependentTarget=true` 变为 `false`。

## 验证（主 Agent 亲自复跑，全绿）

| 命令 | 结果 |
| --- | --- |
| `.venv-memory/bin/python -m unittest discover -s tests -p 'memory_migration_test.py' -v` | **72/72 OK**（57 原用例不回归 + 15 新负例/正例） |
| `.venv-memory/bin/python -m unittest discover -s tests -p 'memory_*test.py'` | **261/261 OK** |
| `npm run test:memory-migration-preflight` | **19/19 OK** |
| `.venv-memory/bin/python /tmp/m01-r3-probe.py` | exit 0；两条审计复现路径均被拒绝、零元数据变化 |

关键输出摘要（节选）：

```text
Ran 72 tests in 0.447s
OK
Ran 261 tests in 1.063s
OK
Ran 19 tests in 0.253s
OK
```

## 偏差与诚实边界（未覆盖项）

- **本包只关闭 F001**。`M01-F002/F003/F004` 的 r2 实现原样保留、未在本轮改动；审计"对全部真实 SDK 异常/补偿/进程间隐私 epoch 未独立完整验证"的限定观察仍成立。
- **一处需审计裁决的语义取舍**：无 manifest 且目标为**非空、逐行字节忠实的真子集**时，本包判 `conservation_violation`（不是 `unknown_existing_db`），以保留 r2 既有 `SourceDriftTests.test_source_row_added_after_snapshot_is_refused`（源在快照后增长）的语义与 57 项不回归；空目标/非匹配目标仍判 `unknown_existing_db`。若审计要求子集也统一为 `unknown_existing_db`，请裁决后我再改（会随之调整该漂移用例的期望错误串）。
- **无 manifest 但有 journal 的半副本**（本包按 manifest 准入），公开 API 不可达——`convert` 先写 manifest 再写 journal，故 journal ⟹ manifest；`_classify` 的 journal 门槛作为二次守卫（点2 要求）。未构造该不可达组合的固定用例。
- **根级 alias 的攻击面**：`_is_root_system_alias` 仅做了函数级判定测试；"攻击者伪造 root 属主的 `/` 级 symlink"场景需 root，未实测（本机无提权）。
- **未核验（保留）**：真实 113 条历史迁移、43 用户条目真实 Jev 重验证、副本→生产迁移与按 cutover/restart 落地——均须 Markus 具体批准，本包不构成该等授权。
- 真实模型/原文外呼/生产读写/原生会话/微信外发：**均未发生**；无新增依赖、无后台任务、无 launchd 变更。

## 要求审计方做什么

- 按 M01-F001 两点复核 r3 时序（拒绝先于任何写入）与完整集合相等判定；特别裁决上列"真子集 → `conservation_violation`"的语义取舍。
- 复核根级 symlink 白名单（`/var`、`/tmp`、`/etc` + root 属主）是否满足"收窄到已核对 alias/owner"。
- 本包非 Grant/Approval；不授权生产数据迁移、原文外呼、部署或物理删除。
