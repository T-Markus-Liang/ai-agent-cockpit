# 发布前逐项签收 Tracker（首扫，2026-10-10）

状态图例：✅ 有证据闭环 ／ 🟡 部分证据、待补 ／ ⬜ 未执行 ／ ⚖️ 待 owner/审计裁决。
本文件是**首扫 tracker，不是签收结论**；逐项状态以证据链接为准，审计逐项复核后方可转为签收。

## C01–C15 裁剪（docs/plans/0.3.0-pruning.md）

当前整体状态：**⬜ 裁剪批未执行**。本机测试上线 ≠ 裁剪完成——当前跑的是"未裁剪的 0.3.0 分支代码"，C 项大多要求"先替代再删除/删除旁枝"，属发布前治理批。

| 项 | 首扫状态 | 说明 |
| --- | --- | --- |
| C01 acp blanket requestPermission 无条件放行 | ⬜ | 未动；替换需 Grant/Approval 绑定的权限决策 |
| C02 旧 processQueue 重复调度 | ⬜ | 未动 |
| C03 goal-runtime 与 Pi scheduler 重复调度 | ⚖️ | 与双权威裁决联动（见 decisions/dual-authority-*） |
| C04 MessageInbox 旧执行状态 | ⬜ | 未动 |
| C05 pending-text 内存补发 → 持久 ReplyOutbox | ⬜ | 未动（补发语义 D86 后仍走旧路径） |
| C06 双 summary 喂入 | ⬜ | 未动 |
| C07 自动 fallback 混入未验证 Worker | ⬜ | 未动；注意 D89 的 goal-ai fallback 是**显式回落+身份如实**，不属于 C07 指责的"混入未验证"（worker 身份落盘可审） |
| C08/C09/C11 cezar 旁路路由/拖拽 builder/StarPromo | ⬜ | vendor 内，cezar 自身演进可能已动；发布前按当前 vendor HEAD 复核 |
| C10 automations 双调度 | ⬜ | 未动 |
| C12 telemetry 远程上报 | ⬜ | "不能说当前已禁用"——保持未宣称 |
| C13 固定结束尾语 | ⬜ | 未动 |
| C14 不重复实现 durable engine | ✅ 设计遵守 | goals/:4324 复用 store 库未重写状态机；D89 实测 |
| C15 未验证云 Agent/第二产品不进默认 | ✅ 当前遵守 | Jules/Colab 均为带外授权制；Pocket 未接管 |

## G0–G6/G5c（长期合同项）

| 组 | 首扫状态 | 证据/缺口 |
| --- | --- | --- |
| 身份/每客户端 token（G4 系） | ✅ | S02 实盘 11/11 + 真实消息链路 |
| 绝对期限贯穿（G 系 S03） | ✅ | LIMIT_REACHED 实测（D89） |
| 快照/恢复安全（S01/G5） | 🟡 | S01 返工批在 D84 前已交付（SN-F001/002/003），本轮未复验；发布前跑一轮快照回归 |
| 记忆隐私 epoch（G 系） | 🟡 | D84 三 P1 修复+独立复核；生产迁移演练未做 |
| fallback 不延长授权 | ✅ | D89：fallback 只换 inference 端点，grant 期限不变（LIMIT_REACHED 在 fallback 存在下仍触发） |

## V01–V52（docs/plans/0.3.0-validation.md）

与 C/G 映射交叉。已实测面：V23/V24（secret scan PASS 多轮）、V08/V49 相关（双 CLI dry-run 生命周期）、goal 链验收（3/3 checks ×2 次真实运行）。**逐项映射到 52 条的核对表未建**——建表+逐项挂证据属发布前专批（估 1 批）。

## 旧告警

- alert #1（上游合成样例误报）：处置于 D85r 批次（精确 path+sha256 处置，PASS 0 未处置）——✅ 按"该具体授权"关闭，未顺带 dismiss 其它告警。

## 待裁决汇总

双权威选项（decisions/dual-authority-*）、LICENSE 选型（audits/2026-10-10-license-findings.md）、uncertain=1 归档口径（audits/2026-10-10-durable-inbox-disposition.md）、C03 与双权威的联动。
