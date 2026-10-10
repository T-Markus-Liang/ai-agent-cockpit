# 执行交接包：I01/P0 依赖·许可·遥测审计工具与首轮审计（r1）

遵循[执行交接模板](../collaboration/execution-handoff-template.md)与[双AI协作协议](../plans/0.3.0-collaboration.md)。

## 批次身份与状态

- batchId / revision：i01-dependency-audit / r1
- 状态：**READY_FOR_REVIEW**
- 执行AI：Kimi Code 会话（执行方）；branch `main`；cwd `/Users/markus/ai-agent-cockpit`；工具由该会话 subagent（deepseek-flash）编写，主 Agent 设计审计面并亲自复跑确认退出码
- 已读并确认协作协议：是。允许写入：scripts/、package.json script、docs/decisions/、docs/handoffs/、检查点与台账执行条目
- 对应：I01/P0（依赖/许可/遥测审计）；G0 前置项
- 本批目标：可复跑的只读审计工具 + 首轮真实审计 + 报告。明确不做：CVE/恶意代码扫描、运行期数据流分析、传递依赖全量遥测扫描、依赖安装/修改、commit/push

## 固定来源

- base HEAD：`e8c4317`；工作树含 0.3.0 在途历史未提交内容
- 本批文件（SHA256 于交接时冻结）：
  - `scripts/dependency-audit.mjs`（新增）
  - `docs/decisions/dependency-audit-2026-10-08.md`（新增，真实输出整理）
  - `package.json`（新增 `audit:deps` 一行）
- 依赖：无新依赖（纯 Node ESM，只读）；零联网
- 与其他交接包无文件交集

## 实现、自测与证据

| 审计面 | 工具能力 | 首轮真实结果（主 Agent 复跑确认 exit=1） |
| --- | --- | --- |
| 钉版完整性 | dependencies+overrides 逐项与 lock 精确比对 | **0 漂移**（5 直接 + 6 overrides 全命中） |
| 许可清单 | lock 全 121 包（含传递），allowlist 分类 | 118 合法（MIT 68 / Apache-2.0 34 / BSD-3 12 / Unlicense 2 / ISC 1 / 0BSD 1）；**unknown=3：`@getpaseo/client`、`@getpaseo/protocol`、`@getpaseo/relay`（0.10.3）完全未声明许可**（磁盘与 lock 均无 license 字段，无 LICENSE 文件）——client 为直接运行时依赖 |
| 生命周期 scripts | lock hasInstallScript + 磁盘 scripts 全列 | 9 个（@google/genai、esbuild、protobufjs、gaxios 等，prepare/postinstall）——审核对象非违例 |
| 遥测面 | 仅直接依赖有界扫描（关键词+行号+防爆量） | 全部假阳性/契约命中；**pi-telemetry 经源码核实为惰性契约层**：回调式接口 + NOOP/内存实现，无 exporter、无后端 SDK，dist 内网络原语（fetch/http/net/axios）零命中，本仓库仅类型级 import——**不发数据、不指向端点** |
| vendor | cezar workspaces + wechat-acp 清单 | cezar 声明 4 个 workspace 全 MIT；**另有未声明的 packages/desktop 目录（许可未声明）**；wechat-acp MIT（其依赖含 applicationinsights——Azure APM 真实遥测 SDK，不在本工具扫描范围，建议专项评估） |

- 退出码语义：pinDrift 或 unknown 许可非空 → 1；installScripts/telemetryHits 只报告。首轮 **exit=1（ok=false）是真实发现**，不是误报。
- 边界声明（报告含）：不查 CVE/恶意代码/运行期数据流/integrity；遥测扫描只覆盖 5 个直接依赖，不覆盖 100+ 传递依赖与 vendor 755 包。**这不是全面安全证明**。
- 回归：`npm run test:control-plane` 21/21 通过。
- 状态分列：实现完成 ✅；自测通过 ✅（主 Agent 亲自复跑确认 exit=1 与输出内容）；独立审计：⏳ 待审计 AI；部署/真机：不适用。

## 要求审计方做什么

- 审计范围与重点风险：`scripts/dependency-audit.mjs` 的扫描边界与退出码语义、报告结论。建议重点：① @getpaseo/* 许可未声明的处置（联系上游补声明 / 寻找替代 / 显式风险评估后接受——**需要 Markus 决定**，属 B09/公开维护）；② cezar packages/desktop 未声明部分的处置；③ wechat-acp applicationinsights 的专项评估排期。
- 已知不足/需决定的方案：工具未来可扩展传递依赖遥测扫描与 lock integrity（sha512）校验；@getpaseo/* 许可问题在 G0 放行前必须有结论。
- 等待期间将继续的无冲突独立任务：I02 剩余两项设计提案，或 I01 剩余项（私有数据/旧链接清单、开机加载证明、Paseo 隔离可行性）。
- 非返工 revision（r1 为首次交接）。
