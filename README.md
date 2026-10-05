# AI Agent Cockpit

本目录是本机 AI Agent 调度器的独立部署目录。

当前组件：

- `vendor/cezar`：Cezar 本地 Agent cockpit（手机浏览器访问）
- `vendor/wechat-acp`：微信 iLink → ACP Agent 桥接器

## 当前状态

- Cezar 和微信桥源码已下载
- 两个项目依赖已安装
- 微信桥已完成 TypeScript 构建
- Cezar 服务端和 Web cockpit 已构建
- 微信二维码登录尚未执行，需要人工扫码

## 重要边界

`wechat-acp` 原生连接的是一个 ACP Agent。Cezar 自身是 HTTP/Web cockpit，
不是 ACP Agent，因此两者之间还需要一个小型适配层才能做到“微信 → Cezar 任务队列”。
在适配层完成前，不要把微信桥配置成自动允许任意命令执行。

## 运行目录

- Cezar 默认监听 `127.0.0.1:4321`
- Cezar 用户状态默认写入 `~/.cezar/`
- 微信桥登录状态默认写入 `~/.wechat-acp/`

