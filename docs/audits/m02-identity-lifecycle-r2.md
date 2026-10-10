# M02 identity lifecycle r2 审计

交接：[m02-identity-lifecycle-r2](../handoffs/m02-identity-lifecycle-r2.md)。主审未参与功能实现；只操作自建tmp文件，无真实chmod/凭据轮换或服务重启。

## 裁决

**COMPONENT_ACCEPTED（RR-F004安全元数据缓存顺序）；RR-F004关闭。** 不等于所有身份生命周期/HTTP/MCP/权限接线完成。

交接原r2声明request-authority `a279820e…`；现文件SHA256为 `6e602a674a5ace9b3443dc0901f948c15662d6c654fe5823e9b83d636de8844d`，测试为 `f713b1d911ef1143a2065da785931490808a338468d9c365a75680744ef8e6b6`。后续native scope/cancel切片造成整文件差异，本文按当前合成来源复核缓存函数，不把它们自动接受。

源码已把同fd的普通文件/UID/mode/size检查移到cache短路前；缓存只省解析，不省安全检查。错误不会回落旧cache，O_NOFOLLOW仍在。

原独立反例：600先正常认证→chmod644且ino/mtime/size保持相等→现在抛AUTH_CONFIGURATION，不再接受token。未动任何真实auth文件。request-authority18个用例及与Goal/身份的联跑总45项通过；含暖cache漂移、首次危险mode、恢复600、删除/符号链接、轮换/吊销/过期与解析缓存正常路径。

仍保留且不隐瞒：同inode/同size且刻意还原mtime的就地内容修改可能命中解析缓存，写者应使用已验证的tmp+rename；本轮不承诺防任意同UID恶意文件改写或clock异常。真实生产文件的安全mode/内容/签发仍另验，不因本组件通过而自动配置权限。

执行方可继续接统一authority chokepoint；RR-F001生产签发/客户端映射未关闭。证据见[本轮目录](evidence/2026-10-08-followup/README.md)。
