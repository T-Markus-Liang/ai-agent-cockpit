# 第二轮审计证据：4个新r1批次

审计日期：2026-10-08；最后live核对 `2026-10-08T14:38:18+0800`，本轮20个源文件/交接/依赖均未漂移。这里round2/临时根r2表示**审计轮数**，不是执行方已交代码r2；4个组件仍为r1。

## 输入和结果

- 冻结根 `/tmp/personal-ai-os-review-r2.339QYo/input`；base HEAD `e8c4317201d70e75cabe279da5e7736a9aab20a0`。
- [source-ref](source-ref.sha256) 与 [live-check](live-check.sha256) 完全相同；捕获/复测后的隔离副本也逐项一致。初次清单尝试包含一个不存在的`__init__.py`，已排除该namespace-package条目并重新确认shasum exit 0，不把含错误输出的初次清单用于审结。
- package为本轮捕获的 `b46f4bc9…18aaf`，不同于4份历史交接的script追加版本。测试用固定绝对Python/Node入口，lock仍为 `168ac644…34ccd`；node_modules复用前轮隔离副本。没有验证当前每个npm script或安装新依赖。
- [memory-suite.log](memory-suite.log)：两套件49/49，exit 0；其中reconcile 27、purge 22。不是全体最新memory回归181或更多数量。
- [security-suite.log](security-suite.log)：两套件27/27，exit 0；identity 13、session broker 14。未复跑完整runtime-policy/control-plane套件。
- [memory-probes.py](memory-probes.py) / [security-probes.mjs](security-probes.mjs) / [原始结果](probe-results.json)：5项当前缺陷断言成立，另1项static HTTP生命周期缺口得到证明。探针exit 0表示错误/缺口被复现，不是修复通过。
- 身份token均为临时合成生成值，未输出、记录或持久化明文。请求审批使用真实冻结ControlPlaneStore、合成host operator与私有临时数据库，没执行真实native工具。
- 单项源码/测试已读；D07/store/request-authority仅核对相关接口，不代表对它们全体历史逻辑独立验收。没有审结所有新交接或完整0.3.0。

## 隔离边界和实际命令

Python3.11、Node24。所有本地复测用`env -i`，OS profile：

```lisp
(version 1)(allow default)(deny network*)
(deny file-write* (subpath "/Users/markus"))
(deny file-read* (subpath "/Users/markus"))
```

cwd为 `<round2>/input` 或 `<round2>/probes`。下列`<round2>`仅是完整路径 `/tmp/personal-ai-os-review-r2.339QYo` 的缩写；实际运行使用完整绝对路径。Python依赖来自前轮私有副本 `python-deps/site-packages`；不读真实home/模型缓存。

```sh
/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)(deny file-write* (subpath "/Users/markus"))(deny file-read* (subpath "/Users/markus"))' /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin PYTHONPATH=/tmp/personal-ai-os-review-r2.339QYo/input:/tmp/personal-ai-os-review-r1.bgwgKU/python-deps/site-packages PYTHONDONTWRITEBYTECODE=1 TMPDIR=/tmp/personal-ai-os-review-r2.339QYo/memory-tests /opt/homebrew/bin/python3.11 -m unittest discover -s /tmp/personal-ai-os-review-r2.339QYo/input/tests -p 'memory_*test.py' -q
/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)(deny file-write* (subpath "/Users/markus"))(deny file-read* (subpath "/Users/markus"))' /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin TMPDIR=/tmp/personal-ai-os-review-r2.339QYo/security-tests /usr/local/bin/node --test /tmp/personal-ai-os-review-r2.339QYo/input/tests/identity-pairing.test.mjs /tmp/personal-ai-os-review-r2.339QYo/input/tests/session-permission-broker.test.mjs
```

两套件并行跑。主审同时读取权限源码，官方Worker异步读取另一份已冻结源码。Probe使用相同profile与环境，cwd/TMPDIR为`<round2>/probes`，分别执行该目录下`memory-probes.py`、`security-probes.mjs`。每个Probe只清理自己创建的合成临时目录；未删除用户数据。

审计存档脚本仍锁定临时冻结根，不能改成生产路径来复跑；临时副本消失后按sourceRef重建并记新审计版本。修复负例必须反转期望，不能用“错误仍成立”当回归成功。

当前固定副本保留，未清理。执行方覆盖r1前应保存真正的批次commit或归档；hash只能验证身份，不能单独重建已丢失的源码。审计方不为此提交别人dirty代码或操作Git历史。

## 辅助模型与失败记录

- 按deepseek-worker skill先doctor、route；doctor验证官方 `https://api.deepseek.com/v1` / `deepseek-flash` → `DeepSeek-V4.1-Flash`。未更改App根provider或使用第三方fallback。
- [初次Worker](worker-attempt1.json)，job `1791440945-d6170d2667c5`：invalid structured result，未采纳为审计证据。实际staging内容无新增/修改。
- [一次同源有界重试](worker-attempt2.json)，job `1791441106-66007941be6a`：success、files_changed=[]、tests=[]；实际staging5文件与 [Worker hash](worker-source-ref.sha256) 前后相同，无额外文件。只定位reconcile/purge代码，不做测试或最终签字；报告中的缺陷由主审探针证明。
- 角色仅为源码证据提取，不称为Terra或第二位独立发布Reviewer。usage原样保留；不把聚合cached/input/reasoning字段相加宣称总费用。
- 按typesafe-ai读取实时官方llms/Noul（Noul首次TLS读取失败，第二次成功），用jev-eval检查[合成措辞](jev-wording-input.json)。[结果](jev-wording-result.json)：jev-1.13.0，草稿越界概率0.14，夸大对照0.98；input 732/output 44，888.87ms。
- Jev只判自然语言越界，不判代码正确性、组件验收或授权；没有阈值动作、没有secret或用户记忆原文。key由wrapper私有读取，未访问或输出。

本地测试路径无模型外呼；上述辅助模型调用另列，不能笼统说本轮完全没有外部模型。未跑真实Mem0删除live脚本、未触碰生产、未重启/部署、未外发微信/推Git。本线程实现Goal仍paused。
