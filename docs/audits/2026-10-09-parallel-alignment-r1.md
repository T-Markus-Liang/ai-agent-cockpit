# 四线额度中断后的对齐与并行复核 r1

日期：2026-10-09。基线 HEAD `1e6ef85f6ae303d6af429ca257f2364896d3db86`，含未提交 S03b/S04a/S04b 与 AUI 文档。用户最新要求本线程接力对齐并并行推进，允许使用主模型 subagent；本轮不触生产、真实历史、认证、迁移、重启或远端 PR。

## 1. 已核对的真实交付

| 线/批次 | 已落盘 | 本轮实际证据 | 当前裁决 |
| --- | --- | --- | --- |
| A / S03b | Grant 模块、六入口、派发/store/测试与交接 | 根侧全量 647/647，exit 0；scope/reviewer 与幂等新反例见§3 | CHANGES_REQUESTED，不作完整接线通过 |
| B1 / S04a | privacy_epoch、outbound_inventory、service 接线、两套测试与交接 | memory 联合 361/361，exit 0；退出期 Qdrant warning 单列；主审并发/WAL 独立探针失败 | CHANGES_REQUESTED；时代过滤/状态丢失仍缺闭环 |
| B2 / S04b | freeze-coordinator、测试与交接；未改 snapshot r2 | 根侧全量包含该测试；主审 stop-after-effect 探针失败，独立 review 又发现 rollback/journal 问题 | CHANGES_REQUESTED；真实适配器仍未交付 |
| C / AUI | aui-convergence-graph.md | 本轮另一路只读复核源码事实 | 设计交付而非施工；需纠正 production-loaded/F3/身份边界 |
| D / 原同事复核 | 用户转述有独立复验 | 未取得可冻结的完整 D 线报告，不将转述替代本轮源码/反例 | 本轮四路新复核单列，不能批量“全通过” |

同事额度中断发生在台账 Edit 的 old_string 不匹配之后。D75–D78 当时没有进入阶段台账，检查点/AUI 表仍停在较早状态；本线程正在补齐事实，不覆盖原失败或冒充功能已上线。

## 2. 并行机制与模型事实

原生 spawn_agent 的角色仍强制使用不受支持的 `deepseek-v4.1-flash-expires-on-0910`：即使传 Terra/Sol override，实际仍在开始读码前失败，不算子任务完成。用户随后明确允许主模型。

本轮依据[官方 Codex CLI reference](https://developers.openai.com/codex/cli/reference/)采用 `codex exec --ephemeral --ignore-user-config --ignore-rules --disable multi_agent --model gpt-6.1-sol`，每次仅进程内配置；不改全局模型、历史/rollout/数据库或旧对话。四个只读 review 进程使用 `--sandbox read-only` 和冻结的公开源码副本，禁止读取私有状态与递归委派。它们实际返回四份报告，不声称原生 agent 工具已经修好。

源码副本：`/tmp/personal-ai-os-parallel-alignment.2am586/source`。阶段报告：同目录 `grant/privacy/freeze/frontend-review.md`。这些临时路径可能清理，核心证据本报告留存；修复结果另交 r2，不能让 r1 接受新代码。

未提交实施版本的完整文件 hash 见[r1 sourceRef](evidence/2026-10-09-alignment/r1-source-ref.json)。该清单排除用户AGENTS与下一版研究资产，不能被当作整仓发布 manifest。

现已启动三条主模型修复进程，分别在 `grant-fix`、`privacy-fix`、`freeze-fix` 隔离副本写有限文件；主仓尚未合入它们。主线程负责核对差异/测试/源漂移后 apply_patch，不允许直接覆盖用户 WIP。所有修复均仅源码/合成测试，不是生产切换。

## 3. 本轮确认的 Finding 与证据范围

| ID | 级别/影响 | 证据 | 修复范围 |
| --- | --- | --- | --- |
| GX-F001 | P1，Grant scope/Reviewer 绕路径 | verifyGrant 仅比 task/execution/digest；Reviewer native-only grant 可走 Cezar 派发，匹配 Approval 后 start spy 被调用。独立只读子进程的纯内存反例 | 两派发面核对 required scope；无等价只读的路径拒 reviewer |
| GX-F002 | P2，幂等意图漏显式期限 | HTTP/CLI 将 expiresAt 只送生成 grant，store 从指纹排除 grant；同 key 5000→2000 重放旧 5000，未冲突 | 显式调用意图与生成 issuer 字段分开绑定 |
| GX-F003 | P2，到期重放被重签先拒 | 相同 key/请求到显式期限后，先 issueGrant 再查 replay，GRANT_INVALID；首次结果不能安全读回 | 先一致性/幂等查询再首次签发；不开放新派发 |
| GX-F004 | P2，精确到期语义不一致 | 主审调用 verifyGrant(now=expiresAt=2000) 被接受；其它硬预算/Approval 用 >= 到期 | 统一相等即到期并补负例 |
| PE-F001 | P1，epoch 丢更新/可回退 | 主审同步两次读后 bump 返回 [1,1]、最终1；子进程指出更强 A迟写可覆盖 B已升至7 | 有界跨进程锁/CAS、安全路径与失败行为 |
| PE-F002 | P1，重置状态丢失被当新用户 | _read_current 对任意缺文件返回0，无法区分从未初始化和已重置状态丢失 | 独立初始化依据/持久权威；本轮窄修复不关闭此项 |
| PE-F003 | P1，时代未绑定旧记录/重试/结算 | filter_by_epoch 仅单测，search前后相同新epoch仍可召回旧记录；持久旧plan重试以新epoch作基线；store后缺privacy复查 | ingestion/plan/vector/context 时代标记与每个真实边界；不当部署手续消掉 |
| OI-F001 | P2，WAL 盘点不一致 | 主审合成 WAL 库有2条 committed rows，immutable盘点为1；也可能遗漏刚忘记的标记 | 拒非独立 sealed snapshot/WAL风险；源零变化 |
| FR-F001 | P1，停准入未知现场丢失 | 主审 adapter停后抛错：freeze-partial、stillPaused=true、resumeCalls=0、coordinationRecordExists=false | 副作用前 intent、unknown持久化、授权恢复；不盲目 resume |
| FR-F002 | P1，执行时重读未拒水印漂移 | 子进程纯内存反例：冻结/plan=10、执行baseline=9、restore后10，却 success；代码1167–1192只比较after与baseline | 首次restore前全量拒漂移，跨await需锁/条件恢复合同 |
| SN-F004 | P1，journal I/O失败跳过清理且泄露路径 | 子进程合成：quiesce后 journal持续EIO，清理0次、暂停未解除、原始路径错误外抛 | 清理不依赖journal成功；固定错误码、未知状态可核对 |
| SN-F005 | P2，错误类code未白名单 | adapter抛自身Error子类携任意canary code，DTO/manifest保留。普通Error canary单测不能覆盖 | snapshot/freeze错误码严格白名单，未知归固定阶段码 |

“子进程反例”不等于主线程已再次运行全部探针；主审亲验的项目明确注明。源定位以符号和 r1 文件为准，修复后行号会变。不能把本表 P1 当作已发生生产损失或真实 key 泄漏。

主审探针原输出：

```json
{"grant":{"syntheticOnly":true,"productionTouched":false,"effects":0,"grantExpiresAt":2000,"effectiveDeadlineAt":2000,"now":2000,"boundaryResult":"accepted"},"privacy":{"syntheticOnly":true,"productionTouched":false,"networkCalls":0,"epoch":{"returned":[1,1],"persisted":1,"two_resets_unique":false},"wal":{"committed_rows":2,"inventory_rows":1,"counts_match":false}},"freeze":{"syntheticOnly":true,"productionTouched":false,"networkCalls":0,"errorCode":"freeze-partial","stillPaused":true,"resumeCalls":0,"coordinationRecordExists":false}}
```

本轮真实命令，不用 grep/tail 管道作为退出码：

```sh
node --test --test-reporter=spec tests/*.test.mjs
.venv-memory/bin/python -m unittest discover -s tests -p 'memory_*test.py'
```

647/647 与 361/361 均 exit 0；这些是 r1 基线计数。Qdrant local index警告/退出期 `sys.meta_path is None` 和 unclosed lock ResourceWarning 原样登记，不能称零警告，也不由退出0反推其原因必然无害。

## 4. C 线事实纠正与下一施工片

- 仓内 launchd plist 只能证明启动配置，不能单凭它称当前 production loaded/running；dist与源码对应也未核验。
- F3 的 agent 参数确实不同，但 bridge recovery-lease 阻止同实例双 owner；结论应是重复启动尝试/配置不一致风险，不是已经证明双 bridge 同时工作。
- `GET /api/wechat/status` 在二维码待确认阶段会外呼、写 token、拉起进程，不是纯状态读取；QR/status不能混入无副作用只读代理。
- F4 两个 Task 库分裂成立；投影需保留 main/goal-proof 来源，不能直接按同 ID 合并。F6 浏览器持 token成立，但当前未见写入URL/storage/日志，不等于实证泄漏。
- 代理不得代填固定 `X-Goal-Actor: local` 跳过用户 owner检查；Host/Origin 与服务 viewer token均不替代浏览器用户身份。审批/Goal/QR写面不能统一共享operator放行。

下一安全工作片：先身份/owner与QR生命周期合同及离线fake→再同源只读投影/最小DTO/退役浏览器服务token。源码/fake可继续，不要求先写生产凭据；真接线/写面启用单独过 Gate。

## 5. 剩余边界

0.3.0 未完成：时代绑定、真实四store适配、同源UI施工、两个真实Worker、迁移/回退、C01–C15裁剪和微信/手机/24h仍需实际证据。本报告不授权上线、用户原文外呼、权限扩大、发布或全部勾选完成。
