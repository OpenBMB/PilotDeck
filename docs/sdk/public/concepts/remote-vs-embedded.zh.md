# Remote 与 Embedded

| 模式 | SDK 进程 | Gateway | 工具 handler | 适用场景 |
| --- | --- | --- | --- | --- |
| Remote | 独立应用 | 远程/独立进程 | MCP endpoint 或 Gateway 工具 | 服务端、CLI |
| Embedded | 与宿主同进程 | 宿主创建并拥有 | Embedded registry | 本地集成、测试 |

Remote 使用 `query()` 或 `createPilotDeckClient()`。Embedded 使用 `@pilotdeck/sdk/embedded` 的 `createEmbeddedQuery()`、`createEmbeddedPilotDeckClient()` 或 `createEmbeddedPilotDeckHost()`，仍经过 Gateway wire dispatcher，不直接调用 AgentLoop。关闭 SDK host 不会 dispose 传入的 Gateway。
