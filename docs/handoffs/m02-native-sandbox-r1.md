# 执行交接包：M02/I03d native OS exec 沙箱原语（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。

## 批次身份与状态

- batchId / revision：m02-native-sandbox / r1
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；branch `main`；cwd `/Users/markus/ai-agent-cockpit`；实现由该会话 subagent（deepseek-flash）完成，主 Agent 设计契约、亲自复跑
- 已读并确认协作协议：是。允许写入：control-plane/ 新模块、tests/、package.json script、docs/handoffs/、检查点与台账执行条目；goal-access-broker.mjs 只参考未改；runtime/* 未触碰
- 对应：M02 / I03d（第三切片）；验收 V25（路径越界/symlink/不可修改检查/网络由 OS 约束拒绝）的 **native 侧首个真实 OS 级证据**
- 本批目标：可复用 Seatbelt 沙箱原语 + 真实执法测试。明确不做：native-acp-executor 接线（后续切片）、Pi runtime 侧接入、生产、commit/push

## 固定来源

- base HEAD：`e8c4317`；工作树含 0.3.0 在途历史未提交内容
- 本批文件（SHA256，2026-10-08 冻结）：
  - `control-plane/native-sandbox.mjs`（新增）`b6a2cbf3…fc8251`
  - `tests/native-sandbox.test.mjs`（新增，13 用例）`dfd6e52a…21257a`
  - `package.json`（新增 `test:native-sandbox` 一行）`6b0d01b8…39c8043`
- 形态参照（只读未改）：`control-plane/goal-access-broker.mjs:82-106`
- 依赖：无新依赖（node:fs 内置）；真实执法测试调系统 `/usr/bin/sandbox-exec` + mkdtemp
- 与前九份交接包无文件交集
- 自测前后 sourceRef 一致

## 实现、自测与证据

| 要求/Case | 当前实现 | 验证命令与 cwd | 退出码/断言/效果 | evidenceRef | 尚未覆盖 |
| --- | --- | --- | --- | --- | --- |
| V25 越界写（真实 OS） | profile `(deny file-write*)` 仅放行字面 + /dev/null；真实 sandbox-exec：无 writeLiteral 时写入临时目录 → **exit 1 且文件不存在** | `npm run test:native-sandbox`（仓库根） | 13/13 pass，exit 0 | 本文件 | symlink 攻击面的专项负例（接线切片补） |
| V25 越权 exec（真实 OS） | `(deny process-exec)` + 白名单 literal；真实：白名单外 /usr/bin/true → **exit 71**，同 profile 内 /bin/echo → exit 0（对照） | 同上 | 通过 | 同上 | — |
| V25 网络拒绝（真实 OS） | `(deny network*)`；真实：宿主侧同 URL 可达（HTTP 200 对照）+ 沙箱内 echo 基线正常，沙箱内 curl → **exit 7**（区分了"网络被拒"与"服务不可达"） | 同上 | 通过 | 同上 | — |
| V25 私有读拒绝（真实 OS） | 默认 deny /Users、/private/var/folders、/private/tmp、/Volumes subpath + file-read-metadata 放行；真实 cat 临时目录文件 → **exit 1** | 同上 | 通过 | 同上 | — |
| fail-closed 可用性 | 非 darwin 或无 sandbox-exec → `SANDBOX_REQUIRED`，无回退（stub existsSync 验证）；wrapWithSandbox 只包装 exec 白名单内命令（否则 INVALID_SPEC） | 同上 | 通过 | 同上 | Linux bubblewrap/landlock 替代（跨平台项，未开始） |
| 最小环境 | sandboxEnv 精确 `{PATH:/usr/bin:/bin, LANG, NO_COLOR}`，不继承宿主 env | 同上 | 通过 | 同上 | — |
| 回归 | Goal/权限套件 | `npm run test:goals` / `test:runtime-policy` | 60/60、27/27 pass | 本文件 | — |

- 真实模型/原文外呼/生产读写/原生会话/微信外发：**均未发生**；真实 sandbox-exec 只作用于 mkdtemp 临时目录与本机 echo/sh/cat/curl（127.0.0.1 回环）。
- 失败、部分结果和不明副作用：无。偏差如实登记：/bin/sh 需附带 /bin/bash（macOS sh 会 re-exec bash variant，代码注释说明）；⑪ 用 profile 直连验证 OS 层拒绝（wrap 层本身也拦）；mach-lookup 仅 deny securityd（未含 goal-access-broker 的 xpc 名）。
- 活动进程/job/handle：无。
- 数据守恒、回退和恢复方法：删除两个新文件即完全回退；测试临时目录已清理。
- 状态分列：实现完成 ✅（本批范围）；自测通过 ✅（主 Agent 亲自复跑，含真实 sandbox-exec 执法）；独立审计：⏳ 待审计 AI；部署/真机：未做。

## 要求审计方做什么

- 审计范围与重点风险：`control-plane/native-sandbox.mjs` 与测试。建议重点：① profile 子句与 goal-access-broker 的同构忠实度（是否存在被 allow default 放过的面）；② 转义正确性（引号/反斜杠/Unicode）；③ 真实执法测试的判定严谨性（exit code 与拒绝原因的对应是否唯一）；④ /bin/sh→/bin/bash variant 的附带放行是否过宽。
- 已知不足/需决定的方案：native-acp-executor 接线方式（全 env spawn 改 sandbox 包装 + execLiterals 白名单策略——真实 CLI 依赖的间接 exec 会随白名单收紧而暴露，需要一次真实 CLI 探测切片）；symlink 负例专项；Linux 替代（bubblewrap/landlock）未开始。
- 等待期间将继续的无冲突独立任务：M02 联合回归汇总 + I03 剩余项（roles 统一、vendor SessionManager 接线设计）。
- 非返工 revision（r1 为首次交接）。
