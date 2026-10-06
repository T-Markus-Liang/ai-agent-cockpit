# AI Agent Cockpit

本目录是本机 AI Agent 调度器的独立部署目录。

当前组件：

- `vendor/cezar`：Cezar 本地 Agent cockpit（手机浏览器访问）
- `vendor/wechat-acp`：微信 iLink → ACP Agent 桥接器
- `gateway/wechat-control.mjs`：回环地址上的二维码生成、扫码状态轮询和登录状态 API

## 当前状态

- Cezar 和微信桥源码已下载
- 两个项目依赖已安装
- 微信桥已完成 TypeScript 构建
- Cezar 服务端和 Web cockpit 已构建
- 微信二维码登录已完成，当前账号已连接
- 微信桥使用官方 `@agentclientprotocol/codex-acp`，避免旧版适配器与本机 Codex 配置不兼容
- 微信桥、Cezar 和二维码控制服务已安装为 macOS launchd 常驻服务，息屏后不会依赖当前终端会话
- `keepawake` launchd 服务使用 `caffeinate -i -m`，防止电池模式下的 idle/maintenance sleep；会增加耗电，不等同于合盖硬件 clamshell 保活保证
- 微信回复采用朋友型中文助理人格，参考长期主义和价值投资思维，不冒充任何真人
- Settings → Local agents 展示 Codex、OpenCode、Claude Code、Antigravity、WorkBuddy、Devin 的本机接入边界；GUI-only 应用不会被伪装成可自动调度的 CLI
- WorkBuddy 的内置 `codebuddy --acp` 和 Kimi 的 `kimi acp` 已加入本机 fallback 通道；Devin 目前仍只有桌面 CLI（文件/窗口操作），没有稳定的 Agent ACP 调度接口
- 微信 ACP 在主 Codex 初始化/单轮超时且尚未产生回复时，按 DeepSeek → Kimi → GLM → Antigravity Gemini 顺序尝试本机 fallback；provider URL、认证由本机已有配置/反代提供，不写入 Git
- Cezar 前端已增加中英文切换按钮
- 全局设置中已增加 WeChat 连接页面

## 重要边界

`wechat-acp` 原生连接的是一个 ACP Agent。当前 bootstrap 配置将微信消息送到本机 Codex，
Cezar cockpit 独立管理任务和工作树；后续可以把 `gateway/` 扩展成“微信 → Cezar HTTP
任务队列”的适配层。微信控制服务只绑定 `127.0.0.1`，不会对局域网开放。

## 运行目录

- Cezar 默认监听 `127.0.0.1:4321`
- Cezar 用户状态默认写入 `~/.cezar/`
- 微信桥登录状态默认写入 `~/.wechat-acp/`

## 启动

```bash
cd /Users/markus/ai-agent-cockpit
node vendor/cezar/packages/cezar/dist/index.js --repo "$PWD" --port 4321 --no-open
node gateway/wechat-control.mjs
```

打开 `http://127.0.0.1:4321/settings/global/wechat` 可以查看微信状态；未连接时点击按钮生成二维码。
