# 执行交接包：M02 native ACP executor 沙箱与权限接线（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。本包为 native-acp-executor 接线的 **r1**（首切片）。前置切片 `m02-native-sandbox-r2.md`（V25 沙箱原语）与 `m02-session-permission-broker`（V47 会话权限 broker）已就绪，本批把两者接到 executor 的 spawn 与入站客户端请求路径上。

## 批次身份与状态

- batchId / revision：m02-native-acp-executor / **r1**
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话 subagent（deepseek-flash，执行方）；主 Agent 定稿设计合同、复跑验收
- branch `feat/0.3.0-progress`；cwd `/Users/markus/ai-agent-cockpit`；base HEAD **`bb4bfd2819c5a39776214c2e5c0c0bffc068d9ee`**（short `bb4bfd2`）
- 已读并确认协作协议：是。本批只写入：`control-plane/native-acp-executor.mjs`、`tests/native-acp-executor.test.mjs`、`package.json`（**仅新增一行 script**）、`docs/handoffs/m02-native-acp-executor-r1.md`。**未触碰** `control-plane/native-sandbox.mjs`、`control-plane/session-permission-broker.mjs`、`runtime/*`、`gateway/*`、生产 DB/服务/launchd、`docs/audits/**`、`docs/plans/**`；工作树中他人未提交改动（`docs/audits/**`）未触碰
- 对应：M02 / I03d；验收 V25（沙箱接线）+ V47（会话权限裁决）
- 本批目标：把 executor 的裸 `spawn` 改走 sandbox 端口、把 `process.env` 全量继承收紧为白名单、把入站客户端 tool call 毯式 `-32601` 改接 session-permission-broker。明确不做：启动真实 Codex/OpenCode/任何真实 Agent CLI（真实 CLI 间接 exec 探测属单独授权批）、真实 Grant/网络与 auth 目录读取的定案、生产重启、commit/push

## r1 固定来源（完整 sha256）

| 文件 | r1 sha256（完整） | 说明 |
| --- | --- | --- |
| `control-plane/native-acp-executor.mjs` | `177245311886d9d113e018de1608219f3ea9d7b5316b74a2ede36057cb6deea9` | 本批改动（spawn 走 sandbox、env 白名单、入站请求接 broker） |
| `tests/native-acp-executor.test.mjs` | `0ff5dd9329073911b2bc6831913ff4f7b002a20084bcaf256fb04f881f63e381` | 本批新增（11 用例，纯合成） |
| `package.json` | `325074b22b2f9fc4127c3d6e034c55d7d5b4e4722fc92051e589c837e27f1436` | 仅新增一行 `"test:native-acp-executor": "node --test tests/native-acp-executor.test.mjs"` |
| `control-plane/native-sandbox.mjs` | `74b155ba49acb3f945d3d03654453a0354ef63e6b72be63c1fade8f1c46de81e` | **未改**；与 `m02-native-sandbox-r2.md` 冻结值逐一相同，确认 r2 冻结源未漂移 |
| `docs/handoffs/m02-native-acp-executor-r1.md` | 本文件（新增） | — |

- base HEAD `bb4bfd2`。本批未执行任何 git 命令（含只读），故**未取 executor 改前的旧 blob sha**；如需对拍，审计方可按 base HEAD 自行 `git show bb4bfd2:control-plane/native-acp-executor.mjs` 复核。
- 无新依赖（`node:os`、`node:path`、`node:child_process`、`node:readline` 均为内置）。
- 真实执法依赖系统 `/usr/bin/sandbox-exec` 与 Node v24.15.0（未改）。

## 设计合同逐条落实

### 1. spawn 走 sandbox 端口

- `runNativeAcpPrompt` 与 `executeNativeSessionPrompt` 均新增可选 `sandbox` 端口与 `sandboxGrant` 参数。
- **默认端口 = 真实 `native-sandbox.mjs` 的 `wrapWithSandbox`**（`const wrap = sandbox ?? wrapWithSandbox`）。`wrapWithSandbox` 内部 `assertSandboxAvailable()`，Seatbelt 不可用时抛 `SANDBOX_REQUIRED`，**无 unsandboxed 回退**；`native-acp-executor.mjs` 不再直接持有 `spawn(command, args, {env:{...process.env}})` 的裸路径。
- **spec 派生**（`nativeAcpSandboxSpec`）：
  - `workspaceDir = cwd`；
  - `execLiterals = uniq([selected.command, path.resolve(selected.command)])`（所选 command 及其 resolved 路径，去重；native-sandbox 内部再 canonical 化）；
  - `readLiterals / writeLiterals` 来自 `sandboxGrant`（缺省 `[]`）；
  - `denyNetwork` 缺省取 `false`（合同指定），显式经 native-sandbox 的严格 bool 校验。
- 测试注入 spy sandbox 断言包装被调用一次且 spec 正确（workspace=cwd、execLiterals 含命令、grant 字段逐项传递）。**真实 sandbox 的 OS 级证据由 `tests/native-sandbox.test.mjs` 承担，本切片不重复**；但额外加了 1 条 MAC-gated 用例，让本切片合成的假 agent 也经**真实 Seatbelt** 跑通（证明接线本身可用）。

> ⚠️ **醒目标注（探测/部署批，非本切片）**：本切片仅把端口接通，`denyNetwork` 缺省 `false`、read/write literals 缺省空、execLiterals 仅含所选 CLI 命令。**真实 Grant 派生——尤其是 CLI 自读的配置/auth 目录（如 `~/.codex`、`~/.opencode`）的读授权，以及网络策略的真实派生素——属单独的“真实 CLI exec 探测/部署批”**：需在探测中观测真实 CLI 启动/鉴权所需的读路径与网络面，再据此定案 `readLiterals`/`denyNetwork` 与 `execLiterals`。在定案前，默认 spec **不足以保证真实 CLI 在沙箱内正常运行**，此为本切片的已知边界。

### 2. env 白名单（不再全量继承 `process.env`）

- 新增 `nativeAcpChildEnv(extraEnv)`：子进程 env = 固定键白名单 `PATH/HOME/LANG/TERM/TMPDIR`（**值取自宿主** `process.env[key]`，缺失时回退内置默认：`PATH=/usr/bin:/bin`、`HOME=os.homedir()`、`LANG=en_US.UTF-8`、`TERM=dumb`、`TMPDIR=os.tmpdir()`）+ `sandboxGrant.extraEnv` 的**显式字符串键值**（非字符串值忽略，不做 JS 强转）。
- **不再 `{ ...process.env, ... }`**：provider API key 等宿主机密**缺省不进入子进程**。
- 这是**安全语义收紧**：旧行为把整份宿主环境（含 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY` 等）灌进 native CLI 子进程；现改为 opt-in。真实部署若需某个 key，必须经 `sandboxGrant.extraEnv` 显式传入（并在部署批中审计该显式面）。

### 3. 入站客户端 tool call 请求接 session-permission-broker（V47）

- 新增可选 `permissionBroker` 端口。入站请求判定（`message.method && message.id !== undefined`）从**毯式 `-32601`** 改为 `handleClientRequest`：
  - **缺省（无 broker）→ 全拒**，JSON-RPC error 携带**固定 code** `NATIVE_ACP_CLIENT_TOOL_DENIED`（与旧行为等价，但走显式拒绝路径且带可机器判读的 code）。
  - **method → tool 种类映射**：`fs/read_text_file→read`、`fs/write_text_file→edit`、`terminal/*→execute`、其余→`other`（broker 视为未知种类，fail-closed）。
  - **有 broker**：每条入站请求适配为 `broker.handlePermissionRequest({ sessionId: nativeSessionId, toolCallId, tool:{kind}, rawInput: params, options:[{kind:'allow_once',optionId:'once',name:'once'}] })`。
  - **toolCallId 唯一性**：`toolCallId = \`${nativeSessionId}:${message.id}:${toolCallSeq++}\``——**每个入站 id 生成唯一值，绝不复用**；同一入站 id 重放会得到**新的** toolCallId，满足 broker 的“任何裁决都烧 toolCallId”一次性语义。
  - **denied → JSON-RPC error 携带 broker 的 denial code**（如 `session-closed`、`replay`、`no-approval`、`unknown-tool-kind`…），置于 `error.data.code` 与 message 文本中。
  - **broker 抛错 → 按拒绝处理**，code = `NATIVE_ACP_BROKER_ERROR`，原始错误信息记入 `result.brokerErrors`（**不静默放行**）；prompt 本身不因此中止。
  - **allowed → 仍回诚实 unsupported**：code = `NATIVE_ACP_CLIENT_TOOL_UNSUPPORTED`，仍是 `-32601` error（**不伪造 result**）。理由：executor `initialize` 里 advertise `clientCapabilities.fs = { readTextFile:false, writeTextFile:false }` 且不为 agent 代执行 fs/terminal；**allow 只意味着权限层不拒，不意味着本执行器具备执行该工具的能力**，能力缺口如实上报（此取舍见下“未覆盖项”）。
- broker 裁决写响应后，`finally` 前 `await Promise.allSettled([...clientRequests])`，确保在杀子进程前排空全部裁决写盘。

## 负例清单与原始结果

`npm run test:native-acp-executor`（11 用例全绿）中的关键负例/断言（原始结果：全部 pass）：

| # | 用例名 | 断言要点 | 结果 |
| --- | --- | --- | --- |
| 1 | spawns through the sandbox port with a spec derived from cwd, command and grant | spy sandbox 被调用 **1 次**；`spec.workspaceDir='/tmp'`；`spec.execLiterals=['<node>']`；`readLiterals=['/tmp/read.txt']`；`writeLiterals=['/tmp/write.txt']`；`denyNetwork=true` | ✔ |
| 2 | nativeAcpSandboxSpec defaults read/write to empty and denyNetwork to false | 缺省 spec = `{execLiterals:['/bin/echo'], workspaceDir:'/synthetic/ws', readLiterals:[], writeLiterals:[], denyNetwork:false}` | ✔ |
| 3 | child env is a minimal host allow-list …, never the full process.env | 宿主设 `SECRET_MARKER=TESTONLY`；纯函数 `nativeAcpChildEnv` 键集 = `EXTRA_FLAG/HOME/LANG/PATH/TERM/TMPDIR`，**无 SECRET_MARKER**；非字符串 grant 值被忽略；端到端子进程报告 `env.secret=null`、`env.extra='yes'` | ✔ |
| 4 | with no permission broker an inbound client tool call is denied with the fixed code | 无 broker 时入站 `fs/read_text_file` 得到 `error.data.code===NATIVE_ACP_CLIENT_TOOL_DENIED`、`error.code===-32601`、`result===null`、`brokerErrors===[]` | ✔ |
| 5 | a broker denial is surfaced verbatim as the JSON-RPC error code | broker 返回 `{outcome:'denied',reason:'session-closed'}` → 子进程见 `error.data.code==='session-closed'`；broker 收到 `sessionId='native-broker'`、`tool.kind='read'`、`options=[{kind:'allow_once',optionId:'once',name:'once'}]`、`rawInput={path:'a.txt'}` | ✔ |
| 6 | a broker allow still returns an honest unsupported error (no capability is faked) | broker 返回 `{outcome:'allow_once'}` → 子进程见 `error.data.code===NATIVE_ACP_CLIENT_TOOL_UNSUPPORTED`、`error.code===-32601`、`result===null`（**不伪造结果**） | ✔ |
| 7 | a broker that throws is treated as a denial and is recorded, never silently allowed | broker 抛错 → `error.data.code===NATIVE_ACP_BROKER_ERROR`、`result===null`、`result.brokerErrors=['broker exploded']`、`stopReason==='end_turn'`（prompt 未中止） | ✔ |
| 8 | a replayed inbound request id never reuses a toolCallId | 同入站 id `7` 重放 2 次 → broker 被调用 2 次，`calls[0].toolCallId !== calls[1].toolCallId`；两响应 code 均为 `replay` | ✔ |
| 9 | inbound methods map to broker tool kinds and unknown methods fail closed | `fs/read_text_file→read`、`fs/write_text_file→edit`、`terminal/create→execute`、`mystery/method→other` | ✔ |
| 10 | the default sandbox port is the real Seatbelt wrapper, which refuses a non-absolute command | 不注入 sandbox 且 `command='relative-command'` → 抛 `INVALID_SPEC`（证明默认端口 = 真实 `wrapWithSandbox`） | ✔ |
| 11 | a synthetic prompt completes through the real Seatbelt wrapper (no spy injected) | 不注入 sandbox，假 agent 经**真实 `/usr/bin/sandbox-exec`** 跑通；入站默认拒绝 code 正确 | ✔ |

- 负例均为**合成夹具**：假 agent 是测试内写的 Node 小脚本（`JSON.stringify` 内联入站请求），经 `command/args` 参数 spawn；`cwd='/tmp'`；无外呼、无真实 CLI、无真实用户文件。第 11 条的真实 Seatbelt 只作用于本机系统二进制（`node`）与自建 stdin/stdout，`denyNetwork` 未放开（无网络请求）。

## 验证（全绿）

| 套件 | 命令（cwd=仓库根） | 结果 |
| --- | --- | --- |
| native-acp-executor（本批新增） | `npm run test:native-acp-executor` | **11/11 pass，exit 0** |
| native-sandbox（含真实 OS 执法，回归） | `npm run test:native-sandbox` | **20/20 pass，exit 0** |
| control-plane（含既有 native prompt 覆盖，回归） | `npm run test:control-plane` | **21/21 pass，exit 0** |
| runtime-policy（含 approval-authority/acp-permission-broker，回归） | `npm run test:runtime-policy` | **35/35 pass，exit 0** |
| session-permission-broker（相关 broker 回归） | `npm run test:session-permission-broker` | **25/25 pass，exit 0** |

- 关键输出摘要（`npm run test:native-acp-executor`）：

```
✔ runNativeAcpPrompt spawns through the sandbox port with a spec derived from cwd, command and grant
✔ nativeAcpSandboxSpec defaults read/write to empty and denyNetwork to false
✔ the child env is a minimal host allow-list plus explicit grant keys, never the full process.env
✔ with no permission broker an inbound client tool call is denied with the fixed code
✔ a broker denial is surfaced verbatim as the JSON-RPC error code
✔ a broker allow still returns an honest unsupported error (no capability is faked)
✔ a broker that throws is treated as a denial and is recorded, never silently allowed
✔ a replayed inbound request id never reuses a toolCallId
✔ inbound methods map to broker tool kinds and unknown methods fail closed
✔ the default sandbox port is the real Seatbelt wrapper, which refuses a non-absolute command
✔ a synthetic prompt completes through the real Seatbelt wrapper (no spy injected)
ℹ tests 11  ℹ pass 11  ℹ fail 0
```

- **既有覆盖未回归**：`control-plane.test.mjs` 的 `native ACP resume+prompt executor…` 两用例只传 `command/args`（不注入 sandbox），现默认走真实 Seatbelt；跑通（21/21）。即“默认端口 = 真实沙箱”对既有合成用例是可运行的。

## 未覆盖项与诚实边界声明

- **真实 CLI exec 探测与 `execLiterals` 定案（未覆盖）**：本切片不启动真实 Codex/OpenCode/任何真实 Agent CLI，故**未观测**真实 CLI 启动/运行所需的 exec 字面集与间接 exec 面；`execLiterals` 目前仅含所选命令本身。真实 CLI 间接 exec 探测属**单独授权批**。
- **真实 Grant 派生（未定案）**：`denyNetwork` 缺省 `false`、read/write literals 缺省空，**未依据真实 Grant/真实 CLI 行为定案**。CLI 自读的配置/auth 目录（如 `~/.codex`、`~/.opencode`）的读授权与真实网络策略，**必须在探测/部署批中观测后定案**（见前文 ⚠️ 标注）。在此之前默认 spec 不保证真实 CLI 可在沙箱内正常运行。
- **allow → unsupported 取舍（有意为之）**：broker `allow_once` 不等于 executor 具备执行能力——executor `initialize` advertise `fs:{readTextFile:false,writeTextFile:false}`，且**不为 agent 代执行 fs/terminal**。因此 allow 路径仍返回 `NATIVE_ACP_CLIENT_TOOL_UNSUPPORTED` 的 `-32601` error，**不伪造 fs/terminal 结果**。若未来要让本执行器真正代理 fs/terminal，需要单独设计“能力落地 + 沙箱内执行 + 结果回传”的切片，本切片不含。
- **broker 会话 id 语义的接缝**：合同规定适配调用使用 `sessionId: nativeSessionId`。`session-permission-broker.mjs` 的 `registerSession` 生成自持 `s_...` id（“尚未接入 vendor SessionManager，属后续切片”），故**本切片未做 `nativeSessionId ↔ broker session id` 的映射注册**；真实接线时需在该后续切片中建立映射，否则真实 broker 侧会按 `unknown-session` 拒绝。本切片刻意只锁定端口形状与调用序列（spy broker 断言）。
- **生产未重启**：本批**未重启任何生产服务**，`gateway/control-plane.mjs:186-189` 的调用点未改（仍按原样传参；新参数全部可选、缺省即启用新语义：真实沙箱 + env 白名单 + 无 broker 全拒）。**网关运行态是否已加载新代码、是否需要重启以生效，属部署动作，本批不做**。
- **非 darwin/host 无 sandbox-exec**：默认端口走真实 `wrapWithSandbox`，在非 macOS 或缺 `sandbox-exec` 时 fail-closed 抛 `SANDBOX_REQUIRED`。既有 `test:control-plane` 未做 MAC-gate，故在非 darwin CI 上会因默认沙箱而失败（本机 darwin 全绿）。此为接线约束的如实登记。
- **不关闭项**：本包不关闭 V25/V47 的完整端到端验收，不声称生产接线安全；仅把 executor 的 spawn/env/入站请求三条路径接到既有沙箱与权限原语上。

## 要求审计方做什么

- 按合同逐条复核本批 diff/hash/负例：① spawn 是否确已改走 sandbox 端口且默认无 unsandboxed 回退；② env 白名单是否确为最小集合且 `extraEnv` 为显式 opt-in；③ 入站请求是否每条都经 broker（缺省全拒、broker 抛错按拒、allow 仍 unsupported、toolCallId 绝不复用）。
- 已知不足/需决定的方案：真实 CLI exec 探测与 `execLiterals` 定案；真实 Grant（读 auth 目录 + 网络）派生；`nativeSessionId ↔ broker session id` 的映射注册；allow→unsupported 是否需要后续“能力落地”切片；非 darwin 的沙箱替代。
- 本包为 **r1 首切片**：无“未解决 Finding”；未覆盖项见上一节，均为**后续批或部署动作**，非本切片合同要求关闭的子项。
