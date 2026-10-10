# 项目命名统一决策（Personal AI OS）

日期：2026-10-08
状态：批次 1 已完成；批次 2 待 0.3.0 发布切换时执行

本轮只读复核：package名、产品文档、origin与GitHub均为personal-ai-os；GitHub API确认仓库公开（isPrivate=false）。本地目录、6旧前缀、控制面默认状态路径与cezar-codex实例仍在原位。本轮未执行改目录/服务/实例操作，当前进度见[阶段台账](../plans/0.3.0-status.md)。

## 背景

批次1前，产品/npm及goals/memory标签已用新名，Git仓库、本地目录、6个标签和控制面状态仍用旧名；批次1后Git已改名，本地兼容项仍待迁移。Cezar主要是第三方上游vendor/cezar（MIT）及适配器引用，属于依赖名而非本产品名，不能全局替换。执行计划约定过渡期保留旧路径/标签，因此分两批。此前217处Cezar字样、33处plist路径和19处venv shebang为历史盘点数，执行前须重新生成精确manifest，不当作当前已复核数量。

## 命名目标

| 维度 | 现状 | 目标 |
| --- | --- | --- |
| GitHub 仓库 | personal-ai-os，公开 | personal-ai-os（已完成） |
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

以下是待实施计划，不是本轮可直接执行的命令。先满足P6/G5的备份、唯一owner/停写、干运行和回退门槛，再取得具体切换范围。目标目录/标签/状态/实例若已存在，先核对冲突，禁止覆盖或合并未知数据；新旧标签不得同时拥有同一任务。保持可靠唤醒条件，不能在切换途中误让机器休眠。

1. 停服务：`launchctl bootout` 8 个标签（注意 `~/Library/LaunchAgents/` 下 7 份运行副本与仓库内 plist 是两份，control-plane 从仓库内 plist 加载）。
2. 改 `launchd/*.plist`：Label 统一为 `com.markus.personal-ai-os.*`；33 处绝对路径改为 `/Users/markus/personal-ai-os`；同步 `~/Library/LaunchAgents/` 副本。
3. `mv /Users/markus/ai-agent-cockpit /Users/markus/personal-ai-os`。
4. 重建 `.venv-memory`（venv 内 19 处硬编码 shebang，不可直接搬）：`python3 -m venv .venv-memory` 并重装 `services/memory` 依赖。
5. `config/wechat-acp.json` 6 处绝对路径（personaFile、agent.cwd、4 个 opencode fallback）。
6. 控制面默认状态目录改为目标命名空间；迁移前核对personal-ai-os下现有memory/goals数据，明确control-plane文件和协调记录的精确归属。停写、一致备份、逐文件验证权限/摘要后移交，旧副本先只读保留；不直接删整个状态目录。
7. 微信实例按精确manifest移交至personal-ai-os，同步bridge的`--instance`与Goal默认state引用；token/state及收件、归档、待发正文/clientId/游标均需私有备份和守恒核对。身份保持是验收要求，不预先保证移动后登录一定不丢。
8. 更新 README、EXECUTION.md、docs 中的目录与标签叙述。
9. 验证：8 服务 health + `npm run doctor` + `npm run test:control-plane` + 微信 `/消息` 抽查收发。
10. 回退预案：保存定义/已安装副本/配置与一致数据快照；先冻结新真实执行并核对唯一owner，再恢复必要的路径/定义和未来路由。保留全部新任务、新数据和未发clientId，不能把旧数据备份覆盖回来；不能仅凭mv回目录就判定回退成功。

## 风险与边界

- 微信实例基于home而不是仓库，但搬实例本身会改变查找路径；所有读写者、安装定义、待发与身份材料需要单独验证，不能从“基于home”推断无风险。
- 状态/venv/plist/config/默认实例及任何绝对引用均需当前引用图核对；store默认值只是已知一处，不声称只有一行需改。保留PERSONAL_AI_OS_STATE_DIR覆盖，拒绝目标碰撞与秘密日志。
- 不改名清单：`vendor/cezar` 上游、`adapters/engines/cezar.mjs` 等组件适配器（与 codex/opencode 并列的依赖名）、antigravity-proxy。
