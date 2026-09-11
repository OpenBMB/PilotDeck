# PilotDeck 当前可复用表面

## 重要限定

本文件描述 `20b8826` 快照中的内部 TypeScript 导出和协议，不把它们定义为稳定 npm SDK。根 `package.json` 的 `private: true` 且没有 `exports`；源码路径和符号可能随内部重构变化。本 worktree 另有新增的 `packages/sdk` `@pilotdeck/sdk` alpha，它通过 Gateway adapter 提供独立 ESM `exports`，但不改变这一基线判断。

## Agent 模块 API

入口：[`src/agent/index.ts`](../../src/agent/index.ts)

主要导出：

- `AgentLoop`、`AgentLoopInput`、`AgentLoopRunResult`、`AgentLoopSeedState`；
- `AgentSession`、`createAgentSession()`、`createAgentSessionWithStorage()`；
- `AgentEvent`、`createAgentEventBuffer()`、`AgentTurnResult`、`AgentStopReason`；
- `TurnRunner`、`TurnInputProcessor`；
- `ModelInvokerPort`、`ToolPort`、`AgentRuntimeDependencies`；
- `InProcessModuleAdapter`、`ModuleOperationHost`、`validateModuleMessage`、sidecar module protocol 类型。

最小的源码级调用形态（示意，实际还需组装 runtime/turn runner）：

```ts
const session = createAgentSession({
  sessionId,
  turnRunner,
  cwd: workspace,
});

for await (const event of session.submit(
  { type: "text", text: "检查测试失败并修复" },
  { maxTurns: 10, canPrompt: false },
)) {
  consume(event);
}
```

生命周期：

```text
AgentSession.submit
  -> session_started / SessionStart / Setup
  -> TurnRunner
     -> context prepare
     -> model stream
     -> tool calls / permission / tool results
     -> compaction/recovery/retry
  -> turn_completed 或 turn_failed
  -> SessionEnd / session_ended
```

## Tool 表面

入口：[`src/tool/index.ts`](../../src/tool/index.ts)

可复用能力包括：

- `ToolRegistry`、`createBuiltinRegistry()`、`filterAvailableTools()`；
- `ToolRuntime`、`ConcurrentToolScheduler`、`SequentialToolScheduler`；
- 文件、glob、grep、Bash、notebook、execute code、WebFetch/WebSearch、AskUserQuestion、plan/todo/task、structured output；
- `PilotDeckToolDefinition`、`PilotDeckToolCall`、`PilotDeckToolResult`、validation/error/audit 类型；
- `createMcpTool()`、MCP resources 工具。

这些是 AgentLoop 的内部 port/provider 组合，不是 Claude `tool()` 的一对一公共替代品。工具真正的副作用、并发、超时和 permission preflight 由 `ToolRuntime`/scheduler/宿主负责。

## Extension 表面：Hooks、Skills、Plugins

入口：[`src/extension/index.ts`](../../src/extension/index.ts)

- Hooks：事件常量、输入/输出协议、command/prompt/http/agent/callback executor、`HookRuntime`、`AsyncHookRegistry`、执行事件总线；
- Plugins：manifest、marketplace/source validation、plugin discovery/loading、`PluginRegistry`、`PluginRuntime`、contributions；
- Skills：`SkillManager`、skill discovery/read/write/create/delete/import/validate/scan 相关类型和 migration。

PilotDeck 有比一个简单 `query({hooks})` 更分散的扩展面；调用者需要通过 runtime/factory/Gateway 接线。

## Session、Transcript、Checkpoint

入口：[`src/session/index.ts`](../../src/session/index.ts)

- storage：`createAgentProjectSessionStorage`、`listAllSessions`、`listProjectSessions`、search/title；
- transcript：`JsonlTranscriptWriter`、`InMemoryTranscriptWriter`、`readTranscript`、replay、subagent transcript；
- metadata：`SessionMetadataStore`、title generator；
- persistence/projection：session event store、persistence、projection driver/checkpoint；
- files：`FileHistoryStore`、`createBackup`、`restoreBackup`；
- artifacts：`FileArtifactCollector`。

Session、turn、run、transcript 和 file history 的最终一致性属于宿主数据平面，不能仅凭 AgentLoop API 断言具备 Claude SessionStore 语义。

## Context、Permission、MCP

- Context：[`src/context/index.ts`](../../src/context/index.ts) 导出 `ContextRuntime`、`DefaultContextRuntime`、`PromptAssembler`、`TokenBudgetManager`、compaction/recovery、memory、instructions、attachments。
- Permission：[`src/permission/index.ts`](../../src/permission/index.ts) 导出 `PermissionContext`、`PermissionRuntime`、rule set、settings 和 matcher。
- MCP：[`src/mcp/index.ts`](../../src/mcp/index.ts) 导出 `McpClient`、`McpRuntime`、stdio/HTTP 配置、plugin bridge、resource/tool wire name 和状态类型。

## Gateway/WebSocket/Remote 表面

入口：[`src/gateway/index.ts`](../../src/gateway/index.ts)、[`src/gateway/protocol/frames.ts`](../../src/gateway/protocol/frames.ts)、[`src/gateway/protocol/types.ts`](../../src/gateway/protocol/types.ts)

`Gateway` 公开的主要操作包括：

- `submitTurn`、`steerTurn`、`cancelSteer`、`abortTurn`；
- `listSessions`、`resumeSession`、`newSession`、`closeSession`、`forkSession`、读取 session/subagent messages；
- `permissionDecide`、`respondElicitation`、`respondUserDialog`、`listUserDialogs`、`claimUserDialog`、`releaseUserDialog`、`grantSessionPermission`；
- project/files/commands/model catalog 查询；
- skill list/read/write/create/delete/import/validate/scan；
- config/extension reload；
- cron 和 always-on 操作；其中 alpha SDK 的 `client.cron.create/list/update/delete/stop/runNow` 是对 `cron_*` Gateway 请求的类型化资源包装。

WebSocket frame 包含 `hello`/`hello_ok`、request/response、带 `seq` 和 `final` 的 event，以及 server notification。该层是可构建客户端的协议，但它不是 Claude Agent SDK 的 `query()` API，也不应把 Gateway 方法名当作稳定 npm contract。

alpha SDK 已把 `set_mcp_permission_mode_override` 封装为 `Query.setMcpPermissionModeOverride(serverName, mode)`，并提供无需创建或消费 Query 的 `client.mcp.status()`/`.setServers()`/`.reconnect()`/`.toggle()`/`.setPermissionModeOverride()` resource client。Gateway 宿主将权限覆写收敛为 session-scoped `PermissionContext.rules.ask` 规则：`default` 与 `auto` 都让目标 `mcp__<server>__*` 工具走原生审批；`auto` 由于没有 Claude classifier 会带 warning；`null` 清除覆盖。resource client 只能管理 SDK-owned session MCP 配置，不能覆盖项目或 plugin-owned server；未请求该控制时，原生 MCP 权限语义不变。

`GatewayUserDialogBus` 是 generic `input`/`select`/`confirm`/`form` 对话的权威 live pending state。alpha SDK 在 `userDialogMode: "manual"` 下将 `user_dialog_request` 投影为流事件，并以 `Query.respondUserDialog()` 或独立的 `client.dialogs.list()`/`.watch()`/`.claim()`/`.release()`/`.respond()` 包装 Gateway resource API。`watch()` 由已绑定的 Gateway Server 向同一 session 的 SDK control connection 投递 `requested`、lease change 与 settled 的 best-effort hint；它不泄露 opaque lease token、不记录 durable event log，renderer 在重连、漏通知或动作前仍应以 `list()` 取权威快照。`createManualUserDialogRenderer()` 是 SDK-only coordinator：它将 watch/list/claim/续租/render/respond/release 串为一条调用流程，但不存储 pending record 或改变 Gateway cleanup。`claim()` 创建带到期时间的 opaque renderer lease；list 只显示 `expiresAt`，持有 lease 的 renderer 才能答复，释放或过期后其他 renderer 可接手。live request 仍是 immutable、session-scoped snapshot，answer、abort、timeout 或 turn 结束即由 Gateway 删除，且 cleanup 不受 renderer lease 阻塞。persistent session 另以 `GatewayUserDialogJournal` 在请求投递前写入 transcript 同目录的原子 journal；新 Gateway 将遗留项投影为 `user_dialog_terminated`/`gateway_restarted` record。对该 record 的有效 answer 会由 Gateway 重新按原 contract 校验，写入 synthetic durable user context、删除 journal，并返回 `{ delivered: true, recovered: true, reason: "gateway_restarted" }`；下一条新 turn 才会消费该上下文。该记录绝不恢复旧 AgentLoop、turn、dialog promise 或 transcript run state。Gateway 还导出可由宿主显式注入 `createLocalGateway({ userDialogStore })` 的 `FileGatewayUserDialogStore`：它在共享本地文件系统使用 per-session lock 和 atomic rename 持久化 pending record，并完整实现跨 Gateway renderer lease/answer handoff。原 Gateway 以 owner heartbeat 保持 live projection；过期记录由第二个 Gateway 自动投影为 restart-terminal recovery，绝不转移旧 AgentLoop/tool promise。需要跨机器时，宿主可在专用 store host 上以 `startGatewayUserDialogStoreHttpServer({ store, authorizationToken })` 暴露完整 live/owner 协议，并让各 Gateway 注入 `new HttpGatewayUserDialogStore({ url, authorizationToken })`。HTTP service 采用版本化 JSON 请求和 bearer 校验，强制 backing store 支持 live renderer 与 owner-heartbeat 的所有原子操作；它只传递 durable dialog record、lease 与 answer，不传递 AgentLoop/run/tool promise。真实 Gateway E2E 已覆盖远端 JSON Schema form 的 lease/answer handoff 及 owner expiry 后的 terminal recovery；跨 Gateway 重启仍不会自动恢复旧 turn。

Gateway host 还导出 `createBubblewrapSandboxProfile()`、`GatewayHostSandboxProfile` 和 `GatewayHostSandboxProfiles`。`createLocalGateway({ sandboxProfiles: { <name>: profile } })` 只在 SDK session 请求 `sandbox: { type: "host", profile: <name> }` 时使用 profile 创建原生 Bash runner；profile 名称由 Gateway 验证，SDK 不能注入 runner、可执行文件、mount、环境或 credential。命名 host profile 的 `filesystem: "read_only"` 和 `"deny"` 都会删除 Gateway 进程内全部 `kind: "filesystem"` native tool，以及 Python `pilotdeck_tools` 中所有 filesystem helper（含 `read_file`、`glob`、`grep`），避免 read-only 文件访问绕过 profile-owned mount；workspace 文件只能由 profile-owned Bash/Python 读取。`toolIsolation: "strict"` 默认只保留 profile-owned `bash` 与 Gateway-local structured output/request-user tools，直接 native filesystem、MCP、custom、network、skills、task/subagent tools 都被移除。若 host profile 显式声明 `supportsStrictExecuteCode: true`，strict 模式还可保留通过同一 runner 执行的 `execute_code`；它得到无 socket、无 helper function 的 `pilotdeck_tools` 模块，Gateway RPC 也拒绝所有 request，不能回到未隔离工具面。内置 Bubblewrap profile 需以 `createBubblewrapSandboxProfile({ enableStrictExecuteCode: true })` 明确开启该项。strict 模式仍不把 provider、Gateway 进程或已启动基础设施放进该 boundary，因此不等价于完整 OS sandbox。

Gateway host 还导出 `GatewayNativeSessionStorageAdapter`、`createGatewayNativeSessionStorage()` 和 `resolveGatewayNativeProjectChatDir()`，并可在 `createLocalGateway({ nativeSessionStorage })` 注入本地 native session-storage layout。adapter 显式提供稳定的 project `getProjectChatDir()` 及每 session 的 `AgentProjectSessionStorage`；默认未配置时保持既有 JSONL 路径。create/resume/recreate、list/read、fork、last-turn replacement、portable export/restore、delete 和 checkpoint replay 都使用这份 Gateway-owned layout，SDK client 不接触 storage handle。它不等于 `createEmbeddedSessionStore()` 的 SDK event mirror，也不提供异步 DB/object-store transcript backend。

`@pilotdeck/sdk` 现把已有 Gateway last-turn transaction 公开为顶层 `prepareLastTurnReplacement()` 与 `client.sessions.prepareLastTurnReplacement()`。返回对象的 `start()` 只会创建一次使用预留 replacement `runId` 的 run；在该 run 首次消费前，调用者也可 `rollback()`。Gateway 在 accepted input 时自动 commit，或在未接受 input 时按自身 timeout/recovery 回滚；SDK 不拥有 transaction journal、备份文件或 transcript 状态机。

alpha SDK 还把 `apply_flag_settings` 封装为 `Query.applyFlagSettings(settings)`。当前 Gateway 只接受 session-scoped 的 `effortLevel` 和 `permissions.defaultMode`（可用 `null` 清除），并在变更后淘汰缓存 session runtime；活动 turn 会拒绝修改。它不是完整 Claude settings 文件或 flag-layer 写入 API，未知字段必须显式报 `unsupported_capability`。

`Query.updateSettings("localSettings", settings)` 是独立的持久化控制面。它经 `update_settings` 由 Gateway 写入宿主自己的 `$PILOT_HOME/pilotdeck.yaml`，而不会写 SDK 调用者机器的文件；当前 allowlist 为 `agent.maxContextTokens`、`agent.maxOutputTokens`、`agent.thinking`、`agent.subagents.default`/`.timeoutMs`、`extension.includeHookEvents`、`extension.builtinPluginsEnabled` 和 `tools.webSearch.enabled`，`null` 表示清除覆盖。SDK 只能开关既有 web-search 集成，不能写 provider/endpoint/API key；内置插件 map 也只接受布尔开关，不接受插件路径。Gateway 在临时目录完成完整配置校验后才原子替换文件，并调用 `PilotConfigStore.reload()`；AgentLoop 不处理该 API，原生配置 change class 决定何时生效。任意 YAML key、provider/model、凭据和其他 Claude setting source 都不是该 API 的能力。

`PilotDeckOptions.settingSources` 现可选择 `managed`、`user`、`project`、`local`。`managed` 只投影 Gateway embedding host 的 `organizationPolicy.settings.managedSessionSettings` non-secret overlay；SDK 不能发送、读取或修改其内容。Gateway 固定按 `managed < user < project < local` 合并，调用者传入顺序不改变 precedence；host `settingSources.allow`/`.deny` 在读取 source 前执行，显式 SDK `settings` 在 source 之后覆盖，host `enforcedSessionSettings` 与 token cap 仍在最末端。SDK session marker 是这条 overlay 的必要条件，直接 native Gateway 调用不受影响。

`PilotDeckOptions.managedSettings` 是另一条不持久化的、Gateway-owned restrictive policy 表面：`permissions.deny`、`permissions.ask`、`permissions.defaultMode: "plan"`、`permissions.canPrompt: false`，以及 `tools` 和 `models` 的 allow/deny selector 都只能收紧，不会授予权限或配置 provider/凭据。Gateway embedding host 可在 `createLocalGateway({ organizationPolicy })` 中配置 wire 外的组织策略，并用 `providers.allow`/`.deny`、`providers.origins.allow`/`.deny` 与 `providers.credentials.allow`/`.deny` 约束 exact provider ID、credential-free HTTP(S) origin 和凭据来源类别（`environment`、`literal`、`provider_default`）。策略在 session model selection、Router 和直接 ModelRuntime 请求前执行；拒绝不会触发 provider request，且 API key、环境变量名、完整 endpoint path 与策略内容都不出现在 SDK wire。`settings.sessionDefaults`/`.sessionDefaultSources` 提供低优先级非密钥 overlay，`settings.enforcedSessionSettings` 则以同一 allowlist 在 source、SDK settings、`Options.model`/`.fallbackModel` 和 session thinking update 后强制覆盖；这三者只影响 capability-negotiated SDK session，直接 Gateway 调用不受 SDK overlay 影响。该受控 host cascade 已完整覆盖 PilotDeck 的 SDK ownership 边界；它不等同于远程 SDK 可写任意 Claude settings、provider 配置或凭据。

SDK 顶层 `resolveSettings()` 则以 `resolve_settings` 读取 Gateway 的当前 `PilotConfigStore` snapshot。Wire result 包含已脱敏 `config`、配置来源、诊断、schema/version/content hash 和 ISO 时间；它不读取远程 SDK 调用者的工作站配置，也不会传输 provider 密钥。该读 API 是配置诊断与 provenance 表面，不是可写 settings 文件或完整 Claude resolver 的替代。

## Module/sidecar 表面

Agent module protocol 在 `src/agent/modules/` 和 `docs/pilotdeck-module-protocol-v2.schema.json` 中定义 `hello`、`capabilities`、`execute`、`module_call`、operation identity、cancel/deadline、event/final outcome 等语义。它适合跨进程/跨语言 adapter；宿主仍拥有 session、turn、run、operation、permission、checkpoint 和最终结果。

## 不应宣称为已有 SDK 的能力

- 基线根包没有正式发布的 `@pilotdeck/sdk`、npm exports 或稳定版本承诺；本 worktree 新增的 `packages/sdk` 是独立的 `0.1.0-alpha.0` package，仍不承诺稳定 API；
- 没有把所有内部模块合并为单一 `query()`/`Client` façade；
- 已有 Claude-like `SessionStore` 与公开 `Query.rewindFiles()`；file snapshot 索引已写入 transcript 并在 session resume 时 replay，但真实 Gateway 重启 E2E、冲突策略和完整 runtime schema validator 仍缺失；
- 没有将 Gateway、sidecar 和源码 exports 的兼容性等同于公共 API 稳定性。
