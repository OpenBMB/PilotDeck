# PilotDeck SDK CLI

目标分支中的 `pilotdeck` CLI 通过 `@pilotdeck/sdk` 连接已启动的 Gateway，提供会话和配置控制面：

```bash
pilotdeck run "检查当前测试失败原因"
pilotdeck resume "<session-id>" "继续修复上一个问题"
pilotdeck sessions list
pilotdeck sessions messages "<session-id>"
pilotdeck settings get
pilotdeck settings set '{"agent":{"thinking":{"enabled":true}}}'
```

默认 Gateway 地址是 `ws://127.0.0.1:18789/ws`，认证 token 从 `PILOTDECK_TOKEN`、`PILOTDECK_SDK_AUTH_TOKEN` 或 Gateway 的 `server-token` 文件读取。也可以使用 `--gateway-url` 和 `--auth-token` 显式传入。`run` 和 `resume` 默认流式输出 assistant 文本，`--json` 输出最终结果，`--stream-json` 输出事件 JSONL；prompt 省略时可从 stdin 读取。

配置更新只接受 SDK 已定义的非敏感 `localSettings` 字段，Gateway 负责校验和持久化，不会上传 provider 凭据或任意 YAML 内容。
