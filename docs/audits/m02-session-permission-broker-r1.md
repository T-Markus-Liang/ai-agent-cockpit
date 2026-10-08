# M02 session permission broker r1：CHANGES_REQUESTED

第二轮审计，2026-10-08。对象：[执行交接](../handoffs/m02-session-permission-broker-r1.md)。主审没有实现本批会话broker；D07/store历史共享组件只核对相关接口，不自签它们整体验收。

结论：**需修改生命周期fence与并发一次性语义**。14项原测试通过，两个异步交错负例失败。局部审批验证保留，但不能接受本批为真实SessionManager安全桥。

## 版本和复测

- base HEAD `e8c4317201d70e75cabe279da5e7736a9aab20a0`；broker `3df31722de8b08daa5758de21f64890e7119e5835d08e8f07b01ba3fa182c6db`；测试 `73c312d452bf78f6c240cc79271bc2d12a2e821f6eada8f0bd1e73c7bcf669db`。
- 读完269行源码、287行测试及交接；D07已读、store consumeApproval核对。hash捕获/复测/live核对一致，[完整版本/OS边界](evidence/2026-10-08-round2/README.md)。
- [身份+会话27项原输出](evidence/2026-10-08-round2/security-suite.log)，其中本批14项。未复跑完整runtime-policy或控制面回归。
- [主审探针](evidence/2026-10-08-round2/security-probes.mjs)/[结果](evidence/2026-10-08-round2/probe-results.json)：真实冻结ControlPlaneStore、合成Task/Execution和有效合成operator Approval；私有临时DB，OS拒网络/真实用户目录。没有真实工具或native会话启动。

## M02-SP-F001 — 高 / 阻断：逻辑会话关闭后，在途审批仍返回allow

定位：`session-permission-broker.mjs:116–119`仅入场检查closed；`:149`等待D07授权；`:151–155`没有再查会话状态。D07 `:40–45`异步等resolver之后消费Approval；store的Execution guard不认识本层session closed/generation。

复现：请求进入findApprovalId后用promise闸门暂停；调用`closeSession()`，确认记录closed；释放resolver。实际结果仍为`allow_once`，Approval在关闭之后被消费。

影响：不能保证逻辑注册会话关闭后不再发放新permission。不是证明真实工具已经执行；也**不把closeSession等同全Goal/Execution取消或父等待断连**。显式后台可按原授权通过新的有效binding续行，但不能让标为closed的本层会话晚到放行。

返工：明确logical-session generation/closed fence，在resolver返回、消费边界及返回permission前校验；close与裁决协调原子性/取消信号。若消费已提交而状态变更，保留已消费/投递不明事实，禁止伪造“denied且零副作用”。不能仅在入口再加一次查询来证明所有交错安全。

补测：close发生于resolver前/等待期间、consume前/提交期间、allow投递前；明确每窗结果与Approval/effect计数。关闭已提交后不得开始新消费；合法open路径保留；不误杀其他显式后台。

## M02-SP-F002 — 高 / 阻断：同toolCallId并发能放行两次

定位：`:123–124`查adjudicated后不预留；`:149`发生await；只到`:68–78`/`:152`或denied结算时才添加key。

复现：同session、同toolCallId、两个不同rawInput；两者各有真正匹配digest的有效合成operator Approval。同步进入resolver闸门后再一起释放，两次均`allow_once`，两份Approval均消费。每个请求单独都有审批，**不是无审批越权证明**；错误是同一调用身份未冲突/去重且绕过“任何裁决只一次”的合同。

store/D07按Execution+完整parametersDigest幂等，不足以挡住相同callId不同body的并发；现有replay测试只在第一次await结束后再调第二次。

返工：await前按(session generation, toolCallId)预留并绑定immutable parametersDigest/option；重复同参数去重/拒绝，不同参数显式conflict。只允许一个在途裁决，异常/重开后的保留状态也要定义；不可为重试换toolCallId绕过。

补测：同ID同body/不同body并发、两个审批、第一次allow/deny/error、不同ID合法并行、close交错及持久恢复。重复/冲突在resolver/consume之前拦住，最终allow和消费各不超过1。

## 其余缺口与下一包

- 参数/option/未知tool/审批digest/expiry/operator拒绝等原14用例仍有局部证据；不足以接受并发和生命周期边界。
- register只验形状，真实宿主还须绑定账户、session、cwd、Task/Execution/Grant；vendor SessionManager接线、decision log持久化、重开在途unknown状态及OS环境仍待审。不能把纯Map snapshot当进程耐久证明。
- r2按SP-F001/002交新hash、异步负例和真实store计数；再做vendor负例验证。V24/V26/V31/V47原要求不降，不能只改描述取得通过。
- 本线程没改peer代码/测试、未接线/部署/重启/外发。本报告不是Grant/Approval。
