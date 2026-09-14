# Troubleshooting

按顺序检查：

1. 应用实际加载的 SDK package path 和版本；
2. `initializationResult()` 返回的 Gateway/protocol/capabilities；
3. token、Gateway URL、MCP `publicUrl`、端口、代理和 TLS；
4. session scope、allowed/disallowed、managed policy 和 deferred tools；
5. permission request id、callback deadline 和错误 code；
6. transcript、checkpoint、budget ledger 和 dialog journal；
7. 仍无法解释时运行 Native baseline/current parity。

常见症状：MCP 不可达不会产生工具成功；`close()` 不等于 abort；断线可能是 `result_unknown`；旧包或旧 Gateway 会明确返回 capability 错误；SDK session tool 不会出现在其他 session。

## 症状到动作

| 症状 | 先检查 | 处理 |
| --- | --- | --- |
| `unsupported_capability` | Gateway hello 的 capabilities、SDK 版本 | 升级兼容 Gateway/SDK，或显式关闭该能力 |
| `result_unknown` | session/run 状态和 transcript | 不重放副作用请求，查询后新建 turn |
| 工具不可见 | `allowedTools`、`disallowedTools`、deferred catalog、session scope | 确认工具属于该 session 且 Gateway 能访问 MCP |
| permission 一直等待 | callback deadline、requestId、host policy | 检查 callback 是否可达；超时应 fail closed |
| 重启后内容缺失 | Gateway transcript/checkpoint/budget storage | 确认持久化目录和 Gateway owner，不依赖 SDK event mirror |
