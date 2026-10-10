# D95 重启韧性三修复 证据

## 事故
- 机器重启 2026-10-10 12:19:13 +0800（uptime / pmset "Total Sleep/Wakes since boot at 2026-10-10 12:19:13"）
- canary（pid 53426）终止，最后 tick 12:06:46；旧 jsonl 归档 logs/canary-24h.invalid-reboot-20261010-121906.jsonl
- memory launchd 重试后 exit 3（fastembed 模型无缓存、外网下载失败，logs/memory-launchd.err.log）
- control-plane :4324 down（plist 未入 LaunchAgents）

## 修复① memory 持久缓存
- 根因：fastembed 0.8.1 define_cache_dir 默认 tempfile.gettempdir() = $TMPDIR（macOS 重启清空）
- 6 文件下载自 hf-mirror（qdrant/paraphrase-multilingual-MiniLM-L12-v2-onnx-Q），落 ~/.cache/fastembed
- sha256 与官方 blob 一致：model_optimized.onnx=634d0f66c29dc934c8fa72b8a4fe91dd4d420a22f1d82a241058d4316e659a99（与 fastembed 首次下载的 incomplete blob 名吻合）；tokenizer_config.json=6af3e8bba20e4425103afb1ae3dee3cacdbe7afb 尺寸 1416；special_tokens_map.json=b1879d702821e753ffe4245048eee415d54a9385 尺寸 964；tokenizer.json=18224073dc412458d77afb4874d1c2f159bf90441105531e2c7fb0765efe9df5 尺寸 17083009；config.json sha256=c8ec081fdad2df991bf5abbf18418fec7a5cdaa421f60ffb060a30040b8c376f
- HF hub 缓存布局：blobs/ + snapshots/faf4aa42…/ 软链 + refs/main（rev 取首次 fastembed 下载的 trees json 文件名）
- 离线验证：HF_HUB_OFFLINE=1 FASTEMBED_CACHE_PATH=~/.cache/fastembed → 加载 0.5s、embed dim 384 实测
- plist（仓库 launchd/ 与 ~/Library/LaunchAgents 同步）增 FASTEMBED_CACHE_PATH；bootout+bootstrap；health ok（ingest done 118）

## 修复② control-plane 常驻
- cp launchd/com.markus.ai-agent-cockpit.control-plane.plist ~/Library/LaunchAgents/（项目惯例=副本，经 diff 核实 memory plist 亦同）；bootout+bootstrap；:4324/health 200

## 修复③ canary 第 3 次起表
- pid 3900，自 14:24 计时；首 tick 14:24:04 五服务全 200

## 复验
- S02 实盘 verify-s02-live.mjs：11/11 PASS（修复前 memory down 时 6 项红）
- secret scan PASS 0 命中；根侧 node --test tests/*.test.mjs exit 0
- memory 测试复跑：见 task bash-i3vhju5w / 台账补记

## 附：canary 日记原文（logs/ 属 gitignore，不入树，在此留副本）
- 12:19 重启事件、14:24 第 3 次起表记录均已写入 logs/canary-24h-diary.md（本地留存）。
