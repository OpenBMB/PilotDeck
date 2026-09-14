# Errors Reference

`PilotDeckError` 提供 `code`、`message`、可选 `requestId`、`details` 和 `retryable`。常见 code：`authentication_error`、`validation_error`、`permission_denied`、`timeout`、`transport_error`、`unsupported_capability`、`aborted`、`result_unknown`。

处理原则：

- `unsupported_capability`：检查 capability/版本或终止，不静默降级；
- `timeout`/`transport_error`：先确认服务端状态，再决定重试；
- `permission_denied`：不要重放有副作用工具；
- `result_unknown`：查询 Gateway session/run，不能当成功或失败；
- `aborted`：任务已明确取消。
