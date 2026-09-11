# Claude Agent SDK TypeScript API 全量清单

## 版本和记录方式

基线为调研时官方 npm `@anthropic-ai/claude-agent-sdk@0.3.263` 的 TypeScript 文档。官方 API 页面把很多类型集中在一个 reference 中；本清单按公开导出面分组，组合重复的工具 input/output 类型，但不省略公开能力族。

证据：[`typescript.md`](https://code.claude.com/docs/en/agent-sdk/typescript.md)、[`overview.md`](https://code.claude.com/docs/en/agent-sdk/overview.md)。PilotDeck 路径均相对于本 worktree 根目录。

## 函数与主对象

| Claude API | 签名/语义 | PilotDeck 对应项 | 层级 |
|---|---|---|---|
| `query()` | `query({prompt, options?}): Query`；返回可异步迭代的消息流，驱动完整 Agent Loop；prompt 可为字符串或 `AsyncIterable<SDKUserMessage>` | `AgentSession.submit()`、`TurnRunner.run()`、`AgentLoop.run()` | 源码 API；无统一 `query()` façade |
| `Query` | AsyncGenerator 扩展对象；提供中断、上下文读取、文件读取/恢复等控制方法（以当前 API 类型为准） | `AgentSession.abort()`、`steer()`、`snapshot()`、Gateway stream | 部分等价 |
| `startup()` | 启动 Claude Code SDK 进程/会话并返回启动信息 | `createAgentSession()`、`createLocalGateway()` | 部分等价 |
| `tool()` | 使用 Zod shape 创建类型安全的 SDK MCP tool 定义 | `PilotDeckToolDefinition`、`ToolRegistry`、`createMcpTool()` | 部分等价 |
| `createSdkMcpServer()` | 在 SDK 进程内组合自定义 MCP 工具 | `McpRuntime`、`McpClient`、`createMcpToolDefinitionsFromRuntime()` | 部分等价 |
| `listSessions()` / `getSessionMessages()` | 枚举并读取 SDK transcript | `listAllSessions()`、`readTranscript()`、`buildConversationChain()` | 部分等价 |
| `getSessionInfo()` / `renameSession()` / `tagSession()` | 查询和更新会话元数据 | `SessionInfo`、`SessionMetadataStore`、标题生成器；没有同名 tag façade | 部分等价 |
| `resolveSettings()` | 解析 SDK setting sources | SDK `resolveSettings()`、Gateway `resolve_settings`、`PilotConfigStore.getSnapshot()` | 部分等价：返回 Gateway 宿主的已脱敏 config/source/diagnostic snapshot，不复制 Claude 全 source contract |
| `deleteSession()` / `forkSession()` | 删除或复制一个持久化会话；`forkSession()` 返回新 session id | SDK `deleteSession()`/`forkSession()`；Gateway `delete_session`/`fork_session` | 等价；fork 的文件状态仍遵循 PilotDeck 原生语义 |
| `getSubagentMessages()` / `listSubagents()` | 按 session 读取子 Agent transcript，或列出子 Agent id | `readSubagentMessages`、SubAgent transcript、Gateway subagent message 查询 | 部分等价 |
| `importSessionToStore()` / `InMemorySessionStore` | 把 JSONL 会话导入自定义 `SessionStore`，或使用内存实现 | `JsonlTranscriptWriter`、`InMemoryTranscriptWriter`、project storage | 部分等价 |
| `filterEscalatingDefaultMode()` / `foldSessionSummary()` | settings 解析辅助函数和 session summary 折叠函数 | SDK `filterEscalatingDefaultMode()`（对 PilotDeck snapshot 做纯深拷贝）与 `foldSessionSummary()` | 部分等价 |
| `ClaudeSDKClient`（Python 专属） | 不属于本次 TypeScript 全量范围 | 不审计 | 不适用 |

### SessionStore 与公开辅助类型

TypeScript 包还公开 `SessionStore`、`SessionStoreEntry`、`SessionKey`、`SDKSessionInfo`、`SessionMessage`、`SessionMutationOptions`、`ListSessionsOptions`、`GetSessionMessagesOptions`、`GetSessionInfoOptions`、`ForkSessionOptions`、`ImportSessionToStoreOptions`、`ListSubagentsOptions`、`GetSubagentMessagesOptions` 等会话类型。它们共同定义目录搜索、项目目录、分页/过滤、fork 和导入的参数面；不能只用 `query()` 的 `resume` 选项替代。

## `Options` 配置族

| 配置族 | 公开字段/语义 | PilotDeck 证据 |
|---|---|---|
| 运行位置 | `cwd`、`additionalDirectories`、`pathToClaudeCodeExecutable`、`env`、`debug`、`debugFile`、`loadTimeoutMs` | `AgentSessionOptions.cwd`、Gateway `workspaceCwd`、工具路径安全；没有 Claude CLI executable 等价项 |
| 模型与推理 | `model`、`effort`、`thinking`、`betas` | `AgentModelOverride`、`CanonicalThinkingConfig`、Router model runtime |
| 回合限制 | `maxTurns`、`maxBudgetUsd` | `AgentSubmitOptions.maxTurns`、`AgentTurnResult.usage`、SDK/Gateway `maxBudgetUsd` 与 experimental `taskBudget.total`；预算 ownership 在 Gateway，`taskBudget` 支持 session/project scope，不是 Claude 的统一计费字段 |
| 权限 | `permissionMode`、`allowedTools`、`disallowedTools`、`canUseTool`、`permissionPrompts`、`allowDangerouslySkipPermissions` | `PermissionMode`、`PermissionRuntime`、`permissionRules`、`canPrompt`、Gateway permission bus |
| 会话 | `continue`、`resume`、`forkSession`、`resumeSessionAt`、`resumeSessionAt` 相关选项、`persistSession`、`sessionStore` | `AgentSession`、`resumeAgentSession`、Transcript replay、Gateway `resume_session`/`fork_session` |
| 工具/扩展 | `tools`、`mcpServers`、`agents`、`plugins`、`skills`、`settingSources` | `ToolRegistry`、MCP runtime、SubAgentSession、PluginRuntime、SkillManager |
| 提示词/输出 | `systemPrompt`、`appendSystemPrompt`、`outputFormat`、`planModeInstructions`、`settings` | `PromptAssembler`、context runtime、`structuredOutput` tool、`runMode` |
| 流与生命周期 | `includePartialMessages`、`includeHookEvents`、`forwardSubagentText`、`abortController`、`hooks`、`onElicitation` | `AgentEvent` stream、Gateway `subagent_text_delta`/SDK `subagent.message` opt-in projection、HookRuntime、ElicitationChannel、AbortController |
| 沙箱/网络 | `sandbox`、`permissionMode`、网络和文件系统设置 | 工具 path safety、Bash permissions、Gateway/sidecar sandbox profile；没有同名 Options 对象 |

## 消息和结果类型

| Claude 类型 | 语义 | PilotDeck 对应 |
|---|---|---|
| `SDKMessage` | 所有流消息联合 | `AgentEvent` 联合 |
| `SDKSystemMessage` | init、compact、informational、worker shutdown 等系统事件 | `session_started`、`setup_completed`、`compact_started/completed`、`warning`、`session_ended` |
| `SDKAssistantMessage` | 文本、thinking、tool use 的 assistant 消息 | `assistant_message`、`model_event`、`CanonicalMessage` |
| `SDKUserMessage` / `SDKUserMessageReplay` | 用户输入、工具结果回填、注入或重放消息 | `input_accepted`、`tool_result`、`tool_results_projected`、`syntheticMessages` |
| `SDKPartialAssistantMessage` | 原始流式增量 | `model_event` 的 canonical stream；字段不一一相同 |
| `SDKResultMessage` | success 或 error subtype，含 `result`、`session_id`、turn 数、usage、cost、permission denials、structured output | `turn_completed` + `AgentTurnResult` / `turn_failed`；没有同形状累计美元 cost |
| `SDKCompactBoundaryMessage` | 上下文压缩边界 | `compact_started` / `compact_completed` |
| `SDKHookStarted/Progress/ResponseMessage` | Hook 生命周期输出 | `HookExecutionEventBus`、HookRuntime；Gateway 映射不完全统一 |
| `SDKTask*` / `SDKBackgroundTasksChangedMessage` | 子 Agent/后台任务通知 | `subagent_*` 事件、Task tools |
| `SDKPermissionDeniedMessage` | 工具权限拒绝 | `permission_denied`、`AgentPermissionDenial` |
| `SDKRateLimitEvent` / `SDKThinkingTokensMessage` 等 | 观测和模型状态事件 | `usage`、`retry_progress`、`model_event`；没有完整同名联合 |

控制面也属于公开消息契约：`SDKControlRequest`/`SDKControlResponse`、`SDKControlInitializeResponse`、`SDKControlInterruptResponse`、`SDKControlGetContextUsageResponse`、`SDKControlGetUsageResponse`、`SDKControlReadFileResponse`、`SDKControlReloadPluginsResponse`、`SDKControlReloadSkillsResponse` 等由 `Query` 方法触发，用于中断、上下文/usage 查询、文件读取、插件/技能刷新和动态 MCP 配置。PilotDeck 的近似能力分布在 `AgentSession`、Gateway request/response 和 `AgentEvent`，没有同一组 control message 名称。

## Hook 类型

公开 Hook 事件包括 `PreToolUse`、`PostToolUse`、`PostToolUseFailure`、`PostToolBatch`、`UserPromptSubmit`、`UserPromptExpansion`、`MessageDisplay`、`Stop`、`StopFailure`、`SubagentStart`、`SubagentStop`、`PreCompact`、`PostCompact`、`PreModelSwitch`、`PostModelSwitch`、`PermissionRequest`、`PermissionDenied`、`SessionStart`、`SessionEnd`、`Notification`、`Setup`、`TeammateIdle`、`TaskCreated`、`TaskCompleted`、`Elicitation`、`ElicitationResult`、`ConfigChange`、`InstructionsLoaded`、`DirectoryAdded`、`WorktreeCreate`、`WorktreeRemove`、`CwdChanged`、`FileChanged`、`MessageDisplay` 等。

类型族为 `HookEvent`、`HookCallback`、`HookCallbackMatcher`、`HookInput`、`BaseHookInput`、各事件专属 input，以及同步/异步 `HookJSONOutput`。PilotDeck 的对应类型和执行器在 `src/extension/index.ts` 导出，事件集合在 `src/extension/hooks/protocol/events.ts`；PilotDeck 的实际事件集合以源码常量为准，不应把 Claude 专属事件名称直接当成兼容保证。

## 工具、Agent、MCP、权限和沙箱类型

- 工具输入/输出（`sdk-tools.d.ts`）：基础工具为 `Agent`、`AskUserQuestion`、`Bash`、`Monitor`、`Edit`、`Read`、`Write`、`Glob`、`Grep`、`NotebookEdit`、`WebFetch`、`WebSearch`、`TodoWrite`、`TaskCreate`、`TaskUpdate`、`TaskGet`、`TaskList`、`TaskOutput`、`TaskStop`、`ExitPlanMode`、`EnterPlanMode`、`ListMcpResources`、`ReadMcpResource`、`ReadMcpResourceDir`、`RefreshMcpTools`、`Mcp`、`ReportFindings`、`Artifact`、`Projects`、`SendFeedback`、`ClaudeDesign`、`REPL`、`Workflow`、`CronCreate`、`CronDelete`、`CronList`、`ScheduleWakeup`、`RemoteTrigger`、`ShowOnboardingRolePicker`、`ReadNotifications`、`ProposeSkills`、`ProposeGoal`、`PushNotification`、`EnterWorktree`、`ExitWorktree`。对应的 `*Input`/`*Output` 接口以及 `ToolInputSchemas`、`ToolOutputSchemas`、`AgentOutput`、`McpOutput`、`ArtifactOutput`、`ProjectsOutput` 均为公开类型；本基线只对与 PilotDeck AgentLoop 相关的工具做逐项映射。
- Agent 编排：`AgentDefinition`（description、tools、disallowedTools、prompt、model、mcpServers、skills、initialPrompt、maxTurns、background、memory、effort、permissionMode）。PilotDeck 对应 `AgentSubagentDefinition`、`SubAgentSession`、`BUILTIN_SUBAGENTS`。
- MCP：`McpStdioServerConfig`、`McpSSEServerConfig`、`McpHttpServerConfig`、`McpSdkServerConfigWithInstance`、`McpClaudeAIProxyServerConfig`、`AgentMcpServerSpec`、`SdkMcpToolDefinition`。PilotDeck 由 `McpClient`、`McpRuntime`、MCP config loader 和 `createMcpTool()` 覆盖。
- 权限：`PermissionMode`、`CanUseTool`、`PermissionResult`、`PermissionUpdate`、`ToolPermissionContext`。PilotDeck 由 `PermissionContext`、`PermissionRuntime`、`PermissionRuleSet`、Gateway permission bus 覆盖。
- 沙箱：`SandboxSettings`、`SandboxNetworkConfig`、`SandboxIgnoreViolations`。PilotDeck 有工具级路径和 Bash 权限、module profile 与宿主 sandbox 约定；没有同名、跨所有工具统一的 SDK 设置类型。
- 扩展：`SdkPluginConfig`、`SettingSource`、`SdkBeta`、`ThinkingConfig`、`OutputFormat`、`Query`、`WarmQuery`、`AbortError`。PilotDeck 分散在 PluginRuntime、context、AgentInput/Result 和错误协议中。

公开的支撑类型还包括 `AccountInfo`、`AgentInfo`、`ModelInfo`、`ModelUsage`、`NonNullableUsage`、`SDKContextUsage`、`SDKContextUsageCategory`、`TerminalReason`、`SpawnOptions`、`SpawnedProcess`、`Transport`、`SessionCronSummary`、`BackgroundTaskSummary`、`SlashCommand`、`UserDialogRequest`/`UserDialogResult`、`ElicitationRequest`/`ElicitationResult`、`ThinkingAdaptive`/`ThinkingEnabled`/`ThinkingDisabled`、`FastModeState`/`FastModeDisabledReason`、`ApiKeySource`、`ConfigScope`、`SettingSource`、`Settings` 和 `ResolvedSettings`。这些类型用于启动、传输、模型目录、后台任务、交互和 settings 解析，不能只归入消息联合。

## 结果与版本注意事项

Claude 的 `ResultMessage.total_cost_usd` 是客户端估算值，`modelUsage` 统计主 Agent、Subagent 和内部调用；PilotDeck 的 `CanonicalUsage` 和 Router stats 不应直接解释为同一计费模型。Claude SDK 的 V2 session API 已从 TypeScript 0.3.142 移除，当前以 `query()` 和 session options 为准。
