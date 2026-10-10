# M01 migration r1 审计：CHANGES_REQUESTED

审计日期：2026-10-08。对象：[执行交接 m01-migration-r1](../handoffs/m01-migration-r1.md)。

结论：**需修改，不接受本批迁移/重验证组件作为已完成能力**。132 项记忆测试通过，但专项复现了 4 项缺陷。仅阻断相关记忆迁移、重验证和恢复门槛；不冻结整个项目，也不要求执行方停止无冲突工作。

## 身份、版本与边界

- Reviewer：本线程 Codex 主审。未参与本批新增 `migration.py` 和迁移测试的实现；先前参与过共享 `migration_preflight.py`、service selector 等工作，因此不对这些历史组件自签独立验收。
- 执行方：交接包声明为 Kimi Code、`main`、仓库 `/Users/markus/ai-agent-cockpit`。只确认已读到交接包与 ACK，不声称已建立自动跨 App 消息通道或验证对方当前进程仍在运行。
- base HEAD：`e8c4317201d70e75cabe279da5e7736a9aab20a0`。当前工作树未提交内容很多，不能用 HEAD 代替本批版本。
- 冻结测试根：`/tmp/personal-ai-os-review-r1.bgwgKU/input`。捕获前后源文件一致，副本与捕获清单一致。审结核对时本批代码、测试和记忆依赖仍一致；完整 SHA256 见 [sourceRef](evidence/2026-10-08-r1/source-ref.sha256)。
- `migration.py`：`679b2ae3a82966a074eadbced5b900b236f390c128d532b19cb56837df4d1cb6`；迁移测试：`3b7903592eebb11299c13bc37fe58b1fe191bb1109f45d302c333246a8cb9a8e`。
- `package.json` 未形成共同冻结版本：M01、M02 均修改该文件，之后又继续加入其他脚本。捕获时 hash 为 `4285d1f0…f508d`，最终核对为 `ff260825…06647`，均非 M01 交接中的 `5b0ca353…f60eb`。本轮用固定 Python 入口复测，不给实时 npm 入口或新增依赖背书；最终完整清单见 [live-final](evidence/2026-10-08-r1/live-final.sha256)。
- 阅读范围：converter、迁移测试、service/quality/lifecycle/preflight 与记忆相邻测试。没有进行全仓库或完整 0.3.0 发布审计。
- 测试使用私有合成目录、FakeMem0/FakeEvaluator；OS 沙箱禁止网络和真实 `/Users/markus` 目录读写。没有读取/转换生产数据库、使用真实用户原文、部署、重启服务、外发微信或推送 Git。
- 审计辅助另列：官方 DeepSeek `deepseek-flash` 只读取脱敏源码副本，job `1791434451-b3e3bfc22a47`，确认版本 `DeepSeek-V4.1-Flash`，`files_changed=[]`、`tests=[]`；已核对实际 staged 源码/交接 hash 一致。它是源码定位证据，不是复现或独立发布签字。两条原生 Reviewer 子代理因模型不受支持而启动失败，没有采纳结果、没有宣称 Terra 独立审计。

## 已取得的复测证据

沙箱与绝对命令见 [证据说明](evidence/2026-10-08-r1/README.md)。

| 核验 | 实际结果 | 证据 |
| --- | --- | --- |
| `python3.11 -m unittest discover -s <frozen>/tests -p 'memory_*test.py' -q` | exit 0；132/132，1.168 秒 | [原始输出](evidence/2026-10-08-r1/memory-suite.log) |
| 主审 M01 专项缺陷探针 | exit 0；4 组当前缺陷断言成立 | [探针](evidence/2026-10-08-r1/m01-repros.py)、[结果](evidence/2026-10-08-r1/probe-results.json) |

这些探针断言的是 r1 的**错误行为被复现**，不是功能通过。修复后须反转预期并纳入执行方回归套件，不能把探针 exit 0 算成功验收。

## 必须修复的 Findings

### M01-F001 — 高 / 阻断：目标来源与路径保护不足

定位：`migration.py:126`（仅排除指向 source 的别名）、`:144`（manifest 只要存在，或 turns 有基线列即视为 known copy）、`:184`（先 chmod 目录）、`:191`（复用 usable DB）、`:200`（不 usable 时删除/重建目标）。

实际复现：独立创建一份具有相同基线表结构和 receipt 的既有目标库，`convert()` 接受并把其 `done` 改为 `pending`；目标目录为指向另一个合成 victim 目录的 symlink 时也被接受，victim 数据库被修改。所有 victim 均为审计临时夹具，不是用户真实数据。

影响：协作协议 §7.2 的“拒绝来源不明既有库、私有副本迁移”未满足。事后 conservation 不能替代写入前目标校验，且本批 conservation 还有 F002 缺口。

返工：写入/chmod 前确定性校验目标与每个祖先；拒绝 symlink、非普通文件、未知 hardlink 和未知既有目录/DB。恢复只接受有有效版本、同源 provenance/fingerprint、内容映射可验证的 converter 副本；不能仅凭 schema 或 manifest 文件存在判断。新的空目录正常路径保持可用。

补测：未知同 schema DB、伪 manifest、指向非 source 的目录/DB symlink、非 source hardlink、损坏目标和已存在无关文件。拒绝前后 victim 的内容、权限、目录项均不变；已认证同源副本可安全重入。

### M01-F002 — 高 / 阻断：守恒只比较已存 digest

定位：`migration.py:767` 至 `:815`，关键 SQL 为 `SELECT digest FROM turns`，随后只比较 digest 的 Counter。

实际复现：source 的 `created_at=1`，目标为 `99`，其余保留相同存储 digest；转换成功并报告 `conservation.digests_match=true`，错误时间仍为 99，source 字节未变。

影响：不能证明原数据/ID/时间守恒。存储 digest 未由 payload 重算，静态代码也未对 event ID、payload、身份和时间作完整逐项比较；本轮只把已复现的时间错误作为确定性结论，不伪称其他篡改探针已跑过。

返工：按稳定 event ID 比较 immutable source 字段、原 payload、身份、原时间及重算 digest；将允许转换的信任状态单列映射，不要求新旧 status 原样相等。校验遗忘状态/tombstone 与 manifest provenance，拒绝不明漂移；不能用摘要相等代替原文与来源一致。

补测：保持已存 digest 不变而修改 payload、ID、user/role/source、created_at；重复 digest 对应不同事件；多行重复/遗漏；合法状态转换；WAL 数据与 source 不变。每个坏例不得报告成功。

### M01-F003 — 高 / 阻断：忘记提交后仍产生向量写入

定位：`migration.py:620` 初次 SELECT 过滤 forgotten；`:652` 至 `:723` prepare/store 无重复隐私校验；`:292` 的 UPDATE 无 `forgotten=0` 或 privacy epoch 条件；`:726` 未重查 ForgetStore。

实际复现：使用真实冻结 `Mem0Engine` 加 FakeMem0/FakeEvaluator；在 prepare 生成计划后、store 前提交 `MemoryService.forget()`。结果为 `forgetCommitted=true`、`vectorEffectsAfterForget=1`、converter 报 `validated=1`，`forgotten` 标记仍为 1。

影响：违背停止再提炼/存储及生命周期屏障。**没有证明已忘记内容被 search 召回**：标记保持 1，已有 search 仍会过滤；确定的问题是忘记提交后的新向量效果和错误“validated”结算。

返工：复用 lifecycle/MemoryService 的隐私流水线，以单 owner 或 privacy epoch/fence 协调忘记与效果派发，效果前和结算前重查事件状态、tombstone、plan 绑定。prepare 期间已提交忘记时不得开始 store；忘记与已在途 store 交错时应补偿/隔离结果，不能再记为 validated。仅添加一次无锁 SELECT 不能证明竞态已解决。

补测：忘记分别发生于 prepare 前/期间、store 前/期间、回执结算前；event/source/quote 三类 tombstone；重开与重试。分别断言效果计数、隐私终态、召回拒绝与不复活。

### M01-F004 — 高 / 阻断重试路径：存储重试重新提炼

定位：`migration.py:654` 总是 `engine.prepare()`；`:698` 先 store，计划只在随后结果/错误回执保存；`:620` 将 store_error 再选入，但不复用其持久 plan。

实际复现：首次 FakeMem0 存储失败，第二次成功。第一次 evaluator 调用 2 次；第二次又增加 2 次，而不是复用已持久的验证计划。

影响：存储故障恢复会重复语义外呼，可能改变 fact/effect key，不能作为稳定计划和不明副作用恢复证据。本轮没有观察到重复生产向量，不能把“风险”写成已发生的数据重复。

返工：优先复用已有 MemoryService 的 plan-before-effect、持久回执和恢复算法，避免建立第二套摄取状态机。效果前持久化已验证计划与稳定键；可恢复失败只按相同计划结算。无法确认已发生效果的异常进入待核对，不重新提炼或换 request ID 绕过。

补测：store 失败后 prepare/evaluator 不再增加；进程死于效果前/效果后/回执前；重复恢复保持 plan、fact ID 与效果数；质量版本漂移、plan 篡改、部分写入和不明副作用分别 fail-closed。

## 缺证据与下一动作

- `M01-E001`：重新交完整 package/shared dependency sourceRef；共同 package 文件不能被标为两批“无交集”。本轮核心缺陷仍绑定上列冻结文件，不因此废弃。
- 真实 113 条历史、43 用户条目的实际分布/质量、真实模型、生产切换、微信与回退均未核验。原 V08/17–22/32–36/48/52、G1-memory/G5/G5c 相关要求保留。
- r2 按 F001–F004 逐条交新 diff/hash、负例、命令及退出码；不覆盖 r1 失败证据。允许执行方继续无文件冲突的 provider/context/route 组件，正式依赖迁移的门槛暂不通过。
- 非阻断 backlog：重复 digest journal 边界、非 done assistant 的归档含义、系统 Python/venv 入口。若它们实际破坏上述守恒/恢复条件，就按缺陷升级，不能用“后续”豁免。
- 本报告只做审计与计划建议，不是 Grant/Approval；不授权生产数据迁移、原文外呼、部署或物理删除。

Jev 仅检查合成报告措辞，未作代码/授权决定。输入、结果和限制见 [证据说明](evidence/2026-10-08-r1/README.md)。
