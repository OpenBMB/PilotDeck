# Sessions、Runs 和恢复

session 是持久化上下文的容器；run 是一次 turn 执行；query 是 SDK 对 run 事件流的便捷 façade。多轮任务使用 `createPilotDeckClient()`，通过 `client.sessions` 和 `client.runs` 管理资源。

`resume` 读取 Gateway 已持久化的 session/transcript，`fork` 创建新的 session 分支，`exportSessionTranscript()`/`restoreSessionTranscript()` 用于显式迁移。Gateway 重启可以恢复已写入的 transcript、checkpoint、usage 或 budget，但不会恢复 active turn 或 tool promise。

未知终态使用 `result_unknown`。调用方应查询 session/run 状态后决定是否继续，不能自动重放有副作用的请求。
