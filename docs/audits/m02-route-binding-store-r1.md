# M02 route binding store r1：CHANGES_REQUESTED

2026-10-08。对象：[交接](../handoffs/m02-route-binding-store-r1.md)。源码`1a5fc542…0b35c6`、测试`92e72416…9ae02a`；10/10原用例通过。[版本/私有SQLite夹具/原始探针](evidence/2026-10-08-round3/README.md)。主审未实现本模块，未打开生产DB。

## M02-RBS-F001 — 高 / 阻断：回滚重载失败后，下一重试返回未持久的成功

定位`route-binding-store.mjs:224–245`，reload异常被吞后保留已增长内存；`:240`下一次幂等直接返回。close只关闭DB，不阻止后续API。

两种复现：① close后bind第一次DB错误，第二次同binding返回成功，memorySize=1而重开durableSize=0；② **保持store打开**，另一个合成连接写入不合法JSON并设置INSERT失败trigger，触发写失败+reload失败；下一次同binding仍假成功，该key在DB为0行。后者不依赖“调用已关闭store”的错误用法。所有腐败/trigger仅在自己的临时DB。

返工：失败重载不能保留可用的权威内存；用pre-mutation快照恢复，或把store标为poisoned并拒绝一切权威写/resolve直到受控恢复。所有写路径和close生命周期一致，幂等路径也必须确认当前可用；不因catch住错误就声称零durable/内存偏差。

补测：INSERT/COMMIT失败×reload成功/失败，close各API、幂等重试、intent路径、重开；未COMMIT的record永不被报告为成功persisted。原测试只证明SQLite未COMMIT回滚，不是本wrapper全部故障窗口。

## M02-RBS-E001 — 高 / 接线阻断：未知既有库会被bootstrap

定位`:127–152`，打开即chmod、创建meta/缺失version初始化、创建bindings/intents。复现：已有仅unrelated表的合成库被接管并加三张表；原数据保留，但库已修改。API文档允许absent schema初始化，因此这是明确的**来源/接管设计缺口**，不是伪称违背其所有literal API。

生产接线前：写入/chmod前拒非普通/alias/未知既有DB，fresh空库与有有效本模块namespace/provenance的恢复库区别处理。明确批准的共库迁移另立schema方案，不能默认任何SQLite都是本库。已披露symlink/owner缺口仍未关闭。

同时继承[RB-F001](m02-route-binding-r1.md)的intent身份修复；单writer假设须产品owner/fence实证，binding与Submission原子准入另验，不能把每次一条INSERT说成整个V03跨层事务已满足。
