# TypeScript API Reference

公共入口为 `@pilotdeck/sdk` 和 `@pilotdeck/sdk/embedded`，具体导出以 package `exports` 与当前生成的 `dist/*.d.ts` 为准。完整入口清单见 [Public Exports](exports.zh.md)。

## 顶层函数

| Symbol | 作用 |
| --- | --- |
| `query(params)` | 创建流式 SDK query |
| `startup(params?)` | 预热 Gateway 连接并返回 WarmQuery |
| `createPilotDeckClient(options)` | 创建多轮 session/run client |
| `createQuery(prompt, options)` | 创建 query 的显式别名 |
| `tool(name, description, schema, handler, extras?)` | 创建 SDK 工具定义 |
| `createSdkMcpServer(options)` | 创建 SDK-hosted MCP server |
| `listSessions(options?)` | 查询 session 摘要 |
| `getSessionMessages(sessionId, options?)` | 查询 transcript 消息 |
| `forkSession(sessionId, options?)` | 创建 session 分支 |
| `exportSessionTranscript(sessionId, options?)` | 导出 transcript |
| `restoreSessionTranscript(sessionId, transcript, options?)` | 恢复 transcript |

## Embedded 入口

`createEmbeddedQuery()`、`startupEmbedded()`、`createEmbeddedPilotDeckClient()`、`createEmbeddedToolRegistry()` 和 `createEmbeddedPilotDeckHost()` 位于 `@pilotdeck/sdk/embedded`。它们要求宿主提供权威 Gateway endpoint/host。

## `PilotDeckOptions`

| 分组 | 主要字段 | 说明 |
| --- | --- | --- |
| connection | `gatewayUrl`、`authToken`、`projectKey`、`channelKey`、`timeoutMs`、`reconnect` | Gateway 连接和握手 |
| model/context | `model`、`fallbackModel`、`effort`、`thinking`、`maxTurns`、`cwd`、`systemPrompt`、`additionalDirectories` | session/runtime 构造配置 |
| tools | `tools`、`toolAliases`、`allowedTools`、`disallowedTools`、`deferredTools`、`mcpServers` | 工具可见性和 MCP |
| permissions | `permissionMode`、`canUseTool`、`managedSettings` | SDK callback 只提交决定，Gateway 最终裁决 |
| lifecycle | `abortController`、`includePartialMessages`、`includeHookEvents`、`persistSession` | 流、取消和 session 行为 |
| extensions | `hooks`、`plugins`、`agents`、`skills`、`onElicitation`、`onUserDialog` | session/child-scoped 扩展 |
| output/budget | `outputFormat`、`maxBudgetUsd`、`taskBudget`、`promptSuggestions` | 由 Gateway/Native 持有权威语义 |

`env`、`executable`、`executableArgs`、`pathToClaudeCodeExecutable`、`spawnClaudeCodeProcess` 和 `systemPrompt` 的 Claude preset 形状不代表 PilotDeck 会启动 Claude CLI；不支持的组合会返回 `unsupported_capability`。

## Query 和 Run

`PilotDeckQuery` 支持异步迭代、`result()`、`abort()`、`interrupt()`、`steer()`、`respondUserDialog()`、`setPermissionMode()`、`setModel()`、`usage()`、`modelUsage()`、`rewindFiles()` 和 `close()`。`PilotDeckRunHandle` 提供 `events()`、`result()`、`steer()`、`abort()`。

## Client resources

`PilotDeckClient` 提供以下 Gateway-owned resource：

| Resource | 方法示例 |
| --- | --- |
| `sessions` | `create()`、`list()`、`get()`、`messages()`、`rename()`、`tag()`、`fork()`、`delete()` |
| `runs` | `start()`，返回 `PilotDeckRunHandle` |
| `mcp` | `status()`、`setServers()`、`toggle()`、`reconnect()`、`setPermissionModeOverride()` |
| `dialogs` | `list()`、`watch()`、`claim()`、`respond()`、`release()` |
| `cron` | `create()`、`list()`、`update()`、`delete()`、`stop()`、`runNow()`；这是 PilotDeck 定时任务，不等价于 Claude background task |

常用独立 helper 还包括 `getSessionInfo()`、`getSessionMessages()`、`renameSession()`、`tagSession()`、`forkSession()`、`deleteSession()`、`getSubagentMessages()` 和 `listSubagents()`。

## 工具、MCP 和错误类型

`PilotDeckToolDefinition` 包含 `name`、`description`、`inputSchema`、`handler` 和可选 `extras`。handler 接收 `{ signal, toolUseId }`，返回 `PilotDeckToolResult`。`PilotDeckMcpServer` 提供 `start()`、`close()`、`config` 和 `deferredTools`；关闭必须幂等。

`PilotDeckError` 和 `AbortError` 从主入口导出。跨进程边界只使用结构化 `PilotDeckError`，不要依赖错误 message 文本判断重试或成功。

详细字段以 `packages/sdk/src/types.ts` 的 public declarations 为准；内部类不是 public contract。

## Public symbol index

以下是当前两个 package exports 的可见符号分组。完整字段、泛型和重载以随包发布的 `dist/*.d.ts` 为准；新增符号必须同步更新本页。

### Runtime functions and classes

| 模块 | 符号 |
| --- | --- |
| root | `query`、`startup`、`createQuery`、`createWarmQuery`、`createPilotDeckClient` |
| root | `listSessions`、`getSessionInfo`、`getSessionMessages`、`exportSessionTranscript`、`restoreSessionTranscript`、`renameSession`、`tagSession`、`forkSession`、`deleteSession` |
| root | `prepareLastTurnReplacement`、`resolveSettings`、`defineTool`/`tool`、`createPilotDeckMcpServer`/`createSdkMcpServer`、`getSubagentMessages`、`listSubagents` |
| root | `GatewayTransport`、`AsyncEventQueue`、`PilotDeckError`、`AbortError`、`InMemorySessionStore`、`FileSessionStore`、`SessionStoreError` |
| root | `createTerminalUserDialogHandler`、`renderTerminalUserDialog`、`createBrowserUserDialogHandler`、`renderBrowserUserDialog`、`createDomBrowserDialogDriver`、`renderDomBrowserUserDialog`、`createManualUserDialogRenderer` |
| `/embedded` | `PilotDeckEmbeddedTransport`、`createEmbeddedQuery`、`startupEmbedded`、`createEmbeddedPilotDeckClient`、`PilotDeckEmbeddedToolRegistry`、`createEmbeddedToolRegistry`、`createEmbeddedPilotDeckHost`、`createEmbeddedSessionStore`、`toEmbeddedTool` |

### Type groups

| 主题 | 主要类型 |
| --- | --- |
| Claude aliases | `Options`、`Query`、`WarmQuery`、`SDKMessage`、`SDKUserMessage`、`SDKResultMessage` |
| connection | `PilotDeckConnectionOptions`、`GatewayConnectionOptions`、`GatewayReconnectOptions`、`PilotDeckServerInfo`、`PilotDeckInitializationResult` |
| query/run | `PilotDeckOptions`、`PilotDeckQuery`、`PilotDeckRunInput`、`PilotDeckRunHandle`、`PilotDeckResult` |
| session | `PilotDeckSession`、`PilotDeckSessionInfo`、`PilotDeckSessionTranscript`、`ListSessionsOptions`、`ForkSessionOptions` |
| tools/MCP | `PilotDeckToolDefinition`、`PilotDeckToolHandler`、`PilotDeckToolResult`、`PilotDeckMcpServer`、`PilotDeckMcpServerConfig`、`PilotDeckMcpTransportConfig` |
| permissions/hooks | `CanUseTool`、`PermissionDecision`、`PilotDeckHooks`、`PilotDeckHookCallback`、`PilotDeckHookEvent` |
| dialogs | `PilotDeckUserDialogRequest`、`PilotDeckUserDialogResult`、`PilotDeckUserDialogRecord`、`OnUserDialog`、`OnElicitation` |
| control plane | `PilotDeckContextUsage`、`PilotDeckUsage`、`PilotDeckModelUsageSnapshot`、`PilotDeckResolvedSettings`、`PilotDeckOutputStyle`、`PilotDeckRewindResult` |
| extensions | `PilotDeckAgentDefinition`、`PilotDeckPluginConfig`、`PilotDeckSkill`、`PilotDeckCronTask`、`PilotDeckCronRun` |
| embedded | `PilotDeckEmbeddedGatewayEndpoint`、`PilotDeckEmbeddedConnectionOptions`、`PilotDeckEmbeddedClientOptions`、`PilotDeckEmbeddedHost` |
