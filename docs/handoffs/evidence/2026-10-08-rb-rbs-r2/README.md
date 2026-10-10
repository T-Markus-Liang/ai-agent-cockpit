# RB/RBS r2 返工证据

2026-10-08。对象：[route-binding r2 交接](../../handoffs/m02-route-binding-r2.md) 与 [route-binding-store r2 交接](../../handoffs/m02-route-binding-store-r2.md)。回应审计 [RB r1](../../audits/m02-route-binding-r1.md) / [RBS r1](../../audits/m02-route-binding-store-r1.md)。

## 内容

| 文件 | 说明 |
| --- | --- |
| [source-ref.sha256](source-ref.sha256) | 本批全部源码/测试/交接/日志的完整 SHA256（`shasum -a 256 -c` 可自校验） |
| [route-binding-r2.log](route-binding-r2.log) | `npm run test:route-binding` → 15/15，exit 0 |
| [route-binding-store-r2.log](route-binding-store-r2.log) | `npm run test:route-binding-store` → 18/18，exit 0 |
| [legacy-adapter-regression.log](legacy-adapter-regression.log) | 唯一消费者回归 → 14/14，exit 0 |
| [route-binding-negative-on-prefix.log](route-binding-negative-on-prefix.log) | 3 条 RB-F001 负例在**逆向回退到 r1 语义**的临时副本上 → 12/15（3 条新负例失败，exit 1） |
| [route-binding-store-negative-on-prefix.log](route-binding-store-negative-on-prefix.log) | 8 条 RBS 负例在逆向回退副本上 → 11/18（11–16、18 失败，exit 1） |

## 方法与边界

- 全部夹具为 `/tmp` **自建合成**临时目录（`mkdtemp`），无真实用户文件、无生产 DB/服务/launchd、无网络/模型/微信外呼、无 `chmod` 真实文件、未改 `package.json`、**未执行任何 git 命令**。
- 负例的负例：把修复逆向回退到 r1 逻辑的**临时副本**上运行同一套件，证明新负例锚定缺陷（非恒真）。该逆向副本已删除；日志为原始输出。
- COMMIT 失败复现依赖 SQLite 锁语义（第二连接持 SHARED 读事务），本机 Node 24 确定性复现，属环境相关技术。
- 相邻回归套件（identity-pairing 13/13、runtime-ownership 21/21、provider-resolver 12/12）通过，未逐份留日志。
