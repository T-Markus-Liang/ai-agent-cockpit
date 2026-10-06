# Personal AI OS 回归评估

`control-plane-regression.mjs` 是不调用模型、不读取真实 Agent 消息、不写入真实 Agent 历史的协议级回归评估。它使用临时状态目录检查：

- 幂等键不会重复创建 Task；
- 非法 Execution 状态转移被拒绝；
- Approval 的 action/target/parametersDigest 不能错配；
- Session lock 阻止并发；
- 控制面重启不会把 running Execution 伪装成完成；
- Task 必须有验证和独立 review Evidence 才能完成；
- Cezar dispatch 的参数摘要必须绑定 Approval。

运行：

```bash
npm run eval:control-plane
```

输出是可归档的 JSON 报告；它不替代真实 provider、GUI、微信 prompt 或云端能力验收。
