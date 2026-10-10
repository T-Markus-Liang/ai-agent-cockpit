# 执行交接包：M02 native OS exec 沙箱原语（r2，按审计 Finding 返工）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包为 r2 revision，回应 [m02-native-sandbox-r1 审计](../audits/m02-native-sandbox-r1.md)（EVIDENCE_REQUIRED：NS-E001 高、NS-N001 非阻断）。r1 证据（`docs/audits/evidence/2026-10-08-round3/`）与旧交接 `m02-native-sandbox-r1.md` 原样保留，不覆盖。

## 批次身份与状态

- batchId / revision：m02-native-sandbox / **r2**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；返工由该会话 subagent（deepseek-flash）完成，主 Agent 定返工设计、亲自复跑
- branch `feat/0.3.0-progress`；cwd `/Users/markus/ai-agent-cockpit`；base HEAD `c9e09b6`（r1 审计基线为 `e8c4317`）
- 已读并确认协作协议：是。本批只允许写入：`control-plane/native-sandbox.mjs`、`tests/native-sandbox.test.mjs`、`docs/handoffs/m02-native-sandbox-r2.md`。**package.json 未改**（沿用既有 `npm run test:native-sandbox` 脚本）；`goal-access-broker.mjs`、`runtime/*`、生产 DB/服务/launchd 未触碰
- 对应：M02 / I03d（native 沙箱原语）；验收 V25（路径越界/symlink/网络由 OS 约束拒绝）native 侧的边界收敛
- 本批目标：按 Finding 硬化读边界 + 配置校验，并用真实 `sandbox-exec` 正负例取证。明确不做：native-acp-executor 接线、真实 Agent CLI 探测、生产、commit/push

## r2 固定来源（新 hash，完整 sha256）

| 文件 | r2 sha256（完整） | r1 sha256 | 变化 |
| --- | --- | --- | --- |
| `control-plane/native-sandbox.mjs` | `74b155ba49acb3f945d3d03654453a0354ef63e6b72be63c1fade8f1c46de81e` | `b6a2cbf3b32be3da8ffb282621223e5d53fd7c2359885d5fcdc1b1e5e3fc8251` | 重写：读默认拒绝 + 严格校验 + canonical 化 |
| `tests/native-sandbox.test.mjs` | `2d00f98d53f0e91d05f950930a4d86e880d9a184ca1e38a034eef329392717b6` | `dfd6e52ad0b7f7b8dc91200151ac1a52cd988e187009035d7ad613c6f521257a` | 重写：20 用例（r1 13），新增 NS-E001/NS-N001 负例 |
| `docs/handoffs/m02-native-sandbox-r2.md` | 本文件（新增） | — | 新 revision 交接 |
| `package.json` | **本批未改**（当前 `b46f4bc95650da0b217ede96cc6b5733acab9ceb0ec5666c2a35c31da5818aaf`；r1 快照 `6b0d01b8…39c8043`） | — | 沿用 r1 已加的 `test:native-sandbox` script；该文件多批共享、跨批漂移，不形成本批冻结 |

- base HEAD `c9e09b6`；本批新增 `native-sandbox.mjs` 现在 `import node:path`（内置，无新依赖）。
- 真实执法依赖系统 `/usr/bin/sandbox-exec`（未改，`-rwxr-xr-x root wheel`）与 Node v24.15.0。
- 自测前后 sourceRef 一致（见“反向负例”复跑脚本同一份源码）。

## Finding 逐条回答

### M02-NS-E001（高 / 覆盖缺口）：读路径改为默认拒绝

- **复现根因**：r1 profile 为 `(allow default)` + 四个固定 deny 树（`/Users`、`/private/var/folders`、`/private/tmp`、`/Volumes`）。未被列出的私有树（如 `/private/var/tmp`）因 `allow default` 而可读。审计探针 `unlisted-private-temp-readable` 记录 `exit=0`。**这不是“全部沙箱无效”，而是 unlisted 目录被隐式当作公开。**
- **修复（读默认拒绝）**：profile 改为在 `(version 1)(allow default)` 之后发出**通配** `(deny file-read*)`，再仅放行：
  - `(literal "/")`——仅供内核遍历绝对路径所需的根元数据；
  - `SYSTEM_READ_SUBPATHS` = `/System /usr /bin /sbin /Library /private/etc /etc /dev`（native 二进制启动/加载 dyld、libSystem、系统配置所需只读根）；
  - 每个 `execLiterals` 字面、`workspaceDir` subpath、`readLiterals` 字面。
  - Seatbelt 采用**后匹配者胜**（本机实测确认：`(deny file-read*)` 之后的 `(allow file-read* …)` 会重新打开被列白名单）。故未列目录落入通配 deny。
- **写路径**：保持默认拒绝 `(deny file-write*)`，仅放行 `/dev/null`、授权 `workspaceDir` subpath、`writeLiterals`。exec/network 维持白名单/`deny network*` 语义。
- **canonical 路径（关键，本机实测）**：Seatbelt 按**呈现路径**匹配（非全量 realpath）。因此：
  - 授权 `subpath "/var/tmp/ws"`（别名）**不能**授权 `/private/var/tmp/ws`，反之亦然；
  - workspace 内的 symlink 指向外部时，按解析后的目标路径判定——逃逸被拒。
  - 修复手段：`canonicalPath()` 用 `realpath` 规范化 workspace/literals/exec 的规范形式；非规范授权只会“失效（fail-closed）”绝不放大。`wrapWithSandbox` 输出的 target 同样规范化，与 profile 放行字面一致。
- **真实 OS 正负例**（全部实跑，摘要见下表与“反向负例”）：无 grant 读 `/private/var/tmp` 自建文件被拒（exit≠0，stdout 空）；同一文件加字面 grant 后 exit 0；workspace symlink 逃逸被拒且 stdout 空；白名单 shell 有/无 writeLiteral 对照正确；127.0.0.1 自建端口网络允许（curl 0/HTTP 200/nonce 匹配）与拒绝（curl 7，请求从未到达 server）对照正确。

### M02-NS-N001（非阻断防御建议）：严格 bool + 未知键拒绝

- `normalizeSpec()` 现要求 `denyNetwork` 必须是 `typeof boolean`（`0/1/'true'/null/[]/{}` 全部 `INVALID_SPEC` 拒绝，不再走 JS truthiness；r1 中 `denyNetwork:0` 被接受且**省略** network deny）。
- 未知配置键一律拒绝（`KNOWN_SPEC_KEYS` 白名单），例如 `allowNetwork`、`denyNetwork` 大小写错拼、r1 旧键 `extraDenyReadSubpaths` 都会被拒，避免拼写错误静默放宽规则。
- 网络能力由显式 Grant 布尔派生（`denyNetwork:false` 才放行），非 truthiness。

## 关键 diff 摘要

```lisp
;; r1（读=默认放行，四个 deny 树）
(version 1)(allow default)
(deny network*)(deny process-exec)(allow process-exec (literal <exec>))
(deny file-read* (subpath "/Users")(subpath "/private/var/folders")(subpath "/private/tmp")(subpath "/Volumes"))
(allow file-read-metadata)                        ; 通配元数据放行，放大未列路径
(allow file-read* (literal <exec>)(subpath <ws>)(literal <read>))
(deny file-write*)(allow file-write* (literal "/dev/null")(literal <write>))
(deny mach-lookup (global-name "com.apple.securityd"))

;; r2（读=默认拒绝，仅放行系统只读根/workspace/字面）
(version 1)(allow default)
(deny network*)(deny process-exec)(allow process-exec (literal <exec>))
(deny file-read*)                                 ; ← 通配默认拒绝（核心修复）
(allow file-read* (literal "/")
  (subpath "/System")(subpath "/usr")(subpath "/bin")(subpath "/sbin")
  (subpath "/Library")(subpath "/private/etc")(subpath "/etc")(subpath "/dev")
  (literal <exec>)(subpath <ws>)(literal <read>))
(deny file-write*)(allow file-write* (literal "/dev/null")(subpath <ws>)(literal <write>))
(deny mach-lookup (global-name "com.apple.securityd"))
```

- 源码结构性改动：新增 `import path`；新增导出 `SYSTEM_READ_SUBPATHS`；移除 r1 导出 `DEFAULT_DENY_READ_SUBPATHS` 与 spec 键 `extraDenyReadSubpaths`（读默认拒绝后不再需要 deny 树，且未知键会被拒）；新增 `canonicalPath()`、`normalizeSpec()`、`profileFromNormalized()`；`wrapWithSandbox` 增加 `assertAbsolute(command)` 并对 command 与 spec 统一规范化。
- 未改：`sandboxEnv()` 最小 env、`assertSandboxAvailable()` 的 `SANDBOX_REQUIRED` fail-closed、`NativeSandboxError` 形态、mach-lookup securityd deny。

## 验证（主 Agent 亲自复跑，全绿）

| 套件 | 命令（cwd=仓库根） | 结果 |
| --- | --- | --- |
| native-sandbox（含真实 OS 执法） | `npm run test:native-sandbox` | **20/20 pass，exit 0**（10 结构 + 10 真实 Seatbelt） |
| goals 回归 | `npm run test:goals` | 60/60 pass，exit 0 |

- 真实 `sandbox-exec` 只作用于自建 `mkdtemp` 夹具（`/private/var/tmp/*`、`/private/var/folders/*`）与本机系统二进制（`echo/cat/sh/bash/curl`）及自建 `127.0.0.1` 回环 listener（`server.listen(0)` 随机端口，非现役 4324）。
- 关键输出摘要（`npm run test:native-sandbox`）：

```
✔ real Seatbelt: an unlisted private temp file is denied without a grant (NS-E001 repro)
✔ real Seatbelt: a private read under the OS temp tree is denied by default
✔ real Seatbelt: a workspace symlink cannot escape the workspace
✔ real Seatbelt: a grant is only effective through its canonical path
✔ real Seatbelt: the workspace is read/write while outside stays denied
✔ real Seatbelt: a self-built loopback listener is reachable only when the grant allows network
ℹ tests 20  ℹ pass 20  ℹ fail 0
```

## 反向负例清单与原始结果摘要

把审计报告 r1 的复现路径写成固定测试，并额外用**同一脚本对 r1/r2 两套 profile** 对拍，证明负例确为“修复后被拒”（load-bearing，而非仅正例通过）：

| # | 负例（测试名/探针） | 场景 | 原始结果（实跑） |
| --- | --- | --- | --- |
| 1 | `an unlisted private temp file is denied without a grant (NS-E001 repro)` | `/private/var/tmp` 自建文件，无 grant 读 | r1 `exit=0, leaked=true` → r2 `exit=1, leaked=false`；r2 加字面 grant 后 `exit=0` |
| 2 | `a private read under the OS temp tree is denied by default` | `/private/var/folders` 自建文件 | r2 `exit≠0, stdout=""` |
| 3 | `a workspace symlink cannot escape the workspace` | ws 内 symlink 指向 `/private/var/tmp/outside/secret` | r1 `exit=0, leaked=true` → r2 `exit=1, leaked=false`；ws 内正常文件对照 `exit=0` |
| 4 | `a grant is only effective through its canonical path` | 用别名 `/var/tmp/...` 授权，经规范/别名两种路径读 | 规范路径 `exit=0`；别名路径 `exit≠0`（Seatbelt 按呈现路径匹配） |
| 5 | `denyNetwork must be a real boolean … (NS-N001 repro)` | `denyNetwork:0/1/'true'/null/[]/{}` | r1：`0` 被接受且省略 deny → r2：全部抛 `INVALID_SPEC`；真布尔 true/false 仍生效 |
| 6 | `unknown configuration keys are rejected (NS-N001)` | `allowNetwork`/`extraDenyReadSubpaths`/`denynetwork`/`workspace` | r2 全部抛 `INVALID_SPEC`（`unknown sandbox spec key`） |
| 7 | `real Seatbelt: exec outside the whitelist is denied by the profile` | 同 profile 下 `/usr/bin/true` vs `/bin/echo` | 非白名单 `exit≠0`（71）；白名单 `exit=0` |
| 8 | `a write outside the literal set is denied and leaves no file` / `the workspace is read/write while outside stays denied` | 无 writeLiteral、workspace 外写 | 均 `exit≠0` 且文件不存在；workspace 内写对照 `exit=0` |
| 9 | `a self-built loopback listener is reachable only when the grant allows network` | `denyNetwork:true` 下 curl 自建 127.0.0.1 端口 | 允许侧 `exit=0`/nonce 匹配 → 拒绝侧 `exit=7`、stdout 空、请求计数不变（从未到达 server） |

- r1/r2 对拍为**临时探针**（自建 `/private/var/tmp` 夹具；脚本未持久化，用本文件给出的 r1/r2 profile 形态即可复现）原始 JSON 摘要：
  `{"r1":{"exit":0,"leaked":true},"r2":{"exit":1,"leaked":false},"r1_denyNetwork0_omits_deny":true,"r2_denyNetwork0_throws":true}` 与 `{"symlinkEscape":{"r1":{"exit":0,"leaked":true},"r2":{"exit":1,"leaked":false}}}`。

## 未覆盖项与诚实边界声明

- **`(allow default)` 基座保留**：本 Finding 只要求“默认 deny 读数据”，故 r2 未改为全量 `(deny default)`。非读/写/exec/network 的操作仍为默认放行：mach-lookup（仅 deny securityd）、`process-fork`、`signal`、`sysctl-read`、iokit/ipc 等。审计“尚未确认”的 **其他 IPC/mach 服务面**仍未收敛，属残余面。全量 `(deny default)` 需枚举 fork/mach/sysctl/dyld-cryptex 等一大片，风险与范围超出本 Finding，建议单列工作包。
- **`/Library` 放行过宽（如实）**：合同列出 `/Library` 为放行根，但 `/Library` 含系统级共享数据（如 `/Library/Application Support`、`/Library/Preferences`、`/Library/Logs`、系统 Keychain）。其**世界可读**的普通文件在沙箱内变为可读。取舍：native CLI 常依赖 `/Library` 内的框架/字体/配置；用户私密数据（`~/Library`）仍在 `/Users` 之外、默认拒绝。残余面已登记。
- **`/private/etc` 与 `/etc`**：系统配置（hosts/passwd/ssl 证书等）可读。`/etc` 与 `/private/etc` 因 Seatbelt 按呈现路径匹配而**都需列出**（实测：仅授权 `/private/etc` 时 `cat /etc/hosts` 被拒）。非用户私密；root-only 文件（如 ssh host key，0600）仍不可读。
- **未放行 `/private/var/select`**：`/bin/sh` 会打印非致命警告 `Error opening /private/var/select/sh: Operation not permitted`，但 shell 仍正常执行（`exit=0`，实测）。真实 Agent CLI 可能需要更多系统根，属**接线切片**的调参面。
- **未覆盖**：真实 Agent CLI 间接 exec 探测与 `execLiterals` 白名单收敛、unix 域套接字 / 其他网络原语是否受 `deny network*` 约束（本轮只实测 TCP 回环）、其他平台（Linux bubblewrap/landlock）替代、多卷/更深 symlink 别名矩阵、executor/权限 broker 全程接线。r1 审计原 13 项并非全部重测（本套件为 r2 重写后的 20 项）。
- **不关闭项**：本包不关闭 V25/G4 的完整验收，也不声称生产接线安全；仅收敛“未列目录当公开”的读覆盖缺口与配置严格性。

## 要求审计方做什么

- 按 Finding ID 复核 r2 diff/hash/负例与对拍结果：① 读默认拒绝是否覆盖“未列 private 树可读”缺口；② canonical/symlink 语义结论是否与 Seatbelt 实际一致；③ `denyNetwork` 严格 bool 与未知键拒绝是否符合 NS-N001；④ `SYSTEM_READ_SUBPATHS`（含 `/Library`、`/private/etc`）放行面与上述残余面取舍是否可接受。
- 已知不足/需决定的方案：是否推进全量 `(deny default)`（IPC/mach 收敛）；native-acp-executor 接线时的真实 CLI 间接 exec 白名单策略；Linux 替代。
- 本包为**返工 revision（r2）**：NS-E001 已修复并补真实 OS 负例；NS-N001 已修复（严格 bool + 未知键拒绝）。无“未解决 Finding”；未覆盖项见上一节，均非本轮 Finding 要求关闭的子项。
