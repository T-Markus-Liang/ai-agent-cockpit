# M02 native sandbox r1：EVIDENCE_REQUIRED

2026-10-08。对象：[交接](../handoffs/m02-native-sandbox-r1.md)。源码`b6a2cbf3…fc8251`、测试`dfd6e52a…21257a`。[第三轮完整边界/失败与受控OS探针](evidence/2026-10-08-round3/README.md)。主审未实现本模块，不对相似旧goal-access helper自签全部安全性。

原结构7项通过。原13项在外层Seatbelt下尝试时，sandbox_apply被OS拒绝，不能把其读/写失败当本profile成功执法；4324已有服务，测试会复用外来listener，本轮不以它取证。之后采用已读审的parent canary（只碰自建夹具），仅在受测child应用Seatbelt，非嵌套。

实际OS正面证据：echo基线可运行；同一个cat在无grant时读自建private/tmp文件失败、精确literal grant后成功；workspace symlink指向外部合成文件读取被拒；白名单shell有/无writeLiteral的写入对照正确；自建127.0.0.1端口0+nonce的curl网络允许/拒绝对照正确，拒绝请求未到server。没有连接现役4324、启动真实Agent CLI、读取Keychain/用户私有文件。

## M02-NS-E001 — 高 / 完整Grant沙箱接线阻断

定位`native-sandbox.mjs:21,68–83`，allow default加四个deny树并不是“只读授权workspace/系统库”。自建`/var/tmp`（canonical `/private/var/tmp`）夹具在无readLiteral/workspace时被cat读到，exit0。该路径不在公开默认deny列表；这是已验证的**默认策略覆盖缺口**，不是声称全部沙箱无效或当前凭据已泄露。

接线前明确真正的Grant read边界：优先默认deny读数据、仅放明确系统文件/库与授权路径；至少覆盖其他私有temp/状态根并做OS负例，不能把未列目录当公开。所有read/write/exec/network规则从当前Grant/角色派生并绑定版本；cwd仍不是隔离证明。

## M02-NS-N001 — 非阻断防御建议

`denyNetwork`不校验Boolean，数值0被接受且省略network deny。配置由可信宿主提供、合法false本就支持，因此不当作已利用权限漏洞；建议严格bool/schema，未知输入拒绝，并以Grant网络能力校验，而非JS truthiness。

尚未确认：真实CLI间接exec、其他IPC/mach服务面、不同平台、全面symlink/多卷别名和实际executor/权限broker全程。此轮原7结构子项和受控I证据不等于原13项全部重测通过，更不关闭V25/G4。源码/隔离硬化可继续，实际Agent/生产接线另获相应门槛和授权。
