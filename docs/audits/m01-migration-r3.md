# M01 migration r3 审计

交接：[m01-migration-r3](../handoffs/m01-migration-r3.md)。独立主审未参与本次migration.py改动；原preflight历史有本线程参与，因此不重新自签整个预检/迁移系统。

## 裁决

**COMPONENT_ACCEPTED（M01-F001剩余两点的r3修补）；M01-F001关闭。** 真实旧事实重验证、迁回、召回质量、完整SDK/补偿/跨进程privacy epoch及G5仍未验收。

绑定migration.py `2ff2d84c62dab80478f5ddc3449005fe8632ca89ad2fe9ea13028443ea2ef27e`。当前测试 `ed7c98f4ee8269e573ee816bb1219265edfc617755f054497ab869c7ffb40f20`、service `87bffe307d5765256ef2f899532ae2f65d89a6dc1bb81758f466d9de11fb85cb`，不同于交接列的旧共享依赖；以本次组合记录来源，不拿旧hash给新组合背书。直接读了snapshot准入、faithful集合比较、alias校验及相关负例。

主审原反例重放：

- 未知目标数据库目录0755：unknown_existing_db，mode/DB bytes/目录项均不变；拒绝发生在mkdir/chmod/backup之前。
- source有一行、manifestless独立空baseline目标：unknown_existing_db，未接受、原bytes不变；不再把空循环当完整快照。

当前迁移套件 **72/72通过**。集合必须完全相等且每行digest/payload/created_at相等；非空真子集不自动补行。根级symlink豁免只限root拥有且realpath匹配的/var、/tmp、/etc，其他路径不能借根级位置绕过。

审计裁决：保留真子集`conservation_violation`、空/无关目标`unknown_existing_db`的现有错误码，不要求为标签差异返工；两者都拒绝且零有害效果即可。本结论不证明来源在整个转换/效果期间未漂移。

边界：source为空+空target可接受属于已声明范围；现有目录无ingest.sqlite但含其他文件的准入、atime、目录/存在性→写之间的竞态、manifest信任链均不被本两例证明。生产备份编排应使用明确创建/拥有的专用私有副本目录，不把任意混合目录当受验目标；若扩大目标类别需补对应案例。未用这些未验证项伪造新的已复现Finding。

官方DeepSeek只读协查3个暂存公开件，job `1791468646-95777fb6e4ea`，仅源码定位；主审自己复跑和复现，worker没有替代发布签字。输入无真实数据/凭据、前后hash一致性单列证据。

M01-F002/F003/F004维持r2已接受子项与未覆盖边界，不被本报告重新签成完整通过。43旧用户条目是既有候选计划而不是本轮新盘点；未读/外发实际正文，也未迁移113生产回执或重启Mem0。证据见[本轮目录](evidence/2026-10-08-followup/README.md)。
