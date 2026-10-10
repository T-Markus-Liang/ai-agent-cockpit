# 许可证核验记录（2026-10-10）

## 1. `@getpaseo/*` 三包（client / protocol / relay，锁定 0.10.3）

| 包 | package.json license 字段 | 包内 LICENSE/NOTICE 文件 | npm repository 字段 | 结论 |
| --- | --- | --- | --- | --- |
| @getpaseo/client 0.10.3 | **缺失** | 无 | 缺失 | 上游 Apache-2.0（已核原文），缺字段 ≠ 无许可 |
| @getpaseo/protocol 0.10.3 | **缺失** | 无 | 缺失 | 同上 |
| @getpaseo/relay 0.10.3 | **缺失** | 无 | 缺失 | 同上 |

**上游核验（一手证据）**：`https://raw.githubusercontent.com/getpaseo/paseo/main/LICENSE` 原文——"Copyright (c) 2025-present Mohamed Boudra … Paseo is licensed under the Apache License, Version 2.0"。整改方案 §7 要求的"上游根 Apache-2.0 与包缺 license 字段分别记录"已落实：根许可 = Apache-2.0 ✅；包级字段缺失为上游打包瑕疵（已记录，不修改第三方 metadata 伪造结论）。

**处置建议（待 owner 裁决）**：
- 选项 A（保守）：维持依赖，发布文档中声明"上游 Apache-2.0、包级 license 字段缺失（上游瑕疵）"。
- 选项 B（洁癖）：升级 0.11.x 观察字段是否补上（npm 最新 0.11.2 经核仍缺字段），或向 upstream 提 issue。
- 选项 C（移除）：若 Paseo 可选路径最终不纳入发布承诺（整改方案 §7 技术取舍），随依赖一并移除。

## 2. 仓库本体 LICENSE / NOTICE

- 现状：repo 根 **LICENSE 与 NOTICE 均不存在**。
- 方案（待 owner 选许可证后落地）：建议 Apache-2.0（与上游生态一致）；NOTICE 需列：cezar（vendor，其自身许可证见 vendor/cezar/LICENSE*）、wechat-acp（vendor）、mem0/qdrant/sentence-transformers 等运行时依赖不随仓库分发（以 requirements/package lock 声明为准）。vendor/cezar 与 vendor/wechat-acp 各自带 license 文件，发布前逐个点名核对（vendor/cezar 为 Open Mercato 系，AGENTS.md 已声明致谢关系）。

## 3. vendor/desktop 许可

- 待办：`vendor/cezar/packages/desktop` 目录的分发形态确认（是否进入发布产物）；其依赖（Electron 系）不在仓库分发范围内。结论随 LICENSE 选型同批落地。
