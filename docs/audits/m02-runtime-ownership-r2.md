# M02 ownership r2：限定子项接受，完整能力仍待修改

2026-10-08。对象：[r2返工交接](../handoffs/m02-runtime-ownership-r2.md)，历史[r1失败证据](m02-runtime-ownership-r1.md)保留。

主审未参与本次r2返工；既有共享runtime/工具基础不由本线程自签整体验收。固定源码contracts `750d9035…d734ed`、adapter `8699bf38…376a98`、测试`ea12f77a…5854fd`，完整[第三轮sourceRef/命令/边界](evidence/2026-10-08-round3/README.md)。捕获基线e8c4317；本地切到`feat/0.3.0-progress`的c9e09b6后，受审文件仍逐项相同。

五套件72/72通过；主审另以真实SDK+fauxProvider镜像三组探针复核，未调用真实模型、生产、旧原生会话或微信。

| 原Finding | r2实际观察 | 裁决 |
| --- | --- | --- |
| M02-F001 | 前台取消返回partial；后台显式stalled；recover保留stalled；300ms无新输入窗口内modelCalls仍1 | 报告/持久状态诚实子项接受；后台推进缺陷仍开放 |
| M02-F002 | 混合run返回unsupported，不再返回aborted；前台/后台随后仍done | 假成功子项修复接受；精确前台/单Execution取消仍开放 |
| M02-F003 | 缺binding/顶层与nested矛盾在零row/零model前拒绝；nested缺省安全采用顶层，Execution cancel得到aborted/unanswered | **新admission与单Execution绑定子项关闭** |

结论不是整批COMPONENT_ACCEPTED：V11/V12需要任务实际继续/精确停止，不能用stalled/unsupported消掉。V10真实超交互cap长任务、当前回合、全Goal/产品接线仍未验；旧r1无nested绑定记录的恢复/迁移也未由新admission修复。

下一步：按[durable ownership提案裁决](durable-ownership-proposal-r1.md)先实现新任务的独立ownership，保留同请求/效果身份，不自动重派旧stalled或unknown。新API结果要在产品/UI明确消费，partial不能被上层当cancelled。完整关闭前原G2/G3条件保留，不暂停安全源码工作。

初次隔离副本缺少两个native helper及canary依赖，导致导入失败；补齐且核对hash后72项通过。失败输出保存，不算peer代码缺陷或通过。审计方没有改peer源/测试、重启、迁移或提交GitHub review。
