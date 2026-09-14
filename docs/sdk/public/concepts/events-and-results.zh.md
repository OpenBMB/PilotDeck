# 事件与终态

SDK query 是 `AsyncIterableIterator<PilotDeckMessage>`，事件可能包含 assistant、tool、permission、hook、dialog、subagent 和 system 消息。事件顺序由 Gateway stream 保证，随机 id 和时间戳不是业务语义。

每个 query 只有一个权威 `result()`：

| status | 含义 |
| --- | --- |
| `completed` | 服务端确认 turn 成功结束 |
| `failed` | 服务端确认失败，并提供 `PilotDeckError` |
| `aborted` | 任务被明确取消 |
| `result_unknown` | transport 断线或重启导致终态未确认 |

重复调用 `result()` 应得到同一终态。断线、timeout、permission deny 和 `close()` 都不能被映射成 completed。
