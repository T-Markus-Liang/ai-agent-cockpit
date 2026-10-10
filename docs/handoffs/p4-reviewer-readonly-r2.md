# 执行交接包：P4 reviewer 只读约束的真实 OS 强制（r2，按审计 RO-F001 返工）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包为 r2 revision，回应 [p4-reviewer-readonly-r1 审计](../audits/p4-reviewer-readonly-r1.md)（**CHANGES_REQUESTED / RO-F001（Major）**）。r1 交接 `p4-reviewer-readonly-r1.md` 与审计证据 `docs/audits/evidence/2026-10-08-followup/reviewer-os-probe.mjs` **原样保留、未改**。

一句话结论：r1 的清空 `writeLiterals` 只挪走了**一个数组**，但 `native-sandbox` 的写 allow 列表仍**无条件**加入 `workspaceDir` subpath，因此真实 Seatbelt 下 reviewer 依旧能改写工作区内工件（审计有真实 OS 反例）。r2 把 workspace 的**读权与写权显式分离**（新严格布尔 `workspaceWrite`，默认 false，fail-closed），reviewer 强制 `workspaceWrite:false` + `writeLiterals:[]`，唯一可写出口是宿主分配的独立 `scratchDir`；并以**真实 `sandbox-exec`** 补齐写既有文件/新建/改检查脚本/rename/delete/别名/symlink/显式 writeGrant 的负例。

## 批次身份与状态

- batchId / revision：p4-reviewer-readonly / **r2**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Markus 的 Personal AI OS 会话 subagent（deepseek-flash，执行方）；主 Agent 按审计 5 条定稿返工合同、复跑验收
- branch `feat/0.3.0-progress`；cwd `/Users/markus/ai-agent-cockpit`
- 已读并确认协作协议：是。本批**写入且仅写入**：
  - `control-plane/native-sandbox.mjs`（workspaceWrite 读/写分离 + scratchDir）
  - `control-plane/native-acp-executor.mjs`（reviewer spec：workspaceWrite:false + scratchDir + 诚实 Evidence）
  - `tests/native-sandbox.test.mjs`（真实 OS 负例 + 结构/校验用例）
  - `tests/native-acp-executor.test.mjs`（reviewer spec 断言按新语义更新）
  - `docs/handoffs/p4-reviewer-readonly-r2.md`（本文件，新增）
  - **未触碰** `package.json`、`docs/audits/**`、`docs/plans/**`、`control-plane/store.mjs`、`control-plane/contracts.mjs`、`control-plane/reviewer.mjs`、`gateway/**`、`runtime/**`、`vendor/**`、任何生产服务/DB/launchd/真实用户文件/真实 CLI
- **未执行任何 git 命令**（含只读）；无新依赖；无外呼；未启动任何真实 Agent CLI
- 对应：RO-F001 五条返工合同；P4/B03 Wave3 第 8 步 reviewer 只读（缺口 8）从「数组级降级」升级为「OS 级强制」

## r2 固定来源（完整 sha256）

| 文件 | r2 sha256（完整） | 上一版 sha256 | 变化 |
| --- | --- | --- | --- |
| `control-plane/native-sandbox.mjs` | `de39cee141ba4e0cef522d8799f69ea9a9ab770f5e39f5e901ee93d992bc701f` | `74b155ba49acb3f945d3d03654453a0354ef63e6b72be63c1fade8f1c46de81e`（m02-r2） | 新增 `workspaceWrite`（严格布尔、默认 false）+ 可选 `scratchDir`（严格、与 workspace 不重叠）；写 allow 由 `workspaceWrite` 门控 |
| `control-plane/native-acp-executor.mjs` | `ba62451128e1d1c8d2852148c492d7cdb769395b744b0c75b5fd158f7e7c9cf0` | r1 `ea3127dd9076f17e883e415a64f2e1a97a27fb81d3e6f0cc964814b7779aac02`；审计时合成版 `0ebe00c8b39b8a50a824b9dd47e1442dfe3016681487c81a90ee0f9efb80d7a8` | `nativeAcpSandboxSpec` 显式 `workspaceWrite:true` 并透传 `scratchDir`；`applyReviewerReadonlyConstraint` 追加 `workspaceWrite:false` 并回带 `scratchDir`；Evidence 文案与真实规则一致 |
| `tests/native-sandbox.test.mjs` | `8873b3e6da71592ced57f9bc5ab511b90beef3348eba4b8251feb29facfbb1f5` | `2d00f98d53f0e91d05f950930a4d86e880d9a184ca1e38a034eef329392717b6`（m02-r2） | **20 → 27 用例**：+1 workspaceWrite 严格布尔、+1 scratchDir 校验、+4 真实 OS reviewer 负例、+1 fail-closed；结构/校验用例就地加强 |
| `tests/native-acp-executor.test.mjs` | `a5657fee214d7a6df6891430dfae542e2cacf2a19b1acd536913f1cf97fcf84e` | r1 `4ad2b99623b94c0b4368d7aaa405b3171b4f8ed048391d4b94d4c80a0dfa7866` | **55 → 55 用例**（就地更新 4 个 reviewer 用例 + `nativeAcpSandboxSpec` 用例，未增删） |
| `docs/handoffs/p4-reviewer-readonly-r2.md` | 本文件（新增；自哈希写入时不可自洽，按模板留空） | — | 新 revision 交接 |
| `package.json` | `f91339985e7b0a6c1c36f82c4d3ec131faf965f3102ab93ca296e18607c5590e` | 多批共享、跨批漂移（m02-r2 快照 `b46f4bc9…`） | **本批未改** |

- 真实 Seatbelt 依赖系统 `/usr/bin/sandbox-exec`（未改，`-rwxr-xr-x root wheel`）与 Node `v24.15.0`（`/usr/local/bin/node`，落在放行的 `/usr` 只读根内）。
- 固定来源稳定性：同一份 r2 源码下 OS 负例可重复（见下「反向负例」）；结论不依赖 branch 状态。

## RO-F001 五条逐条回答

### 合同 1：workspace 读权与写权显式分离（`native-sandbox.mjs`）

- **根因**：`profileFromNormalized` 的写 allow 列表原为 `['(literal "/dev/null")', ...(workspaceDir===undefined?[]:[subpath ws]), ...writeLiterals]`——`workspaceDir` **无条件**进写白名单。于是「清空 `writeLiterals`」对工作区内的工件**毫无作用**：它仍在 `(subpath <ws>)` 写授权之下。数组为空 ≠ 系统收回权限。
- **修复**：新增 spec 严格布尔字段 `workspaceWrite`（`normalizeSpec` 中 `typeof !== 'boolean'` 即 `INVALID_SPEC`；缺省 **false**，fail-closed）。写 allow 变为：
  ```lisp
  (allow file-write* (literal "/dev/null")
    (subpath <ws>)        ;; ← 仅当 workspaceWrite===true
    (subpath <scratch>)   ;; ← 仅当 scratchDir 存在（见合同 3）
    (literal <writeLiteral>)...)
  ```
  **读**保持不变：workspace 仍在 `(allow file-read* … (subpath <ws>) …)` 内（工件必须可读）。
- **既有 worker 路径**：executor 的 `nativeAcpSandboxSpec` 现**显式**返回 `workspaceWrite:true`（现状「工作区读/写」语义，逐字保留）。
- **行为变化点（交接包列清，见下「关键 diff」）**。

### 合同 2：新 spec 字段严格校验、兼容 worker、不给宽 Grant/别名/重叠 scratch 恢复写权

- `workspaceWrite`：严格布尔，`0/1/'true'/'false'/null/[]/{}` 全部 `INVALID_SPEC`（与 NS-N001 的 `denyNetwork` 同款严格性，杜绝 JS truthiness 误判为授权）。
- 未知键仍一律拒绝（`KNOWN_SPEC_KEYS` 白名单已含新键）。
- **不重叠校验**：`scratchDir` 与 `workspaceDir` 经 `canonicalPath()` 规范化后，任一方是另一方的祖先或相等即 `INVALID_SPEC`（`pathWithin`）。这堵死了「用与 workspace 重叠的 scratch 重新打开 workspace 写」的旁路。
- **canonical 化**：workspace/scratch/literals/exec 均经 `canonicalPath()`（`realpath` 最深存在祖先 + 回补尾段），Seatbelt 按呈现路径匹配，故别名授权只会「失效」不会放大（沿用 m02-r2 语义）。
- **兼容 worker**：唯一生产调用点 `nativeAcpSandboxSpec` 已显式 `workspaceWrite:true`，既有 worker 行为逐字保留（回归证明：`native-acp-executor` 55/55 全绿，含原 spy 断言）。

### 合同 3：reviewer 可读目标、可输出到受控独立位置

- reviewer 走 `applyReviewerReadonlyConstraint`：强制
  - `writeLiterals: []`（剥掉调用方显式写路径，非静默而是留痕）；
  - **`workspaceWrite: false`**（工作区本身失去写授权）——这才是 OS 层面真正生效的一步。
- 保留：`readLiterals`（读工件）、`denyNetwork`（网络策略）。
- **唯一可写出口**：spec 新增可选 `scratchDir`（宿主分配的独立目录，与 workspace 不同树、严格校验）。reviewer 若需写私有运行元数据，走 scratch，**不回 workspace**。`readonly` 回带 `scratchDir`（缺省即 `undefined`，表示**无任何写出口**）。
- `applyReviewerReadonlyConstraint` **非 reviewer 分支原样返回同一 spec 对象**（逐字未改）。

### 合同 4：新增真实 OS 负例（tmp 夹具 + 真实 `sandbox-exec`）

在 `tests/native-sandbox.test.mjs` 用 executor 的**真实两个函数**派生出 reviewer spec（`nativeAcpSandboxSpec` → `applyReviewerReadonlyConstraint`），再经 `wrapWithSandbox` 启动**真实** `sandbox-exec`，全部操作 tmp 夹具：

| 负例（测试名） | 断言 |
| --- | --- |
| `a reviewer spec (RO-F001 repro) cannot rewrite or create the workspace artifact…` | reviewer spec（含显式 `writeLiterals:[artifact]`）：**读 OK**；改写既有工件失败且**原字节不变**；新建文件失败且**无残留**；**载荷性对照**：把 `workspaceWrite` 恢复为 true（r2 旧形）后**同一次写成功**（证明负例确实咬在改动上） |
| `a reviewer spec cannot modify a check script or rename/delete a workspace file` | 改检查脚本失败且字节不变；`rename` 失败且两路径不变；`unlink` 失败且文件仍在 |
| `a reviewer spec cannot escape the workspace through a symlink or a path alias` | ws 内 symlink 指向外部：写穿失败、外部文件不动；workspace 的 `/var` 别名形式写失败、规范文件不动 |
| `a reviewer scratchDir is writable and stays isolated from the workspace` | scratch 内写成功；workspace 仍不可写（scratch 未重新打开它）；scratch 内 symlink 指向外部写失败 |
| `a reviewer spec fails closed with SANDBOX_REQUIRED … (no unsandboxed fallback)` | 无 Seatbelt 时**诚实失败**（`SANDBOX_REQUIRED`），不裸跑 |
| `real Seatbelt: the workspace is read/write only with the workspaceWrite opt-in…`（worker 对照，就地加强） | worker（`workspaceWrite:true`）工作区写**正常**；无 opt-in 时同写被拒 |

- **无 Seatbelt 环境诚实失败**：所有真实 OS 用例以 `MAC = { skip: process.platform !== 'darwin' }` gate（非 macOS 跳过，**不 fallback 裸跑断言**）；另有**非 gate** 的 fail-closed 用例在任意平台证明 `SANDBOX_REQUIRED`（darwin 下 mock 掉 helper、非 darwin 下直接命中平台分支）。

### 合同 5：只有 OS 规则真正生效才记录「已强制只读」；附 hash/反向负例/原结果

- **记录条件**：Evidence 只在 `result.reviewerReadonly.applied` 为真时写，而 `applied` 只在 `role==='reviewer'` 且 spec 已按新语义生成（`workspaceWrite:false` + `writeLiterals:[]`）时为真。
- **文案与真实 OS 规则一致**：Evidence 摘要形如
  `REVIEWER_READONLY_APPLIED: reviewer execution forced read-only (workspaceWrite=false); stripped caller-supplied writeLiterals [<paths>]; the only write outlet is the host-allocated scratch dir <scratch>`（无 scratch 时 `no write outlet is granted (scratchDir absent)`）。即：**不再**只宣称「只读」而实际仍可写 workspace；明确 workspaceWrite 关闭、列出被剥路径、并如实标注唯一写出口。
- 本包附完整 sha256、「反向负例」原始结果与对拍（下节）。

## 关键 diff 摘要与行为变化点

### `native-sandbox.mjs`

```lisp
;; r2（写 allow 无条件含 workspace）
(deny file-write*)(allow file-write* (literal "/dev/null")(subpath <ws>)(literal <write>))
;; r3/r2-rework（写 allow 由 workspaceWrite 门控；scratch 为唯一额外出口）
(deny file-write*)(allow file-write* (literal "/dev/null")
  (subpath <ws>)        ;; 仅 workspaceWrite:true
  (subpath <scratch>)   ;; 仅 scratchDir 存在
  (literal <write>))
;; 读不变：(allow file-read* (literal "/")(subpath <system roots>)(literal <exec>)(subpath <ws>)(subpath <scratch>)(literal <read>))
```

- 新增导出/字段：spec 键 `workspaceWrite`（严格布尔，默认 false）、`scratchDir`（可选，绝对、与 workspace 不重叠）。
- 新增 `pathWithin()`（重叠判定）；`normalizeSpec` 追加两字段的严格校验 + 重叠拒绝；`profileFromNormalized` 用 `workspaceWrite` 门控 workspace 写并把 scratch 加入读+写 allow。

### `native-acp-executor.mjs`

- `nativeAcpSandboxSpec`：返回值新增 `workspaceWrite: true`（worker 显式 opt-in），并在 `grant.scratchDir` 为字符串时透传 `scratchDir`。
- `applyReviewerReadonlyConstraint`：reviewer 分支返回 `{ ...spec, writeLiterals: [], workspaceWrite: false }`，`readonly` 追加 `scratchDir`；非 reviewer 分支**逐字未改**。
- `executeNativeSessionPrompt`：`readonly` Evidence 文案更新为与真实规则一致（`workspaceWrite=false` + 被剥路径 + 唯一 scratch 出口）。

### **行为变化点（交接包明确列清）**

1. **`buildSandboxProfile`/`wrapWithSandbox` 的默认语义变化**：传入 `workspaceDir` 但**不传** `workspaceWrite` 时，工作区**不再**进入写白名单（旧行为是进入）。全仓唯一的这一处生产调用点 `nativeAcpSandboxSpec` 已改为显式传 `workspaceWrite:true`，故**生产行为不变**；若将来有其它调用方需要可写工作区，必须显式 opt-in。
2. **reviewer 的真实 OS 结果变化**：r1 下 reviewer 工件实际仍可写（审计反例）；r2 下被 Seatbelt 拒绝。
3. **spec 新增字段**：`workspaceWrite`、`scratchDir` 进入 `KNOWN_SPEC_KEYS`，其余未知键仍拒。
4. **Evidence 文案变化**：由「forced read-only; stripped …」变为「forced read-only (workspaceWrite=false); stripped …; the only write outlet is …」。
5. 非 reviewer 的 spec 与既有断言**逐字不变**（worker 写路径仍 `workspaceWrite:true`）。

## 验证（主 Agent 可复跑，逐套件）

| 套件 | 命令（cwd=仓库根） | 结果 |
| --- | --- | --- |
| native-sandbox（含真实 OS 负例） | `npm run test:native-sandbox` | **27/27 pass，exit 0**（12 结构/校验 + 15 真实 Seatbelt） |
| native-acp-executor（reviewer spec 断言更新） | `npm run test:native-acp-executor` | **55/55 pass，exit 0** |
| control-plane | `npm run test:control-plane` | **23/23 pass，exit 0** |
| runtime-policy（4 个测试文件本体） | `node --test tests/request-authority.test.mjs tests/approval-authority.test.mjs tests/acp-permission-broker.test.mjs tests/control-plane-lock.test.mjs` | **39/39 pass，exit 0**（见下「环境干扰」） |
| goals | `npm run test:goals` | **74/74 pass，exit 0** |
| secret scan | `npm run audit:secrets` | **PASS：0 undispositioned credential-shaped hits** |

- 计数变化：`native-sandbox` **20 → 27**（+7，合同 4 要求的真实 OS 负例 + 新字段结构/校验）；`native-acp-executor` **55 → 55**（就地更新，未增删）；`control-plane`/`goals` 不变。
- 关键输出摘要（`npm run test:native-sandbox`）：

```
✔ buildSandboxProfile emits every enforced clause, with the workspace write gated by workspaceWrite
✔ workspaceWrite must be a real boolean and defaults to false (fail-closed)
✔ scratchDir must be absolute and must not overlap the workspace in either direction
✔ real Seatbelt: the workspace is read/write only with the workspaceWrite opt-in, while outside stays denied
✔ real Seatbelt: a reviewer spec (RO-F001 repro) cannot rewrite or create the workspace artifact, and the original bytes survive
✔ real Seatbelt: a reviewer spec cannot modify a check script or rename/delete a workspace file
✔ real Seatbelt: a reviewer spec cannot escape the workspace through a symlink or a path alias
✔ real Seatbelt: a reviewer scratchDir is writable and stays isolated from the workspace
✔ a reviewer spec fails closed with SANDBOX_REQUIRED when Seatbelt is unavailable (no unsandboxed fallback)
ℹ tests 27  ℹ pass 27  ℹ fail 0
```

### 环境干扰（如实声明，非本批引入）

- `npm run test:runtime-policy` 的**前置步骤** `npm --prefix vendor/wechat-acp run build`（即 `tsc`）在本批验收期间**偶发失败**，报 `vendor/wechat-acp/src/acp/session.ts` 的 TS 类型错误，且**两次运行的行号不同**（1275/1315/1417 → 1439），`session.ts` mtime 与运行时刻同一分钟——表明 **`vendor/wechat-acp` 正被另一进程并发编辑**。
- 本批**未触碰 `vendor/**`**；runtime-policy 的 4 个测试文件**与 vendor 源码无关**，直接 `node --test` 运行 **39/39 全绿**（上表已给命令）。故该失败与本批改动无因果，属环境并发写入。

## 真实 OS 负例原始输出摘要（复刻审计探针）

用与审计 `reviewer-os-probe.mjs` 相同的路径（`nativeAcpSandboxSpec` → `applyReviewerReadonlyConstraint` → `wrapWithSandbox` → 真实 `sandbox-exec` 写 tmp artifact）复跑，对比**修复后**与**r2 旧形**（把 `workspaceWrite` 恢复为 true）：

```
FIXED  {"syntheticOnly":true,"realSeatbelt":true,"networkDenied":true,
        "readonlyMarker":true,"writeLiterals":[],"workspaceWrite":false,
        "sandboxExit":1,"artifactModified":false,"expectedArtifactModified":false}
PREFIX {"workspaceWrite":true,"sandboxExit":0,"artifactModified":true}
```

- **FIXED**：`workspaceWrite:false` → 真实 Seatbelt `exit=1`，**artifact 未被改写**（与期望一致）。
- **PREFIX**：仅把 `workspaceWrite` 恢复为 true，同一次写 `exit=0` 且 **artifact 被改写**——正是审计原反例的观测结果，现只能通过**回退修复**重现。

### 反向负例（载荷性对拍）：逆向变异 → OS 负例精确失败

按合同「恢复无条件 workspace 写 → OS 负例精确失败」执行**代码级变异**（临时把 `native-sandbox.mjs` 写 allow 的 `workspaceWrite` 门控去掉，恢复 r2 的无条件 workspace 写），随后仅跑 RO-F001 用例：

```
✖ real Seatbelt: a reviewer spec (RO-F001 repro) cannot rewrite or create the workspace artifact, and the original bytes survive
  AssertionError [ERR_ASSERTION]: a reviewer must not be able to rewrite the artifact
ℹ tests 1  ℹ pass 0  ℹ fail 1
```

- 精确失败于「reviewer 不得改写工件」这一步。变异**已还原**：`control-plane/native-sandbox.mjs` 还原后 sha256 复归 `de39cee1…`，`npm run test:native-sandbox` 复跑 **27/27 全绿**。
- 等价证据已固化进测试本身：RO-F001 用例内的**载荷性对照**（`workspaceWrite:true` → 写成功）与上述代码级变异结论一致，故负例为**载荷性回归**而非误报。

## spy/真实执法的边界声明

- **真实 OS 执法证据只在 `tests/native-sandbox.test.mjs`**：这些用例经 `wrapWithSandbox` 启动真正的 `/usr/bin/sandbox-exec`，由**内核**拒绝越权写。
- **`tests/native-acp-executor.test.mjs` 的 reviewer 用例仍是 spy（纯合成）**：`makeSandbox()` 记录 `wrap(...)` 收到的 spec 后**原样放行**（不启真实 Seatbelt）。它们证明的是 **executor 在 spec 派生层**已把 `workspaceWrite:false`/`writeLiterals:[]` 注入，以及 Evidence 文案/取值——**不冒充** OS 执法。r1 审计明确指出「绿测/只读文案不能当 OS 执法」；r2 的 OS 执法另由 `native-sandbox.test.mjs` 承担，二者边界清晰、互不冒充。

## 未覆盖项与诚实边界声明

- **仍只强制 native-acp 路径**：代码强制点仍是 `native-acp-executor.mjs`（`runNativeAcpPrompt`/`executeNativeSessionPrompt` 的 spec 派生）。Cezar（`dispatcher.mjs`）与 vendor/wechat-acp 等**其它执行路径**尚无 reviewer 只读强制，属各自批次切片。本包**不声称**全仓 reviewer 只读闭环。
- **`scratchDir` 的来源与真实 CLI 写入面未探测**：本批把 `scratchDir` 从 `sandboxGrant` **透传**并严格校验；但「宿主如何**分配**一个 scratch 目录」以及「真实 Codex/OpenCode 运行究竟要写哪些私有运行元数据」**未做**（需真实 CLI 探测批）。当前若调用方不传 `scratchDir`，reviewer **无任何写出口**（fail-closed）。
- **真实 Worker 评审未做**（属授权批）：本批不启动真实 CLI、不做真实 pass/fail 评审。
- **`(allow default)` 基座与本批未收敛的 IPC/mach 面**：沿用 m02-r2 的残余面结论（未改）；本批只收敛 workspace 写权。
- **其它平台**：真实 OS 负例以 macOS Seatbelt 为准，非 macOS 跳过（Linux bubblewrap/landlock 未做）。
- **未做跨进程并发压测**；**生产未重启**：gateway/launchd 未动，运行态是否加载新代码属部署动作，本批不做。
- **不关闭项**：不关闭 P4 其余缺口（真实会话、tool-call broker 接线、其它执行路径 reviewer 只读、V41 GUI 占用、session 索引一致性等），也不声称生产接线安全。

## 要求审计方做什么

- 按 RO-F001 五条逐条复核本批 diff/hash/负例：
  ① workspace 的**读/写是否已显式分离**，reviewer 工件是否在**最终 Seatbelt 规则**下真正不可写（而不仅是清空数组）；
  ② 新字段 `workspaceWrite`/`scratchDir` 的**严格校验**（非布尔拒、未知键拒、overlap 拒）是否正确，worker 既有授权是否**逐字兼容**（55/55 绿）；
  ③ reviewer 的读保留、唯一写出口为**独立 scratch**（缺省即无出口）是否符合合同 3；
  ④ 真实 OS 负例（写既有/新建/改检查脚本/rename/delete/别名/symlink/显式 writeGrant）+ 原字节不变 + 读正常 + worker 写正常 + 无 Seatbelt 诚实失败（平台 gate）是否齐备；**载荷性对照/逆向变异**结论是否成立；
  ⑤ Evidence 是否**只在真实只读生效时**记录，且文案与真实 OS 规则一致。
- 复核未改文件是否漂移（`package.json`/`store.mjs`/`contracts.mjs`/`reviewer.mjs`/`gateway/**`/`docs/audits/**`/`docs/plans/**`）。
- 已知不足/需决定：其它执行路径的 reviewer 只读何时立项；`scratchDir` 的宿主分配策略与真实 CLI scratch 写入面（探测批）；`role` 是否应进入 prompt 审批摘要（r1 遗留）。
- 本包为**返工 revision（r2）**：RO-F001 五条已逐条落实并补真实 OS 负例；无「未解决 Finding」；未覆盖项见上一节，均为后续批或部署动作，非本合同要求关闭的子项。
