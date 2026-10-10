# 审计记录：durable inbox uncertain=1 旧项处置（脱敏）

日期：2026-10-10。处置人：执行线程（主模型）。状态：**已分类、不重放、待审计确认**。

## 对象

- 位置：`~/.wechat-acp/instances/cezar-codex/inject/failed/inj_2026-10-05T13-55-39-591Z_12b6f6df-bcdc-4c8e-b8da-894893e1911f.json`
- 性质：2026-10-05 13:55 UTC 的合成探针注入（`target: last-active-user`），文本为固定回声指令（"请只回复：最终主链路OK"）。
- 失败原因：`ACP startup timed out after 60000ms`（2026-10-05 13:56:41 UTC）。
- 与 durable recovery 的关系：bridge 重启时 recovery 报 `pending=0, uncertain=1`，该 uncertain 计数即来源于此注入的失败状态未被确认消费。

## 处置结论

1. **禁止静默重放——执行**：该消息为测试期合成探针，非真实用户意图；重放将向 last-active-user 注入过期指令，故不重放。
2. **保留在 failed/ 目录**：作为只读证据保留，不删除（删除会磨灭审计线索）。
3. **archive 建议**：可在审计确认后移至 `inject/done/` 并在 state 中登记处置事件（bridge 若支持 disposition 字段），或维持 failed/ 原样——两种都算闭环，取决于审计口径；本记录默认维持 failed/ 原样。
4. **uncertain=1 的解释**：它不是"丢了一条用户消息"，是"一条已失败的合成注入的最终处置状态未确认"。无真实用户数据损失。

## 隐私边界

本记录不含消息正文外的任何用户数据；该消息本身就是合成探针，无第三方个人信息。原始文件留在私有 700 目录，不进 repo。
