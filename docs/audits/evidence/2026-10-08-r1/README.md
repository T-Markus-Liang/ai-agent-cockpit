# 2026-10-08 r1 审计证据

对象：[M01 审计](../../m01-migration-r1.md)、[M02 ownership 审计](../../m02-runtime-ownership-r1.md)。这些是组件审计证据，不是生产或完整版本通过证据。

## 固定输入与结果

- base HEAD：`e8c4317201d70e75cabe279da5e7736a9aab20a0`。
- 冻结根：`/tmp/personal-ai-os-review-r1.bgwgKU`；执行 cwd 为其 `input` 或 `parent-repros`。这里只装了本轮审计需要的源码、测试、已安装依赖副本，不是生产状态目录。
- [source-ref.sha256](source-ref.sha256)：捕获时本批与直接依赖的完整 hash；主审存有捕获前后相等校验。实时核心文件在审结核对时仍一致；package 已漂移，报告已限定适用范围。
- [live-final.sha256](live-final.sha256)：报告最后核对时的实时文件hash；除package.json外，上列批次与依赖均与固定sourceRef相同。之后的新变更不自动属于本审计。
- [frozen-suite-input.sha256](frozen-suite-input.sha256)：当前隔离副本全部被纳入清单的 Python/MJS/fixture 文件。它不是 live worktree 的完成清单，也不宣称额外文件全部读审。
- Node 24、Python 3.11、既有 pi 1.0.4；Python 依赖从已有环境复制到私有 `python-deps/site-packages`，不安装新依赖或执行生命周期脚本。
- [memory-suite.log](memory-suite.log)：132/132，exit 0，1.168s。
- [runtime-suite.log](runtime-suite.log)：62/62，exit 0，零 skip/fail。
- [probe-results.json](probe-results.json)：主审两路专项缺陷实际输出；两脚本 exit 0 表示已复现错误，不是修复后通过。
- [m01-repros.py](m01-repros.py)：`7697f131d3288deaba5b41b3dd9872aa2e1c3da402497dabff889d739a95fdbe`。
- [m02-repros.mjs](m02-repros.mjs)：`36a90e3327b996f7d2f5dc4a038bee312bcc6329af6ba4b15ce611ea2cc90b4a`。

探针是已执行临时脚本的原样审计存档，绝对 imports 锁定上述冻结副本；不要改成生产目录来复跑。临时副本丢失后只能按 sourceRef 重建受隔离夹具，并记录新的审计版本。修复后将负例的期望改为正确行为，不能仅继续运行“错误仍成立”的探针。

## 实际 OS 边界和命令

使用系统 `/usr/bin/sandbox-exec`，profile 为：

```lisp
(version 1)
(allow default)
(deny network*)
(deny file-write* (subpath "/Users/markus"))
(deny file-read* (subpath "/Users/markus"))
```

环境用 `/usr/bin/env -i`，不继承认证与真实用户环境。PYTHONDONTWRITEBYTECODE 禁止生成 pyc；所有 tempfile 使用本轮私有 TMPDIR。探针只清理自己创建的合成临时目录。两路复测分别并行运行，审计方没修改 peer 功能源码/测试/package。

记忆套件（cwd `<frozen>/input`，`<frozen>` 是上述完整绝对路径）：

```sh
/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)(deny file-write* (subpath "/Users/markus"))(deny file-read* (subpath "/Users/markus"))' /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin PYTHONPATH=/tmp/personal-ai-os-review-r1.bgwgKU/input:/tmp/personal-ai-os-review-r1.bgwgKU/python-deps/site-packages PYTHONDONTWRITEBYTECODE=1 TMPDIR=/tmp/personal-ai-os-review-r1.bgwgKU/migration-security /opt/homebrew/bin/python3.11 -m unittest discover -s /tmp/personal-ai-os-review-r1.bgwgKU/input/tests -p 'memory_*test.py' -q
```

运行时套件（同 cwd）：

```sh
/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)(deny file-write* (subpath "/Users/markus"))(deny file-read* (subpath "/Users/markus"))' /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin TMPDIR=/tmp/personal-ai-os-review-r1.bgwgKU/runtime-security /usr/local/bin/node --test /tmp/personal-ai-os-review-r1.bgwgKU/input/tests/runtime-ownership.test.mjs /tmp/personal-ai-os-review-r1.bgwgKU/input/tests/runtime-contract.test.mjs /tmp/personal-ai-os-review-r1.bgwgKU/input/tests/runtime-recovery.test.mjs /tmp/personal-ai-os-review-r1.bgwgKU/input/tests/runtime-owner.test.mjs /tmp/personal-ai-os-review-r1.bgwgKU/input/tests/runtime-tools.test.mjs
```

主审缺陷探针（cwd `<frozen>/parent-repros`）：

```sh
/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)(deny file-write* (subpath "/Users/markus"))(deny file-read* (subpath "/Users/markus"))' /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin PYTHONPATH=/tmp/personal-ai-os-review-r1.bgwgKU/input:/tmp/personal-ai-os-review-r1.bgwgKU/python-deps/site-packages PYTHONDONTWRITEBYTECODE=1 TMPDIR=/tmp/personal-ai-os-review-r1.bgwgKU/parent-repros /opt/homebrew/bin/python3.11 /tmp/personal-ai-os-review-r1.bgwgKU/parent-repros/m01_repros.py
/usr/bin/sandbox-exec -p '(version 1)(allow default)(deny network*)(deny file-write* (subpath "/Users/markus"))(deny file-read* (subpath "/Users/markus"))' /usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin TMPDIR=/tmp/personal-ai-os-review-r1.bgwgKU/parent-repros /usr/local/bin/node /tmp/personal-ai-os-review-r1.bgwgKU/parent-repros/m02_repros.mjs
```

## 辅助模型与独立性限制

- 原生 Reviewer 子代理 `m01_security_review`、`m02_ownership_review` 启动失败，原因是环境强制的旧模型不受当前账户支持；没有工具任务或有效审查结果。不计任何通过项，也不称其为 Terra。
- 已有官方 DeepSeek read-only job：`1791434451-b3e3bfc22a47`，状态 success，model `deepseek-flash`，官方 version check 为 `DeepSeek-V4.1-Flash`。只读 staging `/tmp/personal-ai-os-review-evidence.ORYc7b`；实际 migration/交接内容 hash 与 sourceRef 一致，`files_changed=[]`、`tests=[]`。只定位 M01 A/B/C 源码行为，没有复现/验收/部署；工程结论由主审和隔离探针给出。Worker 使用 input 15390 / output 862 tokens，缓存 input 5632 为 input 子集，reasoning output 2137 单列。
- Jev 用 `typesafe-ai` skill，读取官方 llms 索引、Noul 与 confidence 文档后调用 `/Users/markus/.local/bin/jev-eval`。输入只含合成证据范围和两段措辞，没有用户记忆原文、token/key 或同事私有聊天。
- [措辞输入](jev-wording-input.json)、[实际结果](jev-wording-result.json)：模型 `jev-1.13.0`；限定组件审计草稿的越界概率 0.17，故意夸大为“全部上线/24h稳定”的对照为 0.97。input 656 / output 46，API response 时间 854.88ms。Noul 无单独 confidence。
- Jev 不评工程 correctness、不签 release、不判授权；没有阈值动作。wrapper 对 Noul 的 criteria 不透传，所以本次所有边界均写入 instructions，没有声称 criteria 对请求生效。key 由 wrapper 私有读取，未访问或输出 key。

审计测试路径全部无网络/真实应用模型；上述两类辅助外呼另列，不能笼统宣称本轮从未调用任何外部模型。本报告也不是未参与历史组件的第三方独立签字。
