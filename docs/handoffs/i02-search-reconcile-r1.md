# 执行交接包：I02 service.search 接 reconcile（r1）

首次把 [reconcile 三态归约](../audits/i02-memory-reconcile-r2.md) 接进 `MemoryService.search`。审计对 reconcile 核心已限定接受并放行 fake 接线（"可fake接search，真实质量/隐私另验；生产route默认关闭"）；本批只做**结构化接线 + 合成测试**，不触生产质量/隐私/epoch 语义绑定。上一版可参照的邻近批次交接：[i02-memory-purge-r3](i02-memory-purge-r3.md)。

## 批次身份与固定来源

- batchId / revision：i02-search-reconcile / **r1**；状态：**READY_FOR_REVIEW**
- 执行方：subagent（deepseek-flash）施工；设计合同由主 Agent 定稿
- 新增/改动 hash（本批交付，sha256）：
  - `services/memory/service.py` = `87bffe307d5765256ef2f899532ae2f65d89a6dc1bb81758f466d9de11fb85cb`
  - `tests/memory_service_test.py` = `07b09372619c72220c85030d58d9d6a41ca92267020c92a3a604b8245768655d`（85 → 91 用例）
  - `tests/memory_migration_test.py` = `ed7c98f4ee8269e573ee816bb1219265edfc617755f054497ab869c7ffb40f20`（仅 5 处消费方读取改形，用例数与断言不变）
  - `scripts/test-memory-quality-live.py` = `727bc4503426a0dca1ed57fac826a15419e110041083cdc7398d52b5df4d6684`（仅 1 处消费方读取改形）
- 只读固定来源（未改）：
  - `services/memory/reconcile.py` = `862e4f9bd689582e2138c215a874393e65a7617eba4a3f1f1701f7f16be3f9f7`（被适配的冻结合同）
  - `docs/audits/i02-memory-reconcile-r2.md` = `480f36d5c0f1d35d8ce4e3ce168f328042431ad15c20b290f08b6f80cb7a2da7`
  - `docs/handoffs/i02-memory-purge-r3.md` = `752488e14c4ea645dca2a514d112596eb4dae028d44ed5adb06ccf065291a86d`（结构镜像）
  - `vendor/wechat-acp/src/storage/mem0.ts`（消费方参照，未改）= `mem0.ts:205–210` 只读 `.results` 后 `.filter(...).map(...)`
  - `package.json`（未改）= `1018caf317eb07bdac7aeb6a68d6d89c8385044246dd77b2f2a9f7f3024e1d24`
- 测试环境：全部为纯合成夹具（`FakeEngine` + in-memory 假向量行 + tmp 目录/内嵌 sqlite）。未跑 live 脚本、未触真实 SDK/生产/DB/launchd/真实用户数据、无外呼；未执行任何 git 命令；未改 `package.json`、`docs/audits/**`、`docs/plans/**`、`vendor/**`。

## 设计合同逐条落实

### 1. receipt 投影（新增私有方法 `MemoryService._reconcile_receipts`）

- **来源**：单条 SQL `SELECT event_id, payload, plan, stored_ids, created_at, forgotten FROM turns WHERE status='done' AND validation_status='validated'`——与 `_trusted_receipts` 同一信任口径（终态 done + validated）；**不**按 `forgotten=0` 过滤，`forgotten` 行照样投影进去由 reconcile 自己跳过，保持单一事实口径。
- **字段**：`event_id`（列）、`user_id`/`text`（payload 的 `user_id`/`text` 字段）、`created_at`（列）、`forgotten`（列）；`source` 取自 payload；`slot`/`supersedes` 从**存储的 plan JSON** 的 `slot`/`supersedes` 约定键读取，缺省即 **absent**（reconcile 对缺 slot 回退到 event_id）。
  - **实现偏差并说明**：设计草案写 `json_extract(payload,'$.user_id')`。实测 SQLite 的 `json_extract` 遇到**损坏 JSON 会抛错并导致整条查询失败**，与"单行坏数据不得打挂整次 search"直接冲突。故改为取回 `payload`/`plan` 文本后在 Python 内 `json.loads` 逐行解析（与既有 `_trusted_receipts` 同风格），坏行在解析处被隔离。
- **排序**：返回的 receipts 按 `(created_at, event_id)` 排序输出。
- **fail-closed（单行）**：某行 `payload`/`plan` JSON 损坏，或投影字段不满足 reconcile 合同（`event_id` 非空串、`text` 为 str、`created_at` 为有限数、`forgotten` 为 int/bool）时，`continue` 跳过——**该行不进 reconcile 输入**，且其 `stored_ids` **不进** memory-id→event 索引，于是对应 memory 一律不可被召回（unmapped = unknown），绝不静默当 current。
- **返回**：返回 `(receipts, index)` 二元组，`index` 把每条**成功投影** receipt 的 `stored`/`reused` 内存 id 映射到 `event_id`。二者来自**同一次查询**，保证"投影成功集合"与"索引成员"始终一致。
  - **实现偏差并说明**：设计草案把索引的建立列在 `search` 流程下、名字只提 `_reconcile_receipts(user_id)` "投影 receipt … 排序输出"。为满足"坏行 fail-closed"要求，索引必须与投影用**同一成功判据**，故由同一方法一并返回，避免两套判据漂移。语义完全覆盖设计意图。

### 2. search 流程接线（`MemoryService.search`）

原有顺序**原样保留**：`epoch_before` → `engine.search` 候选 → `_trusted_receipts` 绑定 → quote 精确匹配（`fact.quote == memory`）→ epoch 复查。在此之上：

- 由 `_reconcile_receipts` 得到 `(receipts, index)`；`reconcile(receipts)` 得三态。
- 逐候选：先按原信任+quote 绑定过滤（无 receipt 绑定 = 不召回，现状保持）；再取 `event_id = index.get(memory_id)`：
  - `event_id ∈ current` → 进 `results`；
  - `event_id ∈ superseded` → 从 `results` 剔除（被更正的旧事实不再召回）；
  - `event_id ∈ conflicts` → 从 `results` 剔除并逐条进 `conflicts` 列表（元素仅 `id`/`memory`/`event_id`，**不带 payload 全文**）；
  - `event_id` 缺失（unmapped/unknown，含投影失败行）→ 不召回。
- **reconcile 抛 `ReconcileError`** → 不 try/except，**如实上抛**；`/v1/search` 端点现有 `except Exception → HTTPException(503)` 兜底，绝不伪造空结果。

### 3. 返回形状（additive，向后兼容）

- `MemoryService.search` 返回 `{"results": [...], "conflicts": [...]}`；`results` 元素结构不变（`id`/`memory`/`score`）。
- HTTP `/v1/search` 直接返回该 dict（去掉旧的 `{"results": ...}` 手工包装）。
- `Mem0Engine.search` **未改**（仍返回 list）。
- **破坏面核查**：`grep` 全仓确认所有 `MemoryService.search` 消费方均已适配——`tests/memory_migration_test.py` 5 处、`tests/memory_service_test.py` 1 处、`scripts/test-memory-quality-live.py` 1 处，统一改为读 `["results"]`。Node 消费方只读 HTTP `.results`（`vendor/wechat-acp/src/storage/mem0.ts:205–210` 及 `scripts/test-memory-{kimi,recovery,live}.mjs`），新增 `conflicts` 键不破坏其读取，故 vendor 未改。

### 4. 测试

见下"验证"。新增 6 项 `SearchReconcileTests`，覆盖三态端到端、矛盾更正冲突、无更正边全 current、坏行 fail-closed、响应形状、ReconcileError→503；forgotten/epoch/quote 绑定/跨用户隔离由既有用例零回归覆盖。

### 5. 交接包

本文件。

## 关键 diff 摘要

- `services/memory/service.py`：
  - 新增 `import math` 与 `from .reconcile import reconcile`。
  - 新增 `MemoryService._reconcile_receipts(self, user_id) -> (receipts, index)`（投影 + 索引，单查询，坏行 fail-closed）。
  - 重写 `MemoryService.search`：在原信任/绑定/epoch 流程上叠加三态分类；返回 `{"results", "conflicts"}`；`epoch` 变更或无候选/非 list 分支均返回该 dict 空形。
  - `/v1/search` 端点改为直接返回 `service.search(query)`（`try/except` 503 兜底保留，覆盖 `ReconcileError`）。
- `tests/memory_service_test.py`：`from unittest.mock import Mock, patch`、新增 `from services.memory.reconcile import ReconcileError`；1 处消费方读形适配；新增 `SearchReconcileTests`（6 项）。
- `tests/memory_migration_test.py`：5 处 `service.search(...)` 读形适配（`["results"]`），无断言放宽。
- `scripts/test-memory-quality-live.py`：1 处 `service.search(...)["results"]`。

## 验证（命令与计数）

- `npm run test:memory-service` → **91/91 OK**（原 85 + 新增 6；`Ran 91 tests ... OK`）。
- `.venv-memory/bin/python -m unittest discover -s tests -p 'memory_*test.py'` → **267/267 OK**（原 261 + 新增 6；匹配子集：service 91 + reconcile 40 + purge 45 + migration_preflight 19 + migration 72）。
- `.venv-memory/bin/python -m py_compile` 通过：`services/memory/service.py`、`scripts/test-memory-quality-live.py`、`tests/memory_service_test.py`、`tests/memory_migration_test.py`。
- 未执行任何 live 脚本（本批禁止 live；`scripts/test-memory-quality-live.py` 仅做读形适配并字节编译通过）。

## 反向负例清单与原始结果摘要

新增 6 项（`SearchReconcileTests`；全部合成夹具，无 SDK/DB/网络/真实文件）：

| 用例 | 场景 | 结果 |
|---|---|---|
| `test_superseded_old_fact_is_not_recalled_new_is` | 同 slot（`user:nickname`）两事件，`new`(created_at 2000) `supersedes` `old`(1000)，均 validated | `results=["我的昵称是小林"]`、`conflicts=[]`（旧事实"小柚"被剔除） |
| `test_contradictory_correction_is_never_recalled_and_surfaces_conflicts` | 同 slot 两事件同 `created_at=1500`（不可排序的矛盾更正） | `results=[]`；`conflicts` 的 `event_id` 集合 = `{a,b}`；元素键恰为 `{id,memory,event_id}`（无 payload 全文） |
| `test_events_without_correction_edges_are_all_current` | 两事件无 slot/无 supersedes（各独立 slot） | 两条均召回、`conflicts=[]`（与现状一致） |
| `test_malformed_projection_rows_are_fail_closed` | `done+validated` 但 payload 损坏 / plan JSON 损坏，各挂一个真实存在的 validated 向量行（ghost） | `results` 仅含正常事件 id；两个 ghost 均不召回；`conflicts=[]` |
| `test_search_response_shape_includes_empty_conflicts` | 正常事件经 HTTP `/v1/search` | 200，body 含 `results` 与 `conflicts`，且 `conflicts==[]`、`len(results)==1` |
| `test_reconcile_failure_is_reported_not_masked` | 打桩 `services.memory.service.reconcile` 抛 `ReconcileError("invalid-receipt","duplicate event_id")` | HTTP 503（如实上报，未被伪造为空结果） |

零回归：`test_forget_done_event_is_durable_and_untrusted`、`test_recalled_forgotten_vector_is_excluded`、`test_forget_does_not_cross_users`、`test_memory_epoch_advances_once_per_new_op_not_per_retry`、`test_cross_user_isolation`、`test_cross_user_and_restart_receipts_not_recallable`、`test_needs_review_receipt_not_recallable_even_with_validated_vector_row`、`test_legacy_migration_unverified` 等均原样通过（含 forgotten/epoch/quote 绑定/跨用户隔离）。

## 未覆盖项与诚实边界声明

- **真实 slot/supersedes 绑定属后续**：本批 slot/supersedes 只在测试里通过存储 plan JSON 的约定键注入；现有 ingestion 路径（`_plan`/`_prepare_*`）**不产生**这两个字段，故"由质量/提取层真实产出 slot/supersedes"是宿主的后续工作，本层只做投影读取 + 缺省 absent 回退。
- **真实召回质量/隐私/epoch 语义绑定未验**：本批是结构化接线 + 合成测试，与审计放行口径一致；未经真实 Mem0 SDK/真实向量/真实并发验证，未跑任何 live。
- **conflicts 的 UI/通知未做**：`conflicts` 已随 `/v1/search` 暴露（元素 `id/memory/event_id`），但消费方渲染、用户提示、本地上下文协调均未涉及。
- **memory 服务自身仍是共享 token 认证**：`/v1/search` 等端点沿用单机共享 Bearer token；"每客户端化认证"属后续，本批未改。
- **生产未重启**：未重启/未接触生产服务与 launchd；生产 route 仍按审计默认关闭。
- **`_reconcile_receipts` 签名**：设计草案描述为"投影 receipt … 排序输出"，实现返回 `(receipts, index)`（同一查询同时给出内存索引，以满足坏行 fail-closed 一致性）。语义覆盖设计意图，已在"设计合同逐条落实"处显式声明。
- **SQL 投影实现偏差**：未用 `json_extract`，改用 Python 逐行 `json.loads`（理由：`json_extract` 遇损坏 JSON 会使整条查询报错，违背"坏行不打挂整次 search"）。已显式声明。
