# M02 provider resolver r1：限定COMPONENT_ACCEPTED

2026-10-08。对象：[交接](../handoffs/m02-provider-resolver-r1.md)。接受纯离线resolver合同，不接受真实provider认证、fallback、部署或公开配置安全。

源码`a9fc0115…8691a7`、测试`e6628053…01725d`。读完源码和12项测试；12/12实跑通过，包含于[第三轮策略46项输出](evidence/2026-10-08-round3/policy-suite.log)。[完整sourceRef/限制](evidence/2026-10-08-round3/README.md)。主审未参与本模块实现，lookup仅合成注入。

限定接受：注册引用按own-key解析、未注册零lookup、credentialRef每次resolve最多一次lookup、别名凭据不串、lookup原始错误丢弃、空结果拒绝、registry冻结；没有更改全局配置或文件读写。

`PR-E001` 接线仍缺证据：结果明确携带credential/baseUrl，是**私有transport descriptor**，不能整对象进入公开日志、Goal/Task记录或前端。URL的userinfo/query可能含secret，现校验只看http(s)，宿主须做私有endpoint引用/公开DTO分离和secret卫生；不能用“baseUrl只是配置”保证无秘密。并发调用各一次lookup不是全局单飞，是否需要去重/缓存由宿主定义。

真实tokenFile/凭据库、Grant/账户绑定、模型存在性/鉴权、fallback参数与预算、完整错误对象和公开API仍待联合验证；未读取真实key或调用模型。原V38/G1-provider/G2不计全通过。可继续依赖此限定纯核心的源码工作，不授权配置生产、外呼或上线。
