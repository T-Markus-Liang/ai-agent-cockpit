# Mem0 OSS — Personal AI OS 本地记忆服务

这里部署的是 **Mem0 SDK 2.2.1**，不是 Mem0 云服务，也不是其 Docker 全栈 Dashboard。
自有 FastAPI 适配层把 SDK 作为轻量的单机 Memory Service 提供给微信桥。

运行/源码区分（0.3.0实施中）：现役服务仍使用0.2.2的Kimi提炼路径，尚未重启切换。当前源码默认已经改为extraction-v2原文句子选择：代码分隔完整句子，Jev只判断资格/完整性，Mem0以infer=False保存原文及来源坐标；不生成改写。59项隔离测试与连续三批次各3/3真实样例通过，不代表更正/忘记/迁移/生产链路全部通过。

- API：`http://127.0.0.1:4325`，只绑定回环地址；写入与检索需本机 Bearer token。
- 状态：`~/.local/state/personal-ai-os/mem0/`，0700；token 和入库 SQLite 为 0600，不提交 Git。
- 存储：本地 Qdrant 向量 + SQLite history/持久待处理队列。
- Embedding：`sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`，384 维，支持中英文，在本机 CPU 上运行；首次下载后常驻服务开启离线模式。
- 记忆提炼：本机 4323 Kimi shim → Kimi Coding API；会把用户对话内容发送给已有 Kimi provider，**不是全离线推理**。不需要新增 Mem0 云账号或公开存储 provider key。
- Kimi 参数适配：非 thinking 模式、temperature 0.6、top_p 0.95；避免 Coding API 拒绝通用 OpenAI 参数。
- 隐私：原始对话和近期上下文都在本地；Mem0 长期事实只从用户自己的表述中提取，不把助手猜测当作事实。入库前屏蔽常见 token 格式；不能承诺识别所有形式的秘密。

## 微信桥自动链路

每轮在 ACP 实际派发前：检索 Mem0 的相关长期记忆，读取近期对话和可信人格规则，追加本轮用户原文到私有完整 JSONL 归档，然后把组合上下文发给 Kimi 或 fallback。

回复同样追加归档。Mem0 写入使用持久 outbox，API 只在 SQLite 落盘后确认接收，后台提炼失败会保留并重试；服务不可用时仍使用本地上下文，不阻塞微信长达数分钟。

超过 API 正文上限的提炼输入按稳定事件 ID 分块，完整对话正文归档不截断。HTTP 400/409/413/422 永久拒绝的记录移入私有 `rejectedOutbox`，保留正文和状态码；其他记录继续上传。401、限流和 5xx 等不被当作永久拒绝，仍保留重试。关闭时禁止新追加和新上传，等待正在进行的写入结束。

原始记录保存在微信实例的 `conversation-archive/`，近期快照仍是 `conversation-memory.json`。
旧快照的 `summary` 是有损文本摘录，不称为智能摘要；新增归档不会截断原文。部署迁移只回填已保存在旧快照里的历史，不能重建过去已经被删除的数据。

完整归档、长期事实和原生 ACP 历史不是同一件事：这套服务提供跨模型共享记忆，不声称无损迁移原生工具状态。

## 安装与验证

```bash
uv venv --python /opt/homebrew/bin/python3.11 .venv-memory
uv pip install --python .venv-memory/bin/python -r services/memory/requirements.lock
# 首次预下载，常驻服务随后可以 HF_HUB_OFFLINE=1 启动
.venv-memory/bin/python -c 'from pathlib import Path; from services.memory.service import Mem0Engine; Mem0Engine(Path.home()/".local/state/personal-ai-os/mem0")'
.venv-memory/bin/python -m uvicorn services.memory.service:app --host 127.0.0.1 --port 4325 --no-access-log
```

macOS 常驻定义：`launchd/com.markus.personal-ai-os.memory.plist`。端口不对 LAN 开放，无浏览器 wildcard CORS。

```bash
npm run test:memory-service # API 鉴权/隔离/幂等/重启/失败重试/权限
npm run test:memory-live    # 真实 Mem0 + Kimi 中文提炼与语义检索；使用独立合成测试命名空间，产生少量 Kimi 推理调用
npm run test:memory-kimi    # 真实 Kimi ACP + 真实桥接准备/归档路径，不发送真实微信消息
npm run test:memory-recovery # macOS launchd 实际停启 Mem0，验证本地降级、积压回放和向量持久化；短暂影响长期检索
npm run doctor             # 联合服务健康检查，不等同于模型行为完整验收
```

可选 spaCy/BM25 的启动警告不代表多语言语义检索失败；本轮验证的是语义检索，没有把完整 NLP/hybrid 检索宣称为已部署能力。服务由单个进程持有本地 Qdrant，不要对同一状态目录启动多个 worker。

对话服务停止后运行 `node scripts/migrate-wechat-memory.mjs` 回填可用历史；先生成私有备份，不删除原生 Agent 历史。
现役0.2.2重试语义是at-least-once，不宣称exactly-once。0.3候选源码先保存版本化plan，再按user/event/source span查询复用向量；只允许final done+validated且原文绑定一致的回执进入可信检索。超时、格式错误和模糊判断按预算重试，最多3次失败后needs_review，原文仍在。旧done记录保留为legacy_unverified，需要后续验证迁移，不能直接当新版事实。

候选源码的原文选择会把不含明显秘密的用户原文送给本机`jev-eval`配置的远程Jev服务；不是全离线。Key由既有wrapper加载，不进入参数、提示、日志或仓库。Kimi仍负责微信主对话，未被Jev替代。固定阈值只是初始政策，不保证所有语义判断都正确。

新增接口：鉴权`POST /v1/status`输入`{event_id,user_id}`，返回处理、质量、版本和安全错误类型，不返回原文；`/health`增加quality/needs_review统计。更正/冲突、忘记/永久删除、前端状态、旧事实验证及实际桥接上下文仍待后续工作。

后续隔离实现已补服务端软忘记/v1/forget和/v1/controls：请求ID/用户/事件绑定、原子tombstone、source/quote hash和memory_epoch；新旧ID重复源码及提炼/写入/查询竞态不会恢复可信结果。当前83项服务测试通过。微信本地pending屏障/稳定目标摘要/代际上下文/上传抑制21项通过，真实编译MemoryStore与隔离Mem0联合验证通过。Raw archive仍保留，不称为永久擦除；活跃ACP原生上下文仍要求上层重置，UI和更正/永久删除尚未完整实现。

新增验证：`npm run test:memory-quality-live`对独立私有命名空间执行三组真实Jev+Mem0检查，不发送微信、不恢复原生会话；默认准备路径生成式提炼调用为0。运行时可用`HF_HUB_OFFLINE=1 MEM0_TELEMETRY=false`保持embedding离线和关闭SDK遥测，不以可选spaCy/BM25警告替代语义失败判定。

上游：[mem0ai/mem0](https://github.com/mem0ai/mem0)，Apache-2.0。依赖通过 `requirements.lock` 固定，不把上游服务包装成自有实现。
