# 四线接力：限定修复整合与主审复跑 r2

**后续模式变更：**用户已要求本线程停止功能实现并恢复只做审核。本文已完成的限定修复整合属于此前已授权 WIP；从本注记之后，本线程不再合入新功能或启动实现型 subagent，只维护审计证据和进度文档。

日期：2026-10-09。接续[r1 失败与对齐](2026-10-09-parallel-alignment-r1.md)，不覆盖原交接和失败记录。HEAD 仍 `1e6ef85`；源码/文档未提交，现役没有部署或重启。用户明确允许主模型执行小弟任务，本轮使用四个只读 review + 三个独立文件范围的修复 Codex CLI 会话，均实际使用 `gpt-6.1-sol`，不是不受支持的 DeepSeek 角色。

## 1. 本轮实际完成

- 补齐额度中断后未写入的 D75–D78、最新检查点和 AUI 设计状态；纠正 C 线运行态/双 bridge/QR读写/身份推断。
- 将三条修复线的 21 个限定源码/测试文件，经冻结副本对照、逐文件源漂移校验、主线程 apply_patch 后整合进本机主仓。保留原有 S03b/S04a/S04b WIP，其它用户文件未清理。
- 新版本文件 hash 在[r2 sourceRef](evidence/2026-10-09-alignment/r2-source-ref.json)。这是本轮修复范围，不是完整发布 manifest；原[r1 sourceRef](evidence/2026-10-09-alignment/r1-source-ref.json)保留。
- 没有 git commit/push/PR 操作、生产迁移、chmod、旧历史写入、真实模型业务外呼、微信发送或服务重启。Codex 主模型 review/修复调用本身仅接收公开源码，不接收真实用户历史。

## 2. 限定 Finding 裁决

| 范围 | 本次改动与独立复跑 | 裁决/仍缺什么 |
| --- | --- | --- |
| GX-F001 | 存储 Grant 核对 required action scope；Cezar 派发拒 Reviewer，不消耗 Approval 或启动引擎；native保留OS只读 | 原合成绕路反例限定关闭；未证明所有 GUI/第三方路径 |
| GX-F002/003 | 稳定 caller admissionIntent 含显式期限；幂等 lookup 在首次签发前；异期限冲突、同请求到期后返回原记录 | 针对本轮回归限定关闭；没有原 intent 的旧记录保守冲突，迁移/真实客户端待验 |
| GX-F004 | `now >= effectiveDeadlineAt` 到期，与硬预算/Approval一致 | 精确相等负例限定关闭；真实长执行/跨 provider 期限仍待 |
| PE-F001 | 既有 per-user epoch 用有界 POSIX flock 串行读取/递增/替换，校验目录/owner/type/mode/no-symlink；并发进程回归返回6、7 | 并发丢更新/回退反例限定关闭；锁文件不能在运行中删除，POSIX依赖；PE-F002仍未解决 |
| OI-F001 | 拒 WAL header/任何sidecar风险，只接受 owned/sealed/独立 DELETE-format snapshot；检查头/页数/复制前后变化，SQLite只读临时副本 | WAL少计反例限定关闭；这是拒绝不可信输入，不是自动把生产 WAL 库变成安全快照。合法快照构造/生产适配待验 |
| FR-F001 | 停准入前记录 owner/fence/intent；未知项留下needs-review，已确认项逆序清理；snapshot尚未创建也可按显式scope恢复 | 停后报错现场丢失反例限定关闭；真实适配器仍须执行owner/fence/幂等协议 |
| FR-F002 | 全量重读与冻结水印比较；漂移首次restore前拒；真实执行要求 `conditional-restore-v1` / `restoreFrozenConditional` | 回退漂移反例限定关闭；原 restoreFrozen 单独接口不再可执行。原子条件恢复与数据级守恒依赖真实适配器，未签生产 |
| SN-F004/005 | journal写失败不跳过清理链；固定公开错误与未知状态；Error类/adapter code出口白名单，含getter/修改code反例 | 对新增故障注入限定接受；原SN-F001–003整体及生产快照能力不能仅据此批量关闭 |

本线程是修复的整合/复跑者，没有代替最终产品独立 Reviewer/Operator 签发布。四个 r1 review 会话未参与对应修复；r2通过是本表限定合同/反例，不是全系统安全保证。

## 3. 主线程真实测试记录

| 阶段/目录 | 命令 | 结果 |
| --- | --- | --- |
| 原主仓 r1 基线 | `node --test --test-reporter=spec tests/*.test.mjs` | 647/647，exit0 |
| 原主仓 r1 memory | `.venv-memory/bin/python -m unittest discover -s tests -p 'memory_*test.py'` | 361/361，exit0 |
| Grant隔离副本初次全量 | 同根侧命令 | exit1；唯一失败文件缺 `vendor/wechat-acp/dist/src/acp/client.js`。已单独复现 ERR_MODULE_NOT_FOUND，不当代码通过 |
| Grant副本补构建 | 隔离vendor目录 `npm run build`（scripts仅tsc，无pre/postbuild） | exit0，只生成副本编译产物 |
| Grant副本完整根侧 | 同根侧命令 | 659/659，exit0；没有删掉失败文件 |
| Privacy副本 | 指定venv解释器，分别discover epoch/outbound测试 | 39/39、33/33，均exit0；联合memory377/377 exit0 |
| Freeze副本 | `node --test --test-reporter=spec tests/freeze-coordinator.test.mjs tests/snapshot-orchestrator.test.mjs` | 53/53，exit0 |
| **三线合入后的主仓** | `node --test --test-reporter=spec tests/*.test.mjs` | **674/674，exit0，零skip** |
| **三线合入后的主仓** | `.venv-memory/bin/python -m unittest discover -s tests -p 'memory_*test.py'` | **377/377，exit0** |

不把各阶段计数相加宣称整版覆盖。Grant修复小弟曾报告Goal子集一失败/一超时、部分Seatbelt测试未过；主线程不隐藏该记录。主线程在完整隔离/主仓回归中相关套件通过，不反推该小弟失败的全部原因已经定论，也不替代真实业务验证。

Python仍有本地Qdrant index提示、退出期 `sys.meta_path is None` 和 unclosed lock ResourceWarning，实际退出码0；未修、不称零警告。其资源清理另列待办。

### 秘密扫描范围补验

`npm run audit:secrets` 对 tracked 1781文件通过，不能据此覆盖当前 untracked WIP。主线程将r1/r2并集的32个交付文件（仅公开源码/交接，不含私有配置）复制到无Git的隔离scan-input，复用现有扫描器的filesystem模式。首次发现4个未处置命中，均在未跟踪的 memory_outbound_inventory_test.py：已核对为数字序列GitHub/JWT合成样例、AWS官方EXAMPLE及仅PEM头，无真实密钥证据。

主线程将这4个正例改为运行时字符串构造，运行时值与原断言不变，不降低检测规则或添加目录级豁免。33项outbound测试再次exit0，32个交付文件隔离扫描再次exit0、0未处置命中；r2 hash随最后一处测试文本更新。此补验不声称扫描了全机器、所有历史或ignored私有文件，也不关闭GitHub现有告警。

## 4. 下一检查点与未完成事项

优先继续 **PE-F002/003**：已建立 epoch 丢失要与新用户初始化区分；epoch须绑定 ingestion/plan/vector/context，旧plan重试及store后结算重新核对，不能只比较一次查询前后counter。当前 `service.py` 没有在本次窄修复中重写这些边界，因此 S04a 整体仍 CHANGES_REQUESTED。

然后推进 AUI 的身份/owner/QR 生命周期离线合同、同源只读投影和 S02 client 映射；不要以viewer服务token代替用户身份，不能把GET status的登录推进当纯读。F4主库/proof库投影要保留来源。当前 C线仍设计，不是界面施工已完成。

真实四store适配、条件恢复与新数据守恒、两个真实Worker、旧记忆外呼/迁回、canary/drain、C01–C15/G5c、手机/微信/24h和正式发布均未完成。本轮不自动启动无限Goal或宣称全部0.3.0完成。新会话从 `0.3.0-resume.md` 最新段落继续，不按旧待审数量或旧“源码清零”停掉安全任务。
