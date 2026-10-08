# 执行交接包：memory 服务每客户端认证（G4 一致性收尾 / r1）——共享 token → 每客户端 principal

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包把 **memory（Mem0 OSS）服务**的单一共享 bearer token 换成与 goals/control-plane 相同的每客户端 principal 认证，作为 G4 一致性收尾：`services/memory/authority.py` 是 `control-plane/request-authority.mjs` 的 **Python 镜像**（同一文件 schema、同一 digest 算法、同一 RR-F004 安检前置语义），使**同一份 `authority.json` 可供 Node 与 Python 两侧消费**。前序交接与审计文件保留不覆盖。

## 批次身份与状态

- batchId / revision：i02-memory-per-client-auth / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；branch `feat/0.3.0-progress`；cwd `/Users/markus/ai-agent-cockpit`；subagent（deepseek-flash）实现，主 Agent 定稿设计合同、亲自复跑
- 已读并确认协作协议：是。本批允许写入且**实际写入**：`services/memory/authority.py`（新文件）、`services/memory/service.py`、`tests/memory_authority_test.py`（新文件）、`tests/memory_service_test.py`、`scripts/test-memory-live.mjs`、`scripts/test-memory-kimi.mjs`、`scripts/test-memory-recovery.mjs`、`docs/handoffs/i02-memory-per-client-auth-r1.md`（新文件）。**未改** `package.json`、`docs/audits/**`、`docs/plans/**`、`config/wechat-acp.json`、`vendor/**`、`control-plane/**`、`gateway/**`、任何生产服务/DB/launchd/真实用户文件
- 对应：M02 / G4 一致性收尾（与 D41 goals 每客户端化、D50 RR-F003 角色矩阵、D51 RR-F004 安检前置同口径）；验收：memory 服务按每客户端 principal 认证；每客户端独立 token（A 通过、B 吊销/过期即 401、未知 401）；轮换不重启即生效；角色×动作矩阵（viewer 只读、chief 读+ingest 不能 forget、operator 全通含 forget）；缺/坏 authority 文件 fail-closed 500 且 health 200；RR-F004 镜像（chmod 漂移暖缓存仍拒、不回落旧缓存）
- 本批目标：memory 服务从「共享 token（`<stateDir>/api-token`）+ 恒定时间比较」改为「每请求从权威 authority 文件认证每客户端 principal + 角色矩阵授权」。明确不做：生产重启/部署、真实凭据轮换/配对、把 wechat bridge（`vendor/wechat-acp/src/storage/mem0.ts`）与「bridge mem0 客户端」实际迁移到 per-client token、revoked 条目修剪、commit/push

## 固定来源

- base HEAD：`977fb764a20b36907b7486febf05b17f5db747d8`（branch `feat/0.3.0-progress` 的 ref 值；该值由**直读** `.git/HEAD` → `.git/refs/heads/feat/0.3.0-progress` 得到。本批**未执行任何写/变更型 git 命令**；仅为定位分支执行了只读的 `git branch --show-current` 与 `git status --short`，验证命令 `npm run audit:secrets` 内部亦调用只读 `git ls-files`——三者均不改变仓库状态）
- **镜像参考**（本批只读、未改）：`control-plane/request-authority.mjs` `6e602a674a5ace9b3443dc0901f948c15662d6c654fe5823e9b83d636de8844d`（216 行；注：与 [m02-identity-lifecycle-r2](m02-identity-lifecycle-r2.md) 记录的 `a279820e…`/210 行不同，其间已被后续批次更新，本批以其**当前**内容为镜像基准）；`gateway/goals.mjs` `3f4521ab0dd9a760827817cf68abf6b3b05f50e630c7f298d48d96390cf2ce39`（168 行；角色矩阵 D50 口径参考）
- 变更文件（SHA256，2026-10-08，`shasum -a 256`；**旧值 = 本批前**）：
  - `services/memory/service.py`
    - 旧 `87bffe307d5765256ef2f899532ae2f65d89a6dc1bb81758f466d9de11fb85cb`（974 行）
    - 新 `c4e25f28add12e010a06cf1ce7b09b007d7f8f7815a6137653eb1fdfa3dfdcd1`（1006 行）
  - `tests/memory_service_test.py`
    - 旧 `07b09372619c72220c85030d58d9d6a41ca92267020c92a3a604b8245768655d`（1564 行）
    - 新 `18e6897c75594d7f46e26a88d13c292a7cd754bd19129e61dd5d597c90ce7b3b`（1586 行；**91 项不变**）
  - `scripts/test-memory-live.mjs` 旧 `734a47fd52d8a6ae4ac10f60fae56a2f1aedbc5efb5bdf5b7a3e0a5db574d2d2`（49 → 57 行）
  - `scripts/test-memory-kimi.mjs` 旧 `d190eced55e1d11e82e8cf8eda0fb51de5cf1ae5307e47264f6785651406339d`（63 → 69 行）
  - `scripts/test-memory-recovery.mjs` 旧 `9f3f925415de3be6902bdeb93dd3446d4dfd5a7d8336dcf0a5acf0c81c4e4503`（88 → 94 行）
- 新建文件（SHA256）：
  - `services/memory/authority.py` `e341ec4374e30decc586c6dae304ae04ddc70a8e8fdb8c04911fa2ce1032b952`（265 行）
  - `tests/memory_authority_test.py` `ca328f1ac3c9c6b0ecd07c06e538646a5fb170caa39d1d803beeafd750236409`（322 行，15 用例）
  - `docs/handoffs/i02-memory-per-client-auth-r1.md`（本新文件）
- `package.json` 未改：`test:memory-service` = `discover -s tests -p 'memory_service_test.py'`（91 项不变）；新文件 `memory_authority_test.py`（前缀 `memory_`）被联合 glob `memory_*test.py` 自动纳入，故联合套件由 **267 → 282**
- 依赖：**无新依赖**（标准库 `hashlib/hmac/json/math/os/re/stat/time` + 现有 fastapi/pydantic）；未改 `requirements.txt` / lock

## 设计合同逐条落实

### 1. `services/memory/authority.py`：Node `request-authority.mjs` 的 Python 镜像

- **同一文件 schema**：`{version:1, principals:[{id, role, tokenDigest, expiresAt?, revoked?}]}`；`1 ≤ 数量 ≤ 16`；`id` 匹配 `^[A-Za-z0-9:_-]{1,200}$` 且唯一；`role ∈ {viewer, coordinator, chief, operator}`；`tokenDigest` 匹配 `^[a-f0-9]{64}$` 且唯一；`expiresAt` 存在时须为有限非负数值；`revoked` 存在时须**恰为 `true`**（吊销条目保留为吊销证据，永不匹配，绝不静默删除）；**未知键拒绝**。任何违规 → `AuthorityError('AUTH_CONFIGURATION', 500)`，与 Node 逐条一致。
- **digest 算法逐字一致**：`sha256(bearer token 字符串)` 的**小写 hex**（`token_digest()`，Node 为 `createHash('sha256').update(token).digest('hex')`）。因此同一份 `authority.json` 可被 Node 与 Python 同时消费。
- `create_request_authority(document, clock=…)`：解析后的文档 → 严格 authority（Node `createRequestAuthority` 镜像）。`authenticate(headers)`：Bearer 头形状 `^Bearer [A-Za-z0-9_-]{32,256}$` → digest → **`hmac.compare_digest` 逐 principal（无提前退出）** → `revoked`/`clock() >= expiresAt` 跳过 → 无匹配 `AUTH_REQUIRED`（401）。
- `LiveAuthority(path, *, clock=…)`：`authenticate` **每次都** `os.open(path, O_RDONLY|O_NOFOLLOW)` + `os.fstat`，在同一 fd 上**先**完成全部安全校验（普通文件、`mode & 0o077 == 0`、uid 匹配、`size ≤ 16384`），**通过后**才比较变更键 `ino:mtime:size` 命中缓存（缓存只省 JSON 解析、**绝不省安检**）；校验失败/文件消失/符号链接/JSON 非法/schema 非法 → `AuthorityError('AUTH_CONFIGURATION', 500)`，**绝不回落旧缓存**；只读属性 `generation` 供观测（成功重解析计数）。语义逐条对齐 Node `createLiveRequestAuthority`，含 RR-F004「安检前置于缓存」。
- `write_authority_file(path, snapshot)`：**先 `create_request_authority(snapshot)` 校验、后落盘**；序列化后按 `MAX_AUTHORITY_BYTES`(16384) 复核；写 `<path>.<16hex>.tmp`（`O_CREAT|O_EXCL`，0600，`fsync`）后 `os.replace` 原子替换；任何失败清理 tmp 并抛 `AUTH_CONFIGURATION`。与 Node `writeAuthorityFile` 同合同。

### 2. `services/memory/service.py` 接线

- **删除**共享 token 生成/读取（原 `:376-383` 的 `api-token` 创建与 `self.token`）与 `authorize` 的恒定时间比较（原 `:928-931`）——**不保留兼容路径**。移除已无用的 `hmac`/`secrets` import。
- 改用 `LiveAuthority`：文件路径 = 环境变量 `MEMORY_AUTH_FILE` 或 `state_dir/authority.json`（在 lifespan 中装配一次；`LiveAuthority` 每次请求自校验，轮换/吊销/过期无需重启）。
- 认证失败 **401**、配置/文件问题 **500**（如实，无共享 token 回退）；`/health` **保持免认证**。
- **角色授权矩阵**（对齐 goals D50 / RR-F003 口径）：

  | 动作 | 端点 | viewer | coordinator | chief | operator |
  | --- | --- | --- | --- | --- | --- |
  | read | `/v1/search`、`/v1/status`、`/v1/controls` | ✅ | ✅ | ✅ | ✅ |
  | ingest | `/v1/turns` | ❌403 | ❌403 | ✅ | ✅ |
  | forget | `/v1/forget`（不可逆删除） | ❌403 | ❌403 | ❌403 | ✅ |

  授权失败 **403**，在端点业务体（任何状态变动）之前；`authorize` 返回 principal。各端点现有业务语义不变。

### 3. 测试

- `tests/memory_service_test.py` **适配**（91 项不变）：`setUp` 写合成 authority 文件（`write_test_authority`，`tokenDigest = sha256(已知 token)`，mode 0600），token 由测试夹具持有（`self.token`），不再读 `service.token`；`test_private_permissions` 校验 `db_file` 与 `authority.json` 均 0600；`test_restart_preserves_pending_receipts` 去掉旧 token 相等断言；内联 service 处补写 authority 文件。
- 新增 `tests/memory_authority_test.py`（15 用例）：schema 负例、Bearer 形状/digest、每客户端 revoked/过期/未知、轮换不重启、RR-F004（`chmod 600→644` 且断言 ino/mtime/size 三者不变 → 暖缓存仍 500、`generation` 停住、恢复 0600 后通过）、危险权限首次即拒 + 符号链接拒（generation 0）、缺/坏/相对路径 fail-closed、`write_authority_file` 先校验后落盘（目标逐字节不变、无 `.tmp` 残留、0600）、HTTP 角色矩阵、403 零副作用、吊销不重启落地、缺 authority 文件业务 500 / health 200、无 `api-token` 文件生成。

### 4. live 脚本（最小适配，**未实际运行**）

`scripts/test-memory-live.mjs`、`test-memory-kimi.mjs`、`test-memory-recovery.mjs`：HTTP bearer token 改从 `process.env.MEMORY_AUTH_TOKEN` 读取（缺失即抛清晰错误），不再读 `~/.local/state/personal-ai-os/mem0/api-token`；因 bridge 客户端（`mem0.ts`）仍按 tokenFile 读取，脚本把同一 per-client token 落到自建 tmp 的 0600 文件并传给 bridge，保证脚本内部自洽。bridge 真正迁移属**部署批**（见未覆盖项）。

### 5. 本交接包

结构镜像 [m02-goals-per-client-token-r1](m02-goals-per-client-token-r1.md)：批次身份、固定来源 sha256、设计合同逐条、Node↔Python 语义对照、负例原始结果、验证表、要求审计方、未覆盖项。

## 与 Node 版的语义对照表

| 维度 | Node `request-authority.mjs` | Python `services/memory/authority.py` | 一致性 |
| --- | --- | --- | --- |
| 文档 schema | `{version:1, principals[1..16]}` | 同 | ✅ |
| principal 字段校验 | id/role/tokenDigest/expiresAt/revoked，未知键拒 | 同（`revoked` 用 `is True`，`expiresAt` 用 `isinstance(int,float)` 且拒 bool） | ✅ |
| digest | `sha256(token)` hex | `sha256(token).hexdigest()` | ✅ 逐字 |
| Bearer 形状 | `^Bearer [A-Za-z0-9_-]{32,256}$` | 同 | ✅ |
| 比较 | `timingSafeEqual`，无提前退出 | `hmac.compare_digest`，无提前退出 | ✅ |
| 过期 | `clock() >= expiresAt` 不匹配 | 同 | ✅ |
| revoked | `=== true` 时不匹配、保留为证据 | 同 | ✅ |
| 失败码 | `AUTH_REQUIRED`401 / `AUTH_CONFIGURATION`500 | 同 | ✅ |
| live 变更键 | `ino:mtimeMs:size`（同 fd fstat） | `ino:mtime_ns:size`（同 fd fstat） | ✅（mtime 精度更高，语义等价） |
| 安检前置 | 每次先 `isFile/mode&0o077/uid/size` 再查缓存 | 同 | ✅ RR-F004 |
| 失败不回落 | 抛 500，不读旧缓存 | 同 | ✅ |
| O_NOFOLLOW | 是 | 是 | ✅ |
| 原子写 | tmp+rename，0600 | tmp+`os.replace`，0600 | ✅ |
| clock 单位 | `Date.now()` epoch **ms** | `_now_ms()`=`time.time()*1000` epoch **ms**（见关键偏离） | ✅ 互操作 |
| `load…Authority` | 有（一次性装载） | **未实现**（memory 恒为 live 严格模式，见未覆盖项） | ⚠️ 有意收敛 |

## 关键 diff 摘要

1. `services/memory/authority.py`（新）：`AuthorityError`、`token_digest`、`_now_ms`、`create_request_authority`/`RequestAuthority`、`LiveAuthority`、`write_authority_file`（含 `_validate_principal`、`_unlink`）。
2. `services/memory/service.py`：删 `hmac`/`secrets` import；新增 `from .authority import AuthorityError, LiveAuthority` 与模块级 `MEMORY_ROLE_ACTIONS`；`MemoryService.__init__` 删共享 token 段；`create_app` 在 lifespan 装配 `app.state.authority = LiveAuthority(auth_file)`（`MEMORY_AUTH_FILE` ?? `state_dir/authority.json`），`authorize(authorization, action)` 改为认证 + 角色矩阵（401/403/500 如实），各端点改为 `authorize(authorization, “read”/“ingest”/“forget”)`；`/health` 不变。
3. `tests/memory_service_test.py`：新增 `TEST_TOKEN`/`write_test_authority` helper；三处 `setUp` 与内联 service 改写 authority 文件；token 断言改用夹具 token。**用例数 91 不变**。
4. `tests/memory_authority_test.py`（新）：见上。
5. 三个 live 脚本：token 来源改 `MEMORY_AUTH_TOKEN`；bridge 用 tmp tokenFile。

## 反向负例清单与原始结果摘要

| 负例 | 期望 | 结果 |
| --- | --- | --- |
| 未知/缺失/过短/过长/非 Bearer 形状 token | 401 | ✅ |
| 已吊销 principal（`revoked:true`） | 401（且保留为证据） | ✅ |
| 已过期 principal（`expiresAt<=clock()`） | 401 | ✅ |
| 有效 principal | 200 / 通过 | ✅ |
| `write_authority_file` 原子替换后旧 token | 立即 401、新 token 通过（**未重启**） | ✅ |
| schema 负例（version≠1 / 空 principals / 17 条 / 非法 role / 非 hex / 非法 id / 未知键 / `expiresAt:-1` / `expiresAt:true` / `revoked:false` / 重复 id / 重复 digest） | 全部 `AUTH_CONFIGURATION 500` | ✅ |
| **RR-F004 镜像**：`chmod 600→644`（ino/mtime/size 三者不变） | 暖缓存下仍 500、`generation` 停在 1、不回落旧缓存；恢复 0600 后通过 | ✅ |
| 首次调用前文件即 0640 / 符号链接 path | 500，`generation===0` | ✅ |
| authority 文件缺失 / JSON 非法 / 相对路径 | 500 fail-closed | ✅ |
| `write_authority_file` 收到非法快照 | 抛错，目标**逐字节不变**、无 `.tmp` 残留 | ✅ |
| viewer/coordinator POST `/v1/turns`、`/v1/forget` | 403，且**零状态变动**（pending=0、epoch=0） | ✅ |
| chief POST `/v1/forget` | 403（无 tombstone） | ✅ |
| operator 全通（含 `/v1/forget` 200） | ✅ | ✅ |
| 缺 authority 文件：业务请求 | 500；`/health` | 200 | ✅ |
| 服务不再生成 `api-token` | `(stateDir)/api-token` 不存在 | ✅ |

所有负例为 tmp 合成夹具（`tempfile`），无外呼、无真实凭据、无生产读写。

## 验证

| 要求/Case | 实现 | 验证命令与 cwd | 结果 |
| --- | --- | --- | --- |
| 服务套件适配（91 项） | authority 文件夹具 | `npm run test:memory-service`（仓库根，`.venv-memory` Python 3.11.15） | ✅ **91/91**，exit 0 |
| 新 authority 用例 | `LiveAuthority`/角色矩阵 | `.venv-memory/bin/python -m unittest discover -s tests -p 'memory_authority_test.py'` | ✅ **15/15**，exit 0 |
| memory 联合套件 | 6 个 `memory_*test.py` | `.venv-memory/bin/python -m unittest discover -s tests -p 'memory_*test.py'` | ✅ **282/282**（基线 267 + 新 15），exit 0 |
| 密钥扫描 | 无新泄露形态 | `npm run audit:secrets` | ✅ PASS（0 undispositioned） |
| live 脚本语法 | — | `node --check scripts/test-memory-{live,kimi,recovery}.mjs` | ✅ 三文件 OK（**未实际运行**） |

- 真实模型/原文外呼/生产读写/launchd/微信外发/服务重启：**均未发生**。全部为 tmp 合成夹具；未 chmod 任何真实用户文件（仅 chmod 自建 tmp 文件）。
- 失败、部分结果和不明副作用：无。已在跑的生产 memory 服务**未被本批触碰**。

### 本批关键偏离（请审计方重点复核）

- **`clock` 默认单位取 epoch 毫秒**：设计合同字面写 `clock=time.time`（秒），但 Node 侧 `Date.now()` 与 pairing 产出的 `expiresAt` 是 **epoch 毫秒**；若 Python 默认用秒，则 Node 写出的 authority 文件中每个 `expiresAt` 都会被判为「早已过期」，直接破坏「**同一份 authority.json 可供 Node 与 Python 两侧消费**」这一硬要求。故 `authority.py` 默认 `clock=_now_ms()`（=`time.time()*1000`），并在模块 docstring 明示单位。比较语义 `clock() >= expiresAt` **逐字保留**。如主 Agent 坚持字面秒语义，只需改 `_now_ms` 一处（代价：失去与 Node 的互操作）。
- **`clock` 为关键字参数**（`LiveAuthority(path, *, clock=…)`）：`LiveAuthority(path)` 与合同一致；仅禁止 `LiveAuthority(path, time.time)` 位置传参。
- **未实现 `loadRequestAuthority` 一次性装载路径**：memory 服务恒为 live 严格模式（无 legacy-loopback 兼容），与「不留兼容路径」一致；如审计要求补齐 Node 同名 API 请单列。

## 要求审计方做什么

- 按 G4 一致性收尾验收复核本批 diff / 新 hash / 负例。重点：① `authority.py` 是否与 Node `request-authority.mjs` 逐条对齐（schema、digest、Bearer、比较、过期/吊销、失败码、变更键、**安检前置**、`O_NOFOLLOW`、原子写）；② `service.py` 是否**彻底删除**共享 token/恒定时间比较（无 compat 回退），401/403/500 是否如实、`/health` 是否保持免认证；③ 角色矩阵是否与 goals D50 口径一致（viewer/coordinator 只读、chief 读+ingest 不能 forget、operator 全通），授权是否确在端点业务体/任何状态变动之前；④ RR-F004 镜像用例是否承重（`chmod` 三项键不变仍拒、`generation` 停住）；⑤ `clock` 毫秒偏离是否认可。
- 非返工前请确认：本包未触碰 `package.json`、`docs/audits/**`、`docs/plans/**`、`control-plane/**`、`gateway/**`、`config/wechat-acp.json`、`vendor/**`；**未执行任何写/变更型 git 命令**（仅只读 `git branch --show-current`/`git status --short` 与 `audit:secrets` 内部的 `git ls-files`）；base HEAD 为直读 `.git` ref 得到。
- 等待期间继续的无冲突独立任务：wechat bridge（`mem0.ts`）客户端配对迁移（见未覆盖项）。

## 未覆盖项与诚实边界声明

- **生产服务未重启**：本批只改代码 + 合成测试；已在跑的 memory 服务仍执行旧代码（读 `api-token`/恒定时间比较）。**部署顺序硬约束**：重启生产 memory 前**必须**先经配对/导出流程 `write_authority_file()` 生成 `authority.json`（或经 `MEMORY_AUTH_FILE` 指定）；否则服务对**所有**认证请求 **500 fail-closed**（`/health` 仍 200）。真实重启/部署/凭据轮换**另批**，本包 READY 不授予该权限。
- **bridge mem0 客户端迁移属部署批**：`vendor/wechat-acp/src/storage/mem0.ts`（`options.tokenFile`，经 `config/wechat-acp.json` 的 `mem0.tokenFile` 指向 `~/.local/state/personal-ai-os/mem0/api-token`）当前仍按 **tokenFile** 读取并在请求头发送 `Bearer <该文件内容>`。本批**未迁移**该客户端，也**未改** `config/wechat-acp.json` / `vendor/**`。迁移需：经 pairing 配对取得每客户端 token → 改造读取方式（或让 bridge 接收 per-client token）→ 与本次 authority 文件同步。**在三者一致前，生产 memory 重启会使 bridge 的 mem0 注入失效**（部署前须一并处理）。live 脚本已用 tmp tokenFile 演示以同一 per-client token 供给 bridge。
- **role 粒度**：memory 本批按上表**已做**角色×动作授权（viewer/coordinator 只读、chief 读+ingest、operator 全通含 forget）；coordinator 的 `wake` 语义在 memory **不存在**，故与 viewer 同为只读（已文档化）。是否复用 control-plane 的 `authorizeHttpRequest` 抽象公共矩阵，待与 goals/control-plane 统一裁决（D50 未覆盖项同款）。
- **revoked 条目修剪**：`write_authority_file`/schema 保留全部 revoked 条目（证据），长期运行积累 > 16 条 revoked 后会触发 `AUTH_CONFIGURATION`（上限 16）。安全修剪（保留期/归档）**待后续**。
- **启动期不读文件**：`create_app` 构造 `LiveAuthority` 时**不**校验 authority 文件存在/合法（仅校验 path 绝对）；首个认证请求才读取并 fail-closed，即「配置错误在首个请求暴露」。若审计要求启动即校验（fail-fast），请单列。
- **未实现 `loadRequestAuthority`**：见关键偏离；memory 恒为 live 严格模式。
- **变更键固有边界**（承自 Node r1 边界②）：`ino:mtime:size` 无法察觉「同 inode、同 size、精确复原 mtime 的就地内容改写」；正常原子替换（tmp+rename）必换 ino。权限漂移类别已由「安检前置」与变更键解耦。
- **`generation` 未接 health**：仅作只读属性，未写入 `/health`（与 Node 同）。
- 未执行真实外呼/生产读写/launchd/微信外发/服务重启；未执行任何写/变更型 git 命令；未改 `package.json`。
