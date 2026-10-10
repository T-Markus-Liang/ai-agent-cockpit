# M02 session broker r2：限定COMPONENT_ACCEPTED

2026-10-08。[r2交接](../handoffs/m02-session-permission-broker-r2.md)，源码3e6f1d6f…a79806、测试891df68e…7db120。[固定版本、25项和独立探针](evidence/2026-10-08-r2-followup/README.md)。主审未参与返工，历史D07/store只核对接口。

接受纯进程内限定子项：SP-F001原resolver等待窗关闭后session-closed、Approval未用；SP-F002同callId异body并发被conflict拦住、resolver1次、allow1次、第二Approval未用。旧双allow/等待窗关闭仍allow已拦住。关闭晚于consume的诚实reason保留，不当零副作用。

完整生命周期/耐久仍EVIDENCE_REQUIRED：inFlight不入snapshot，restore只保留已结算log；进程死时未结算call的unknown/replay未解决。wrapper消费前检查在调用async store之前，不等于实际DB commit前原子fence；关闭在store异步等待期间的窗须联合负例，不能从同步stub推全量安全。

接vendor/HTTP/MCP需真实account/role/Execution/Grant、权限epoch和当前参数、单owner持久pending/consumed/delivery-unknown。V24/V26/V31/V47不降；可做默认关闭route/fake接线，实际Agent/旧会话/生产未授权。
