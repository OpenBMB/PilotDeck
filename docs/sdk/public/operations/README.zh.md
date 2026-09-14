# Operations

- [Compatibility Matrix](../reference/compatibility.zh.md)
- [Migration 与 Changelog](../migration/README.zh.md)
- [Troubleshooting](../troubleshooting.zh.md)

## 发布前

记录 SDK package version、Gateway version、protocol version、capabilities、Node.js version 和目标 project/session scope。Remote 发布确认 Gateway URL、认证、MCP/hook endpoint 可达；Embedded 发布确认宿主拥有 Gateway、endpoint、storage 和 shutdown。

## 发布后

升级应用依赖并重启应用和 SDK-hosted MCP/hook server，创建新的 query/runtime，验证 `initializationResult()`、工具事件、permission decision、final result 和错误 code。协议变更必须先部署兼容 Gateway；旧 Gateway 对新能力必须返回 `unsupported_capability`。

## 监控

至少记录连接失败、`result_unknown`、permission deny、MCP status、预算停止、session restart recovery 和 SDK/Gateway capability mismatch。不要把客户端 event mirror 当作 transcript、usage 或 budget 的权威来源。

## 回滚

发现新 SDK 与 Gateway 不兼容时，先停止提交新的有副作用 turn，保留 `result_unknown` 请求的 `requestId/sessionId/runId`，再回滚业务应用到上一版 SDK。不要删除 Gateway transcript 或 budget ledger；回滚后先查询状态，再决定是否创建新 run。
