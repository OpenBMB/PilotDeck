# PilotDeck SDK Overview

`@pilotdeck/sdk` 是 PilotDeck Gateway 的 TypeScript client façade。它把 query、session、流式事件、权限回调、MCP 工具和 Embedded transport 组织成可安装的 SDK，同时复用 Gateway/Native AgentLoop 的权威状态。

## 适合什么场景

- 服务端、CLI、自动化任务：使用 Remote Gateway；
- 业务工具：使用 `tool()` + `createSdkMcpServer()`；
- 同进程宿主：使用 `@pilotdeck/sdk/embedded`；
- 多轮任务：使用 `createPilotDeckClient()` 管理 sessions 和 runs。

SDK 不实现第二套 AgentLoop、权限系统、transcript 或预算账本。Gateway/Native 拥有 session、run、permission、tool execution、checkpoint、usage 和 budget 的最终语义。

## 能力概览

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| Query | `query()`、`startup()` | 流式消息和唯一终态 |
| Session | `createPilotDeckClient()`、session helpers | create/resume/fork/transcript |
| Tools | `tool()`、`createSdkMcpServer()` | session-scoped MCP 工具 |
| Embedded | `@pilotdeck/sdk/embedded` | 复用宿主 Gateway，不创建新 runtime |
| 控制面 | permission、settings、hooks、dialog、usage | 通过 Gateway 协议调用 |

## 下一步

- [Quickstart](quickstart.zh.md)
- [Core Concepts](concepts/README.zh.md)
- [Capability Guides](guides/README.zh.md)
- [TypeScript API Reference](reference/README.zh.md)
- [Examples](examples/README.zh.md)
- [Operations](operations/README.zh.md)
