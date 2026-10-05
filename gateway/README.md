# Local gateway

`wechat-control.mjs` is a loopback-only companion to the Cezar cockpit. It creates and polls the
WeChat iLink QR session, persists the login token with mode `0600`, and starts the already-built
`wechat-acp` bridge after confirmation.
