# 执行交接包：I01/P0 私有数据清单与开机加载证据（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。

## 批次身份与状态

- batchId / revision：i01-private-data-boot / r1
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；branch `main`；cwd `/Users/markus/ai-agent-cockpit`；库存由该会话 subagent（deepseek-flash）编制，主 Agent 亲自抽查复核关键项
- 已读并确认协作协议：是。允许写入：docs/decisions/、docs/handoffs/、检查点与台账执行条目；**全程只读元数据，未读取任何文件内容**
- 对应：I01/P0（私有数据/旧链接清单、control-plane 开机加载证明）；P6 迁移前置库存
- 本批目标：私有数据迁移库存 + launchd 加载现场证据。明确不做：读取内容、chmod 修复（生产状态变更，列待确认项）、重启验证、commit/push

## 固定来源

- base HEAD：`e8c4317`
- 本批文件：`docs/decisions/i01-private-data-boot-2026-10-08.md`（新增，清单 39 条 + 证据表）
- 操作边界：仅 stat/du/ls/launchctl print/curl GET/grep——未 cat/head 任何 token、对话、向量、密钥；未停写、未重启、未 launchctl 变更

## 实现、自测与证据

### 任务 1：私有数据清单（39 条，5 组）

控制面状态、personal-ai-os 状态（goals/mem0 分项）、微信实例（12 项）、仓库私有区、外部凭据位置（cc-switch.db、dsh credentials——仅路径）。每条含绝对路径/mode/大小/类别（凭据/对话正文/向量/状态/队列/日志）/迁移注意（停写备份、可重建、含 WAL 需 backup API、含凭据不外传）。

### 任务 2：开机加载证据

**9/9 标签 loaded + state=running + RunAtLoad=true**；端口实测 4321/4324/4325/4326 均 200（4322/4323 为 listen 但无 /health 路由，非故障）。**control-plane 的 plist 在 ~/Library/LaunchAgents 无副本**（从仓库 launchd/ 加载，其余 8 个有副本）——批次 2 改路径时 control-plane 只需同步仓库 plist，另 8 个需两份同改。边界声明：loaded+RunAtLoad 证明"配置为开机加载且当前在跑"，**不等于实际重启验证过**（未重启，须停机窗口另行取证）。

### 权限异常（主 Agent 亲自 stat 复核确认）

| 路径 | 实际 | 预期 | 风险 |
| --- | --- | --- | --- |
| `~/.wechat-acp/instances/cezar-codex/token.json` | **0644** | 0600 | **微信登录凭据组/他人可读**（主 Agent 抽查中新发现，库存未列） |
| `~/.local/state/personal-ai-os/mem0/history.sqlite` | **0644** | 0600 | 对话正文/历史库组/他人可读 |
| `~/.local/state/personal-ai-os/`（根） | 0755 | 0700 | goals/mem0 父目录过宽 |
| `~/.local/state/personal-ai-os/mem0/vectors/`（含 meta.json/.lock 0644） | 0755 | 0700 | 向量目录过宽 |
| `~/.cc-switch/cc-switch.db` | 0644 | — | kimi shim 凭据来源（87M，**外部工具，非本仓处置对象**） |
| `logs/`（含日志文件 0644） | 0755 | 0700 | 可能含消息正文 |

mem0/api-token 为 0600（正确）。**chmod 收紧属生产状态变更，本批未执行，列为下方待确认项。**

- 状态分列：实现完成 ✅；自测通过 ✅（主 Agent 亲自 stat 复核 7 处 + launchctl print 复核 control-plane 来源）；独立审计：⏳ 待审计 AI；部署/真机：未做。

## 要求审计方做什么

- 审计范围与重点风险：库存完备性（39 条是否覆盖全部私有数据面）、权限异常的风险定级。建议重点：① token.json/history.sqlite 0644 的实际暴露面（本机是否多用户）；② 收紧 chmod 的方案与时机（建议随批次 2 停机窗口一并做，或单独小窗口）。
- **待 Markus 确认项**：对 `token.json`、`history.sqlite`、`personal-ai-os/`、`vectors/`、`logs/` 执行 chmod 0700/0600 收紧（纯权限收紧，不改数据、不需重启）。cc-switch.db 属外部工具，不动。
- 已知不足/需决定的方案：旧链接清单（文档内失效引用的全面扫描）建议并入下一轮文档检查；重启加载实测须在批次 2 停机窗口取证。
- 等待期间将继续的无冲突独立任务：I01 的 Paseo 隔离可行性（待 @getpaseo 许可决定）或 I02 剩余两项设计提案。
- 非返工 revision（r1 为首次交接）。
