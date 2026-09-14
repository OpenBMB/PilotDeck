# Transports

## Remote

`query()` 和 `createPilotDeckClient()` 使用 Gateway WebSocket transport，完成 hello、认证、capability negotiation 和 request/event multiplexing。`reconnect` 只适合初始握手阶段的 transient failure；已提交 turn 的 stream 断线不得自动重放。

## Embedded

`@pilotdeck/sdk/embedded` 使用宿主提供的 in-memory Gateway endpoint。`createEmbeddedPilotDeckHost()` 可组合 typed client 与本地工具 registry，但宿主仍拥有 Gateway、模型、session、权限、storage 和 shutdown。

两种 transport 都应该使用相同的 public message、result 和 error contract；测试比较 canonical messages 和副作用，不比较 transport envelope、随机 id 或时间戳。
