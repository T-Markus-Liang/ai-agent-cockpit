# 脱敏专项证据

见 [审计与执行交接](../../2026-10-08-secret-scan.md)。这里只保存元数据、测试输出和完全假 SDK 的探针，不保存真实 API Key、GitHub alert secret 字段、未脱敏 Match/Secret 或私有凭据文件。

- `scope-and-results.json`：冻结版本、公开 mirror refs、扫描命中位置/类型、Google假样例来源、告警元数据、凭据对照计数、测试及源码哈希。
- `suite.log`：测试输出摘录；4个相关文件的188条用例通过，server typecheck通过。
- `telemetry-probe.mjs`：可重复的合成探针，默认从本机项目读 telemetry 源码，所有外部 SDK 和 fs 均为 fake。未调用真实 telemetry。
- `telemetry-probe-results.json`：默认环境裸异常抵达假SDK，明确关闭时不初始化、不交付异常。

本机临时只读扫描资产位于 `/tmp/personal-ai-os-secret-audit.w2M4sz`；不是生产安装。Gitleaks8.30.1归档已按官方发布SHA256核验。原始工作树/mirror没有上传到外部模型。

复跑相关测试（已安装并锁定的Vitest，禁止npx获取其他版本）：

```bash
cd /Users/markus/ai-agent-cockpit/vendor/cezar
CEZ_HOME=/tmp/personal-ai-os-secret-audit.w2M4sz/cez-test-state TMPDIR=/tmp/personal-ai-os-secret-audit.w2M4sz CEZ_DRY_RUN=1 WECHAT_ACP_TELEMETRY=0 npm test -- packages/cezar/src/core/secret-redaction.test.ts packages/cezar/src/core/agent-env.test.ts packages/cezar/src/runs/run-secrets.test.ts packages/cezar/src/runs/store.test.ts
npm run typecheck:server
```

复跑遥测探针（Node24；不启动应用或服务）：

```bash
cd /Users/markus/ai-agent-cockpit
node docs/audits/evidence/2026-10-08-secret-scan/telemetry-probe.mjs
```

探针开发期间的两次 harness 失败分别来自TypeScript7原生包没有旧JS transpile API、VM loader名称被被测源码局部require遮蔽；修正为Node stripTypeScriptTypes与独立auditRequire后复现成功。两次失败不是产品缺陷证据，未据此作安全判断。

实际扫描采用 `gitleaks dir <冻结目录>` 与 `gitleaks git <公开mirror> --log-opts='--all --full-history'`，均带 `--redact=100 --ignore-gitleaks-allow --max-decode-depth=5 --max-archive-depth=3`，不使用baseline。默认原始命中仍分别为4和6，因此exit1是“需要逐项复核”，不是扫描器故障，也不是整体全绿。
