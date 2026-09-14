# Messages Reference

主要消息族包括 `assistant.message`、`assistant.thinking`、`tool.started`、`tool.progress`、`tool.completed`、`tool.failed`、`permission.requested`、`hook.*`、`user_dialog.requested`、`subagent.*` 和 `result`。所有消息都携带 Gateway stream 的事件元数据；随机 id 和时间戳不是稳定业务字段。

工具调用顺序、权限决定、工具结果和 `result` 终态属于语义字段，parity 或集成测试不得忽略。
