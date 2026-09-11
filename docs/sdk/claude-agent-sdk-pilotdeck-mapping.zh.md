# Claude Agent SDK → PilotDeck 语义映射

> 原生源码路径说明的是语义所有权；本次交付的 `@pilotdeck/sdk` alpha 将其中受支持的能力封装为 Gateway-first public API，不转移 AgentLoop、ToolRuntime、PermissionRuntime 或 Session 的所有权。

## 1. Agent Loop、查询和流式输出

| Claude 语义 | PilotDeck 实现 | 状态 | 关键差异/所有权 |
|---|---|---|---|
| `query()` 驱动自主循环 | `@pilotdeck/sdk query()` → Gateway `submit_turn` → `AgentSession.submit()` → `TurnRunner.run()` → `AgentLoop`（`packages/sdk/src/index.ts`、`src/agent/session/AgentSession.ts`、`src/agent/turn/TurnRunner.ts`、`src/agent/loop/AgentLoop.ts`） | 部分等价 | 两者均以 async iterator 交付流；PilotDeck Gateway 仍持有 session/turn/run 的权威状态。 |
| assistant/tool/result 消息循环 | `AgentEvent`、`AgentTurnResult`、canonical model/tool messages（`src/agent/protocol/events.ts`、`src/agent/protocol/result.ts`、`src/model/`） | 等价 | 事件名称和字段不同；PilotDeck 保留唯一 `turn_completed`/`turn_failed` 终态。 |
| `includePartialMessages` | `model_event` canonical stream（`src/agent/protocol/events.ts`、`src/model/`） | 部分等价 | PilotDeck 事件经过 canonical model adapter，不承诺暴露 Anthropic 原始 BetaMessage。 |
| `maxTurns`、abort | `AgentSubmitOptions.maxTurns`、`AgentSession.abort()`、Gateway `abort_turn`（`src/agent/protocol/input.ts`、`src/agent/session/AgentSession.ts`、`src/gateway/`） | 等价 | Claude 以 `ResultMessage` subtype 返回；PilotDeck 以 result/error/aborted 类型和 stopReason 返回。 |
| `maxBudgetUsd` | SDK `PilotDeckOptions.maxBudgetUsd`、Gateway `submit_turn`、`AgentSession`/`TurnRunner`/`AgentLoop`、Router `TokenStatsCollector.estimateCost()`、experimental `taskBudget.total` durable ledger（`packages/sdk/src/client.ts`、`src/gateway/protocol/types.ts`、`src/cli/createLocalGateway.ts`、`src/agent/`、`src/router/`） | 部分等价 | `maxBudgetUsd` 对单个 submitted turn 累加 provider native cost 或 Router 价格表成本；跨阈值后在恢复、工具副作用和下一次模型调用前以 `agent_max_budget_reached`/`max_budget` 停止。`taskBudget.total` 额外提供 Gateway-owned session/project shared ceiling，跨 Gateway restart 恢复；第一个 project config 固化 total，冲突值会在 native session 创建前拒绝。它仍不是 Claude 的统一计费语义。 |

## 2. 内置工具、批处理和输出

| Claude 能力 | PilotDeck 证据 | 状态 | 差异 |
|---|---|---|---|
| Read/Write/Edit/Glob/Grep | `src/tool/builtin/*`、`ToolRegistry`（`src/tool/index.ts`） | 等价 | PilotDeck 额外有 freshness、路径安全、文件快照和语法诊断规则。 |
| Bash/Notebook/Web | `createBashTool`、`createEditNotebookTool`、`createWebFetchTool`、`createWebSearchTool`（`src/tool/builtin/`） | 等价 | Web、命令和 notebook 的权限/结果格式是 PilotDeck 自己的协议。 |
| AskUserQuestion/elicitation | `createAskUserQuestionTool`、`PilotDeckElicitationChannel`、Gateway elicitation bus、SDK `onElicitation`/`onUserDialog` adapter（`src/tool/builtin/askUserQuestion.ts`、`src/tool/elicitation/`、`src/gateway/elicitation/`） | 部分等价 | native `elicitation` 复用 Gateway response lifecycle；当 `onUserDialog` 不声明 `elicitation` 时，它可与 `onElicitation` 共存。`canPrompt=false` 时仍应避免挂起 native question tools。 |
| 受限 generic dialogs | `createRequestUserInputTool`、`createRequestUserChoiceTool`、`createRequestUserConfirmationTool`、`createRequestUserFormTool`、`PilotDeckUserDialogChannel`、`GatewayUserDialogBus`/`GatewayUserDialogJournal`、SDK `onUserDialog({ dialogKind })`、`client.dialogs.watch/claim/release()`、`createDomBrowserDialogDriver()`（`src/tool/builtin/requestUser*.ts`、`src/tool/dialog/`、`src/gateway/user-dialog/`、`packages/sdk/src/browser-dom-dialog.ts`） | 部分等价 | 仅显式 `supportedDialogKinds` 的 session 注册 `input`、`select`、`confirm`、schema-backed `form` 工具。Gateway 拥有 request id、pending state、类型/select-value/schema 校验、取消、turn-end cleanup 和回包；SDK 只将 callback 结果经 `user_dialog_respond` 回送。manual renderer 可经 `watch()` 接收同 session 的 requested/lease/settled best-effort notification，并通过 `claim()` 原子取得有到期时间的 opaque lease；notification 不持久化、不泄露 token，漏通知或重连后需要 `list()` resync。list 只投影 expiry，lease 存在时仅持有者可回包，release/expiry 后其他 renderer 可接管，原生 cleanup 不受 lease 阻塞。DOM renderer 已为 scalar、object/local `$ref`、`items` array 与固定 `prefixItems` tuple 提供 typed input；无冲突 root/field `allOf` 会合并为 typed form，不含条件/否定约束的 `oneOf`/`anyOf` 提供 branch selector，`patternProperties`、其他 composition 与未知 field 继续回退 JSON。可编译 schema 由 bundled Ajv Draft 2020-12 本地预校验，错误会保留 modal；Gateway 仍是最终 validator。persistent session 会在 request 发出前原子记录 journal；新 Gateway 将遗留记录以 `user_dialog_terminated`/`gateway_restarted` 投影给 `dialogs.list()`。对该 record 的有效 `respond()` 会被 Gateway 按原 contract 重新验证、持久化为 synthetic user context，并返回 `{ delivered: true, recovered: true, reason: "gateway_restarted" }`；下一次新 turn 才会读取该 context。它绝不恢复旧 AgentLoop、turn 或 tool promise。`form` 使用 Gateway-only constraint subset，支持常用 object/array/string/number 规则、schema 型 `additionalProperties`、`email`/`uri`/`uuid`/`date`/`time`/`date-time`，以及带全局深度/节点、每分支 32 条和每个依赖映射 64 条上限的 `allOf`/`anyOf`/`oneOf`/`not`、`if`/`then`/`else`、`dependentRequired`/`dependentSchemas`；拒绝 refs/unknown keyword 或 format；不是 Claude 的任意 dialog 状态机或完整 renderer。 |
| 多主机 durable dialog backend（PilotDeck 专有） | `HttpGatewayUserDialogStore`、`startGatewayUserDialogStoreHttpServer()`、`GatewayUserDialogStore`（`src/gateway/user-dialog/HttpGatewayUserDialogStore.ts`、`src/gateway/user-dialog/GatewayUserDialogStore.ts`） | PilotDeck 专有 | bearer-protected versioned HTTP service 将完整 live store 与 owner heartbeat 交给专用 host/DB store；独立 Gateway 只获得 renderer lease 和 answer handoff，原 Gateway 始终持有并继续自己的 AgentLoop/tool promise。JSON Schema form 的远端 answer 和 owner-expiry terminal recovery 有真实 Gateway E2E；重启后的旧 turn 不会续跑。 |
| Tool annotations/read-only | `PilotDeckToolDefinition`、availability 和 scheduler（`src/tool/protocol/types.ts`、`src/tool/scheduler/`） | 部分等价 | PilotDeck 有 `requiresUserInteraction`、并发安全和 tool kind；不直接复用 Claude 的 MCP annotation 安全判断。 |
| 并发只读工具、写工具串行 | `ConcurrentToolScheduler`、`SequentialToolScheduler`（`src/tool/scheduler/`） | 等价 | 调度与 permission preflight 属于宿主 ToolRuntime。 |
| structured output | SDK `outputFormat` → Gateway session config → `createStructuredOutputTool`、`AgentTurnResult.structuredOutput`（`packages/sdk/src/client.ts`、`src/tool/builtin/structuredOutput.ts`、`src/agent/protocol/result.ts`） | 部分等价 | SDK 支持 PilotDeck JSON-schema 子集与 structured-output 终止条件；不复制 Claude 的 provider-specific JSON mode。 |

## 3. 权限、审批和沙箱

| Claude 能力 | PilotDeck 语义 | 状态 | Ownership |
|---|---|---|---|
| `permissionMode` | `PermissionMode`、Gateway mode、AgentSubmitOptions（`src/permission/index.ts`、`src/agent/protocol/input.ts`、`src/gateway/protocol/`） | 部分等价 | PilotDeck 由宿主保存权限状态和最终 allow/deny；sidecar 不复制策略。 |
| `allowedTools`/`disallowedTools` | `permissionRules`、Tool availability/filter、settings rule set（`src/permission/`、`src/tool/index.ts`） | 部分等价 | Claude 的允许列表是 SDK option；PilotDeck 规则可能来自全局设置、session grant 和宿主上下文。 |
| `canUseTool` | `PermissionRuntime`、`createGatewayPermissionHook`、`permissionDecide`（`src/permission/`、`src/gateway/permission/`、`src/gateway/protocol/`） | 等价 | PilotDeck 支持事件化等待和 Gateway 回答；拒绝必须 fail closed。 |
| MCP permission prompt | SDK `Query.setMcpPermissionModeOverride()` → Gateway permission rules / elicitation（`src/cli/createLocalGateway.ts`、`src/permission/`、`src/gateway/permission/`） | 部分等价 | `default`/`auto` 对指定 `mcp__<server>__*` 工具增加 session-scoped ask；`auto` 返回保守策略 warning。未调用时保持原生 MCP 权限路径；没有 Claude 同名 classifier/prompt-tool 选项。 |
| 文件/网络 sandbox | SDK `sandbox.tool_policy` → Gateway session ToolRegistry filter、Bash/path safety、module `permissionContext`、宿主 sandbox（`packages/sdk/src/client.ts`、`src/cli/createLocalGateway.ts`） | 部分等价 | `filesystem: "read_only"` 移除写入/编辑工具，`filesystem: "deny"` 移除所有 `kind: "filesystem"` 工具；两者都移除可绕过的 host bridge。`network: "deny"`、`process: "deny"` 仍是 Gateway-owned session policy，不等价于 OS/container 级 Claude SandboxSettings，实际环境隔离仍由宿主负责。 |
| bypass permissions | `bypassPermissions` Gateway mode、规则集（`src/gateway/`、`src/permission/`） | 部分等价 | PilotDeck 将最终风险决策留给宿主；不能据此推断任意源码调用都会无审批。 |

## 4. Session、resume、continue、fork 和 transcript

| Claude 能力 | PilotDeck 对应 | 状态 | 差异 |
|---|---|---|---|
| `continue: true` | SDK `query({ options: { continue: true } })`、Gateway `list_sessions`/`resume_session` | 部分等价 | SDK 在当前 project 列表中选择最近 session；权威选择与持久化仍在 Gateway。 |
| `resume: sessionId` | SDK `query({ options: { resume } })`、Transcript replay、Gateway resume | 等价 | PilotDeck session ID 由宿主定义，可能带 channel/project 语义。 |
| `forkSession` | `fork_session` Gateway、`FileHistoryStore`、transcript replay | 部分等价 | Claude fork 是历史分支；PilotDeck 还要协调文件、project storage 和宿主状态。 |
| `listSessions`/message APIs | SDK `listSessions()`/`getSessionMessages()`、Gateway transcript APIs | 等价 | SDK 统一 Gateway 查询；文件/JSONL reader 仍属于内部存储实现。 |
| rename/tag/info | SDK session helpers、Gateway session metadata/title/search | 部分等价 | SDK 提供 rename/tag/info；metadata schema 与 Claude 不同。 |
| SessionStore 跨进程/跨机器 | SDK `FileSessionStore`、Project storage、Gateway/remote、`createGatewayAsyncTranscriptStorageAdapter()` | 部分等价 | `FileSessionStore` 可跨 SDK 进程恢复版本化本地 event mirror，并显式处理导入冲突；Gateway host 还可将 primary/subagent transcript append/read 接到异步结构化 store，供 resume/recreate、model metadata 与消息投影复用；store 可选 `list`/`has`/`delete` 也可接管 Gateway session list/delete，原子 `replace` 可接管 portable archive restore、transcript-only fork 与其递归 sidechain payload copy；`fileHistoryBackups` 迁移 checkpoint backup blob，`toolResultArtifacts.write/read/delete/deleteAll` 迁移大文本和媒体 tool-result payload，并覆盖重启后的本地缓存重建、fork reference 重写/payload copy 与 delete cleanup；同时提供 `prepareReplacement`/`finalizeReplacement` 时可完成 last-turn replacement 的正常 rollback/commit。Gateway 仍不定义 active run 或 in-flight replacement 的跨 Gateway continuation，因此没有跨机器完整 session protocol。 |
| `persistSession=false` | SDK `sdkSessionConfig.persistSession` → Gateway-owned `InMemoryTranscriptWriter` 与临时 artifact root | 部分等价 | SDK 仅允许新 session；Gateway 在 session 创建时决定内存存储，不写 project JSONL，并在 delete/close/idle eviction/shutdown 清理。该 session 不能 resume/fork/list/read transcript，进程崩溃不提供恢复。 |

## 5. Hooks 与生命周期

| Claude Hook | PilotDeck 对应 | 状态 |
|---|---|---|
| `PreToolUse`/`PostToolUse`/failure | SDK `options.hooks` → `HostedHookServer` → Gateway `sdkSessionConfig.hooks` → `HookRuntime`、ToolRuntime audit/events | 部分等价 |
| `UserPromptSubmit` | SDK `options.hooks` → `HostedHookServer` → `TurnRunner` lifecycle hooks | 部分等价 |
| `SessionStart`/`Setup`/`SessionEnd` | `AgentSession.submit()` 中 `LifecycleRuntime.dispatch` | 等价 |
| `Stop`/`StopFailure` | `stop_requested`、`stop_failure`、HookRuntime | 部分等价 |
| `SubagentStart`/`SubagentStop` | `subagent_started/completed/status`、AgentHookExecutor | 等价 |
| `PreCompact`/`PostCompact` | `compact_started/completed`、CompactionEngine hooks | 部分等价 |
| `PermissionRequest`/`Notification` | PermissionRuntime、Hook event bus | 部分等价 |
| TypeScript 专属 `MessageDisplay`、`PostModelSwitch`、`TaskCreated` 等 | 没有逐项公开同名事件 | 缺失 |

`@pilotdeck/sdk` 对原生已发射事件提供 Claude-like callback facade：SDK 进程把 callback 组托管为带 bearer token 的 HTTP endpoint，并把 URL、headers、event/matcher/timeout 作为 `GatewaySessionSdkConfig.hooks` 发送。桥接边界把原生 camelCase hook payload 投影为 Claude 风格 snake_case（`hook_event_name`、`session_id`、`tool_name` 等；嵌套 `tool_input` 不改写）。Gateway 仅将该配置转换为既有 HTTP Hook，`HookRuntime` 仍负责 matcher、effect parsing、block/additional context/permission 等解释，`AgentSession`/Gateway 仍拥有 turn/session 终态。远程 Gateway 必须能访问 endpoint，需以 `hookServer.publicUrl` 指定；`MessageDisplay`、model switch、task 等没有原生发射点的 Claude 事件仍显式不支持。

## 6. Subagents、Skills、Commands、Memory、Plugins

- **Subagents：部分等价。** Claude `AgentDefinition` 可声明 model、tools、MCP、skills、background、memory、maxTurns；PilotDeck 有 `createAgentTool`、`SubAgentSession`、内置 `general-purpose/explore/plan/verify` 定义和 sidechain transcript。SDK 动态定义已支持 Gateway-resolved per-agent `model`，其优先级高于 project subagent default；`mcpServers` 保留 fork-local server map，同时接受 Claude 形状的 `("tickets" | { docs: config })[]`：字符串仅引用当前 SDK session 中启用的 MCP endpoint，Gateway 在创建 native child 前复制 config；未知/禁用引用分别为 `SDK_AGENT_MCP_REFERENCE_NOT_FOUND` / `SDK_AGENT_MCP_REFERENCE_DISABLED`。每个 fork 的 `McpRuntime` 独立连接、只注册到 child ToolRegistry 并在结束时关闭，故 parent 的 toggle/reconnect 不会改写 active child，plugin/config-owned MCP 也没有可引用的 SDK 名称；`background: true` 将该 fork 交给 Gateway-owned task registry，立即返回 task id、在 parent turn 后继续，且只允许 owning session stop；`initialPrompt` 仅在 directive 前添加 child user message，`criticalSystemReminder_EXPERIMENTAL` 仅追加到 child system prompt。observer/observerMessage 和 Claude experimental callback 仍无同等宿主语义。
- **Child text stream：部分等价。** `PilotDeckOptions.forwardSubagentText: true` 经 Gateway session config 开启对既有 `SubAgentSession.forwardActivity()` text delta 的 typed 投影，SDK stream 收到 `subagent.message`，包含 child id/type 与 parent run id。未开启时保持原有 generic `agent_status/subagent_text_delta`，避免破坏已有 Gateway consumers；该观测事件绝不合并进 parent `assistant.message` 或 `result().output`，也不写 parent transcript、更改 child sidechain、权限、调度或 AgentLoop。
- **Skills：部分等价。** SDK `Options.skills: string[] | "all"` 已通过 Gateway 在当前项目目录解析；显式列表只筛选该 session 的 `<available-skills>` prompt 投影和 `read_skill`，未知或歧义名称在创建原生 session 前失败，`"all"`/省略保持原生技能面。AgentDefinition 也支持同一语义的 fork-local `skills`，但它只能缩小父 session 的技能域，`"all"` 继承已经缩小的父域；scoped Agent 使用 custom system prompt 时仍投影其选中技能。PilotDeck `SkillManager`、`readSkill`、Skill migration 和 context instruction discovery 仍拥有加载/读取；这不等价于 Claude `.claude` 自动加载或 plugin 配置。
- **Commands/memory：部分等价。** PilotDeck 有 PromptAssembler、InstructionDiscovery、MemoryResolver 和 project settings。AgentDefinition 的 `memory: "disabled"` 让 child-only ContextRuntime 不安装 `MemoryResolver`，因此该 fork 不检索也不捕获 memory，不影响父 session；`inherit` 保持原生 resolver。Claude 的 command/memory 从 `.claude/` setting sources 自动加载，约定不同。
- **Plugins：部分等价。** `Options.plugins` 已接受 `type: "local"` 的 absolute Gateway-local directory，并在 Gateway 配置阶段加载为 session-only `PluginRuntime.createView()`。命令、技能、hooks、output style 和 plugin MCP 都只投影给 owning session；MCP runtime 随 session 清理，project registry 和其他 session 不被修改。远程调用者必须传 Gateway host 可见路径；`pluginDelivery: "argv"` 没有 Gateway process 等价。

## 7. MCP 与自定义工具

| Claude | PilotDeck | 状态 |
|---|---|---|
| stdio/SSE/HTTP/SDK MCP server | SDK `mcpServers`/`Query.setMcpServers()`/`client.mcp.setServers()`、`client.mcp.status()`/`.reconnect()`/`.toggle()`、`McpClient`、stdio/streamable HTTP transport、`McpRuntime` | 部分等价 |
| `tool()` + `createSdkMcpServer()` | `createMcpTool`、`ToolRegistry`、MCP bridge | 部分等价 |
| MCP resources | `createListMcpResourcesTool`、`createReadMcpResourceTool` | 等价 |
| MCP OAuth/elicitation | Gateway/MCP status 与 PilotDeck elicitation | 部分等价 |
| deferred tool search / `alwaysLoad` | `createSdkMcpServer({ alwaysLoad: false })`、`tool(..., { alwaysLoad: false, searchHint })`、Gateway `search_tools` | 部分等价 |

PilotDeck 的 MCP tool 结果要先进入 `PilotDeckToolResult`，再由 AgentLoop projection 回填；Claude SDK 的 custom tool handler 直接返回 MCP `CallToolResult`。两者可互操作，但不能把返回值类型视为相同。

## 8. Compaction、checkpoint、structured output、usage、错误

- **Compaction：部分等价。** PilotDeck 有 `CompactionEngine`、`AutoCompactionPolicy`、`MicroCompactionEngine`、`SnipEngine` 和 compact events；Claude 有 compact boundary、预算/turn 触发和 SDK control API。PilotDeck 的 context budget 和宿主 persistence 仍由宿主拥有。
- **File checkpoint/rewind：部分等价。** PilotDeck 有 `FileHistoryStore`、`createBackup`、`restoreBackup` 和 `FileArtifactCollector`；SDK 已通过 Gateway `rewind_files` 提供同名 `Query.rewindFiles()` façade、dry-run 和空闲态保护。snapshot 与 post-edit fingerprint 写入 JSONL transcript，Gateway 重启后会惰性恢复索引；外部修改返回 `conflicts` 并拒绝覆盖，缺失 backup 不改变 workspace，restore 使用原子 rename。Bash 变更仍遵循 PilotDeck 自己的记录规则。
- **Usage/cost：部分等价。** `CanonicalUsage`、Router stats、`AgentTurnResult.usage` 与 Gateway `usage_snapshot` 提供 session/project aggregate；SDK `Query.modelUsage()` 通过独立 `model_usage_snapshot` 读取 Gateway-owned provider/model 请求数、输入/输出/缓存 token、成本以及 main/subagent 维度，并随 Router stats JSONL 重建。Gateway-owned per-turn `maxBudgetUsd` 在一次模型调用完成后、任何恢复或工具副作用之前终止；experimental `taskBudget.total` 的 durable ledger 还提供 session 或 project shared ceiling，并可跨 Gateway restart 恢复。它仍不同于 Claude 的统一 `total_cost_usd` 计费模型，且尚无无限期留存或成本精度承诺。
- **Output style：部分等价。** SDK `outputStyles()`、`setOutputStyle()`、`reloadOutputStyles()` 对应 Gateway output-style registry；活动 session 拒绝切换，更新内容在下一次 runtime 构造时注入 system prompt。真实 project plugin load、reload 后 style namespace 稳定及无关 command registry 隔离均已验证；它仍是 PilotDeck 专有控制面。
- **Context usage：部分等价。** `Query.getContextUsage({ detail: "summary" | "full" })` 读取 Gateway `context_budget` 的原生 `TokenBudgetSnapshot`，包括使用量、窗口、输出预留、估算来源、校准信息和 warning/blocking 状态。`full` 还返回 Gateway `TokenAccountingRuntime` 对实际 prepared request 的 additive local-tokenizer `system/tools/messages/MCP/memory` 分类；provider exact 总量不被拆造。`summary` 和旧 Gateway 明确返回 `breakdownAvailable: false`。
- **错误和终态：部分等价。** Claude 用 `error_max_turns`、`error_max_budget_usd` 等 result subtype；PilotDeck 用 `AgentErrorCode`、`AgentStopReason`、`turn_failed`、`AgentTurnResult.type`。映射时必须保留错误码，不能把拒绝、取消、未知结果改写为成功。

## 9. 源码证据索引与所有权

为避免把相似名称误当成兼容 API，表中未展开路径的条目按以下基线索引核验：

| 语义族 | PilotDeck 证据路径与导出 | 状态所有权 |
|---|---|---|
| Session / resume / fork / transcript | `src/session/index.ts`：`resumeAgentSession`、`readTranscript`、`readAgentProjectSessionTranscript`、`replayTranscriptEntries`；`src/session/storage/`；`src/session/transcript/`；`src/gateway/storage/AsyncTranscriptStorageAdapter.ts`；`src/gateway/`：`resume_session`、`fork_session` | session、transcript、project storage 由宿主数据平面拥有；AgentLoop 只消费 replay/写入端口。异步 adapter 当前覆盖 primary transcript append/read、可选 list/delete、portable archive restore、transcript-only fork 及其递归 sidechain payload copy、`fileHistoryBackups` checkpoint backup，以及 `toolResultArtifacts` 的大文本/媒体 payload 写入、重启缓存重建、fork copy/reference rewrite 和 delete cleanup；在 store 提供 `prepareReplacement`/`finalizeReplacement` 时还覆盖 last-turn replacement rollback/commit。active run 和 in-flight external transaction recovery 仍未定义。 |
| Hooks / lifecycle | `src/extension/index.ts`：`HookRuntime`、executors、`AsyncHookRegistry`；`src/extension/hooks/protocol/`；`src/agent/` 生命周期事件 | hook 执行可由扩展贡献，但 turn/session 最终状态由 AgentSession/Gateway 拥有 |
| Subagents | `src/tool/builtin/agent.ts`：`AgentSubagentDefinition`、`BUILTIN_SUBAGENTS`、`createAgentTool`；`src/agent/sub/`：`SubAgentSession` | 子 Agent 的 sidechain transcript、调度和 parent linkage 由 PilotDeck 宿主拥有 |
| Skills / commands / memory / plugins | `packages/sdk/src/types.ts`：`PilotDeckOptions.skills`/`.plugins`；`packages/sdk/src/client.ts`：`sdkSessionConfig()`；`src/gateway/protocol/types.ts`：`GatewaySessionSdkConfig.skills`/`.plugins`；`src/cli/createLocalGateway.ts`：Gateway resolution/session projection；`src/extension/index.ts`：`SkillManager`、`PluginRuntime`、`PluginRuntimeView`、`PluginRegistry`；`src/context/`：`PromptAssembler`、`InstructionDiscovery`、`MemoryResolver` | `Options.skills` 是 Gateway-owned session skill visibility；`Options.plugins` 是 Gateway-local session plugin contribution view。二者都不把 lifecycle 交给 SDK 客户端：加载、registry、MCP/Hook executor、资源清理仍由 Gateway/extension runtime 拥有 |
| MCP / custom tools | `src/mcp/index.ts`：`McpClient`、`McpRuntime`、`createMcpToolDefinitionsFromRuntime`；`src/tool/index.ts`：`ToolRegistry`、`createMcpTool` | MCP transport、tool result projection、permission preflight 由 ToolRuntime/McpRuntime 拥有 |
| Compaction / checkpoint / usage / error | `src/context/index.ts`：`CompactionEngine`、`AutoCompactionPolicy`、`TokenBudgetManager`；`src/session/index.ts`：`FileHistoryStore`、`createBackup`、`restoreBackup`；`packages/sdk/src/client.ts`：Query context/usage/rewind façade；`src/agent/protocol/result.ts`：`AgentTurnResult`、`AgentStopReason`、`AgentErrorCode` | context budget、文件快照、usage 与错误码分别由 context/session/agent 协议层拥有；SDK 只提供有明确 wire contract 的 façade |

因此，“等价”只表示可完成同类任务；不表示类型、事件名称、持久化格式或跨进程兼容性相同。`src/` 下的导出属于本次提交快照的内部源码 API，Gateway 和 module/sidecar 协议另行受其 wire schema 约束。
