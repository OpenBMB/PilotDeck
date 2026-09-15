# Public Exports 清单

本页以 package `exports` 和生成的 `dist/*.d.ts` 为事实源，说明哪些符号属于 `@pilotdeck/sdk` 的 public contract。它不包含实现组合点；参数、泛型和重载以随包发布的声明文件为准。

## 入口

| 入口 | 声明 | 用途 |
| --- | --- | --- |
| `@pilotdeck/sdk` | `dist/index.d.ts` | Root query、client、工具、MCP、会话、消息和错误 |
| `@pilotdeck/sdk/embedded` | `dist/embedded.d.ts` | Embedded transport、host、registry 和 session-store adapter |

## Root runtime

Root 入口公开 `query`、`startup`、`createQuery`、`createWarmQuery`、`createPilotDeckClient`、会话 helper、`resolveSettings`、`defineTool`/`tool`、MCP server helper、subagent helper、`GatewayTransport`、`AsyncEventQueue`、`mapError`、`PilotDeckError`、`AbortError`、SessionStore 实现，以及终端/浏览器/DOM/manual dialog renderer。

`createPilotDeckClientWithTransportFactory`、`createQueryWithTransport`、`createWarmQueryWithTransport`、`HostedHookServer` 和 `PilotDeckMcpServerImpl` 是内部组合点。虽然它们存在于 `dist`，但没有通过 root `index.d.ts` 的 public export 暴露，应用不得依赖。

## Embedded runtime

`@pilotdeck/sdk/embedded` 公开 `PilotDeckEmbeddedTransport`、`createEmbeddedQuery`、`startupEmbedded`、`createEmbeddedPilotDeckClient`、`PilotDeckEmbeddedToolRegistry`、`createEmbeddedToolRegistry`、`createEmbeddedPilotDeckHost`、`createEmbeddedSessionStore` 和 `toEmbeddedTool`，以及对应的 endpoint、host、connection、registry 和 persistence adapter 类型。Embedded runtime 只从此入口导入，root 不重导出这些符号。

## 类型范围

Root 还 re-export `types.d.ts`、`transport.d.ts`、`session-store.d.ts`、`compat.d.ts` 和各 dialog 模块中的 public 类型，覆盖 Options/Query、消息/结果、session/run/transcript、tools/MCP、permissions/hooks/dialogs、settings、usage/budget、checkpoint、plugins/skills/subagents、cron、transport 和错误类型。新增 public symbol 必须同步更新本页、[TypeScript Reference](typescript.zh.md)、兼容矩阵和示例。

## 自动检查

在仓库根目录运行：

```bash
node docs/sdk/tools/check-public-docs.mjs
```

脚本检查 package `exports` 的声明/runtime 文件、Reference 中的 runtime symbol 是否存在于生成声明，以及 `docs/sdk` 内的相对 Markdown 链接。
