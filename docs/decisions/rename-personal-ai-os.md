# 项目命名统一决策（Personal AI OS）

日期：2026-10-08
状态：批次 1 已完成；批次 2 待 0.3.0 发布切换时执行

## 背景

重构后产品名已为 Personal AI OS（npm 包名 `personal-ai-os`，launchd 标签 goals/memory 已用新名），但 Git 仓库名、本地目录名、6 个 launchd 标签、控制面状态目录仍沿用 `ai-agent-cockpit`。`cezar` 字样约 217 处，但绝大多数是第三方上游 `vendor/cezar`（`@open-mercato/cezar`，MIT，github.com/open-mercato/cezar）及其适配器引用，属依赖名而非项目名。0.3.0 执行计划（`docs/plans/0.3.0-execution.md:9`）明文约定迁移期保留旧路径与旧标签，故改名分两批。

## 命名目标

| 维度 | 现状 | 目标 |
| --- | --- | --- |
| GitHub 仓库 | ai-agent-cockpit | **personal-ai-os（已完成）** |
| 本地目录 | /Users/markus/ai-agent-cockpit | /Users/markus/personal-ai-os |
| launchd 标签（8 个） | 6 旧 2 新 | 全部 com.markus.personal-ai-os.* |
| 控制面状态目录 | ~/.local/state/ai-agent-cockpit/ | ~/.local/state/personal-ai-os/（并入 control-plane.json） |
| 微信实例名 | cezar-codex | personal-ai-os |
| antigravity-proxy | 与本仓无关 | 不动 |

`PERSONAL_AI_OS_STATE_DIR` 覆盖能力保留。`vendor/cezar` 与代码中对 Cezar 组件的适配器引用保持原名，README 以"上游与致谢"致谢。

## 批次 1（2026-10-08 完成）

- GitHub 仓库重命名为 `T-Markus-Liang/personal-ai-os`，旧地址自动重定向；本地 remote 已更新。
- README 叙述措辞统一，新增"上游与致谢"一节。
- 本决策文档落盘。

## 批次 2 执行清单（随 0.3.0 发布切换，需停机窗口）

1. 停服务：`launchctl bootout` 8 个标签（注意 `~/Library/LaunchAgents/` 下 7 份运行副本与仓库内 plist 是两份，control-plane 从仓库内 plist 加载）。
2. 改 `launchd/*.plist`：Label 统一为 `com.markus.personal-ai-os.*`；33 处绝对路径改为 `/Users/markus/personal-ai-os`；同步 `~/Library/LaunchAgents/` 副本。
3. `mv /Users/markus/ai-agent-cockpit /Users/markus/personal-ai-os`。
4. 重建 `.venv-memory`（venv 内 19 处硬编码 shebang，不可直接搬）：`python3 -m venv .venv-memory` 并重装 `services/memory` 依赖。
5. `config/wechat-acp.json` 6 处绝对路径（personaFile、agent.cwd、4 个 opencode fallback）。
6. `control-plane/store.mjs:17` 默认状态目录改为 `~/.local/state/personal-ai-os`；迁移 `control-plane.json`（0700，先拷贝验证再删旧目录）。
7. 微信实例改名：`mv ~/.wechat-acp/instances/cezar-codex ~/.wechat-acp/instances/personal-ai-os`；改 wechat-bridge plist 的 `--instance` 与 `gateway/goals.mjs:14` 默认值。token/state 随目录走，微信登录不丢。
8. 更新 README、EXECUTION.md、docs 中的目录与标签叙述。
9. 验证：8 服务 health + `npm run doctor` + `npm run test:control-plane` + 微信 `/消息` 抽查收发。
10. 回退预案：批次 2 前对 `launchd/`、`~/Library/LaunchAgents/`、`config/wechat-acp.json` 做私有备份；出问题 `mv` 回旧目录名并恢复备份即可。

## 风险与边界

- 微信身份与实例数据在 `~/.wechat-acp/`（基于 home 目录），不依赖仓库位置，改目录名不影响登录态。
- `~/.local/state/` 各目录同样基于 home 目录，不断裂；唯一需要代码改动的是 `store.mjs:17` 默认值。
- 不改名清单：`vendor/cezar` 上游、`adapters/engines/cezar.mjs` 等组件适配器（与 codex/opencode 并列的依赖名）、antigravity-proxy。
