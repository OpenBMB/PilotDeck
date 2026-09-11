# PilotDeck SDK 与原生模块：简单说明

## 一句话说明

- **PilotDeck SDK** 给应用开发者使用：连接 PilotDeck、创建会话、发起任务、接收事件、处理审批和读取结果。
- **PilotDeck 原生模块** 在 PilotDeck 内部运行：调用模型、执行工具、管理上下文、处理权限、保存会话并驱动 Agent Loop。

可以简单理解为：

```text
人类应用
   |
   | 使用 SDK
   v
PilotDeck Gateway
   |
   | 调用原生模块
   v
Agent Loop / Model / Tools / Context / Permission / Session
```

SDK 是面向外部应用的操作入口；原生模块是 PilotDeck 的执行引擎。

## SDK 包含哪些功能

SDK 应提供应用接入 PilotDeck 所需的高层接口。

### 1. 连接 PilotDeck

- 连接本地或远程 Gateway；
- 认证；
- 协议版本和能力协商；
- 超时、断线、重连和关闭连接。

### 2. 管理会话

- 创建 session；
- 查询 session；
- 恢复、继续和 fork session；
- 关闭 session；
- 读取 transcript 和子 Agent 消息。

### 3. 发起和控制任务

- 提交用户输入；
- 接收流式输出；
- 获取最终结果；
- steer 正在执行的任务；
- cancel 或 abort；
- 查询 usage、错误、文件和 artifacts。

### 4. 处理事件

SDK 把 Gateway 或内部事件整理成稳定的公共事件，例如：

- assistant 输出；
- 模型流式增量；
- 工具开始、进度、完成和失败；
- permission 请求和结果；
- 用户问答请求；
- compaction；
- subagent 状态；
- turn 完成或失败。

应用不需要直接解析 WebSocket frame、JSONL transcript 或内部 `AgentEvent`。

### 5. 处理人工审批

- 收到工具权限请求；
- 展示审批界面；
- 返回 allow 或 deny；
- 响应 AskUserQuestion 等用户交互；
- 区分单次授权和 session 级授权。

SDK 负责传递决定，但不负责制定最终权限策略。

### 6. 访问其他 Gateway 能力

- 项目和文件查询；
- 模型目录；
- commands；
- skills；
- MCP 配置和状态；
- config reload；
- PilotDeck 产品需要时的 cron、always-on 等操作。

### 7. 提供稳定的开发体验

- TypeScript 类型；
- 统一错误类型；
- `AbortSignal` 和超时支持；
- 向后兼容；
- 示例和文档；
- npm 包和稳定 exports。

## 原生模块包含哪些功能

原生模块是 PilotDeck 内部的运行能力，不应该全部直接暴露给 SDK 用户。

### 1. Agent Loop

负责完整的 Agent 执行循环：

```text
准备上下文
  -> 调用模型
  -> 解析模型输出
  -> 执行工具
  -> 回填工具结果
  -> 判断继续或结束
```

主要内部实现包括 `AgentLoop`、`TurnRunner` 和 `AgentSession`。

### 2. Model 模块

- 调用不同模型供应商；
- 把供应商消息转换为 canonical message/event；
- 流式输出；
- thinking、usage、retry 和模型错误处理；
- 模型选择和路由。

SDK 只传入模型选择并读取事件，不直接实现模型调用。

### 3. Tool 模块

- Read、Write、Edit、Glob、Grep；
- Bash、Notebook、代码执行；
- WebFetch、WebSearch；
- plan、todo、task、AskUserQuestion；
- structured output；
- MCP tools 和 resources；
- 工具校验、并发调度、超时、审计和结果投影。

工具真正产生的文件、命令和网络副作用由原生 ToolRuntime 管理。

### 4. Context 模块

- 组装 system prompt；
- 加载项目指令、memory 和 attachments；
- 管理 token budget；
- compaction 和 recovery；
- 控制模型实际可见的上下文。

SDK 可以传入用户输入和部分配置，但不负责拼装最终模型上下文。

### 5. Permission 模块

- 计算工具是否允许执行；
- 应用 permission mode 和规则；
- 发起人工审批；
- 管理 session grant；
- 在没有有效决定时拒绝执行。

SDK 只是审批交互通道，最终 permission 状态由 PilotDeck 宿主持有。

### 6. Session 与持久化模块

- transcript 写入和读取；
- session metadata；
- resume 和 replay；
- file history 和 backup；
- checkpoint、projection 和 artifacts；
- subagent transcript。

SDK 调用 session API，但不维护第二套权威 session 数据。

### 7. Hooks、Skills 和 Plugins

- 执行生命周期 Hooks；
- 发现和加载 Skills；
- 加载 Plugin manifest 和 contributions；
- 把扩展能力接入 context、tools 和 lifecycle。

SDK 可以提供配置入口和状态查询，不直接执行所有内部扩展逻辑。

### 8. MCP 模块

- 启动和连接 MCP server；
- 管理 stdio/HTTP transport；
- 获取 MCP tools 和 resources；
- 把 MCP tool 转换为 PilotDeck tool；
- 管理 MCP 状态、错误和调用生命周期。

SDK 负责配置和观察；原生 MCP runtime 负责真实连接和执行。

### 9. Gateway 与 Module/Sidecar

- Gateway 负责把外部请求路由到正确 session 和 runtime；
- WebSocket 协议负责 request、response 和 event 传输；
- module/sidecar protocol 支持跨进程或跨语言模块；
- 宿主持有 session、turn、run、operation 和最终结果。

Gateway 是 SDK 与原生模块之间的公共服务边界。

## 功能对照表

| 功能 | SDK | 原生模块 |
|---|---|---|
| 连接和认证 | 提供客户端 API | Gateway 校验和管理连接 |
| 创建 session | 发起请求并返回对象 | 创建、存储和恢复真实 session |
| 提交任务 | 提供 `runs.start()` | Agent Loop 执行任务 |
| 流式输出 | 提供 async iterable | 生成模型、工具和生命周期事件 |
| 模型调用 | 选择模型、读取结果 | 真实调用、路由、retry 和 usage |
| 工具执行 | 展示事件和审批 | 校验、调度并执行工具 |
| 权限 | 展示请求、提交决定 | 应用规则并作最终裁决 |
| transcript | 查询和分页 | 写入、持久化、replay 和恢复 |
| compaction | 展示状态 | 计算和执行上下文压缩 |
| checkpoint | 请求恢复、读取结果 | 保存和恢复文件/会话状态 |
| MCP | 配置、启停和查看状态 | 连接 server、发现并执行工具 |
| Hooks/Skills/Plugins | 配置和查询 | 加载并执行扩展逻辑 |
| 断线恢复 | 重连并查询状态 | 保存权威状态并返回恢复结果 |
| 错误 | 提供统一错误对象 | 产生真实业务和运行错误 |

## Claude Agent SDK 全量能力域对照

前面的概览只列出了最常见的调用。下面按 Claude Agent SDK TypeScript 0.3.263 的完整公开能力族，说明每一类在 PilotDeck 中应该由哪一层负责。

### 顶层函数

| Claude 函数 | Claude 提供的能力 | PilotDeck 原生入口 | 未来 SDK 形态 |
|---|---|---|---|
| query | 启动完整 Agent Loop，返回可异步迭代消息流 | AgentSession.submit、TurnRunner、AgentLoop、Gateway.submitTurn | client.runs.start + run.events/result |
| startup | 预热 CLI 子进程，返回 WarmQuery | createAgentSession、createGateway、startGatewayServer、createRemoteGateway | client.connect/describeServer |
| tool | 用 schema 和 handler 定义自定义 MCP 工具 | PilotDeckToolDefinition、ToolRegistry、createMcpTool | `tool()` + `createPilotDeckMcpServer()`；Embedded 模式再提供 tools.register |
| createSdkMcpServer | 在 SDK 进程内组合 MCP 工具 | McpClient、McpRuntime、PluginToToolBridge | `createSdkMcpServer()` / `createPilotDeckMcpServer()` |
| listSessions | 列出 session | listAllSessions、listProjectSessions、Gateway.listSessions | sessions.list |
| getSessionMessages | 查询 transcript 消息 | readTranscript、buildConversationChain、Gateway.readSessionMessages | sessions.messages |
| getSessionInfo | 查询 session 元数据 | readSessionInfo、SessionInfo、Gateway session info | sessions.get |
| getSubagentMessages/listSubagents | 查询子 Agent transcript 和 id | replaySubagentTranscript、SubAgentSession、Gateway.readSubagentMessages | sessions.subagents |
| renameSession | 修改标题 | SessionMetadataStore、SessionTitleGenerator | sessions.rename |
| tagSession | 设置/清除标签 | SessionMetadataStore、Gateway session metadata | SDK `tagSession()`；metadata 仍由 Gateway/宿主持久化 |
| deleteSession | 删除持久化 session | SDK 专属 Gateway `delete_session` adapter 删除 transcript 与 session sidecars；`closeSession` 仍只关闭运行时 | `sessions.delete`，明确区分 close 与 delete |
| forkSession | 创建历史分支 | Gateway.forkSession、transcript replay、FileHistoryStore | sessions.fork，声明复制范围 |
| importSessionToStore | 导入自定义 SessionStore | JsonlTranscriptWriter、InMemoryTranscriptWriter、project storage | 后续 sessions.import |
| resolveSettings | 合并 settings 并返回 provenance | ExtensionResolver、ContextRuntime、PluginRuntime | settings.resolve |

### Query 控制方法

Claude Query 既是 AsyncGenerator，又提供 interrupt、setPermissionMode、setMcpPermissionModeOverride、setModel、setMaxThinkingTokens、applyFlagSettings、updateSettings、initializationResult、reinitialize、supportedCommands、supportedModels、supportedAgents、mcpServerStatus、getContextUsage、usage、readFile、reloadPlugins、reloadSkills、outputStyles、setOutputStyle、reloadOutputStyles、accountInfo、rewindFiles、seedReadState、reconnectMcpServer、toggleMcpServer、setMcpServers、streamInput、stopTask、backgroundTasks、close 等控制方法。

PilotDeck 的原则是按层拆开：

| Claude 控制面 | PilotDeck 原生模块 | SDK 对外建议 |
|---|---|---|
| interrupt | AgentSession.abort、Gateway.abortTurn | run.abort |
| 动态 permission mode | PermissionRuntime、Gateway.permissionDecide | permissions.setMode 或下一次 run option |
| updateSettings(localSettings) | Gateway `update_settings`、`updatePilotLocalSettings`、PilotConfigStore | SDK 可持久化 allowlist 的非 secret runtime settings；Gateway 先校验候选 YAML 并原子写入自身 `$PILOT_HOME`，原生 reload 决定生效时机 |
| setModel | Gateway.sessionModelSet/sessionModelClear | sessions.model.set/clear |
| initialization/reinitialize | Gateway hello、describeServer、capabilities | client.connect/reconnect/describeServer |
| supportedCommands/Models | Gateway.commandsList/modelCatalogList | commands.list、models.list |
| getContextUsage/usage/modelUsage | TokenBudgetManager、AgentTurnResult.usage、Router stats、Gateway `usage_snapshot`/`model_usage_snapshot` | `Query.getContextUsage()` / `Query.usage()` / `Query.modelUsage()`；aggregate 由 Gateway 持有 |
| readFile | files API、Read tool | files.read |
| reloadPlugins/reloadSkills | PluginRuntime、SkillManager、reloadExtensions | extensions.reload、skills.reload |
| outputStyles/setOutputStyle/reloadOutputStyles | PluginRuntime output-style registry、Gateway output-style controls | `Query.outputStyles()` / `setOutputStyle()` / `reloadOutputStyles()`；活动 session 拒绝切换，下一次 runtime 构造生效 |
| rewindFiles | Gateway `rewind_files` 调用 FileHistoryStore、createBackup、restoreBackup，并从 transcript replay snapshot 索引 | SDK 已提供 Query 同形状 façade；跨 Gateway 重启 E2E、backup 缺失和外部冲突均已验证，后续只保持 retention/GC 与 legacy snapshot 回归 |
| seedReadState | Gateway `seed_read_state`、SessionRouter、AgentSession/TurnRunner、AgentLoop `readFileState` + writeSnapshots | `Query.seedReadState(path, mtime)`；仅空闲 session，Gateway 重新检查路径和 mtime；不匹配时不写入状态，后续 Edit 仍需 fresh Read |
| setMcpServers/reconnect/toggle | McpClient、McpRuntime、配置加载器 | `Query.setMcpServers()` / `reconnectMcpServer()` / `toggleMcpServer()` |
| streamInput | AgentSession.submit、Gateway.submitTurn、steer mailbox | `Query.streamInput()` 逐条映射 `steer_turn`，仅活动 turn 可用 |
| stopTask/backgroundTasks | `background_task_stop` / `background_tasks`、`BackgroundTaskRuntime`、`BackgroundSubagentRuntime`、Gateway 状态 | `stopTask` 可停止 owning session 的 Bash 或 AgentDefinition.background child；`backgroundTasks` 对后者返回 active task id，对 Bash 保持无 foreground 转换结果；不以 `client.cron` 替代。Claude 的接口管理活动 Bash/subagent task，PilotDeck cron 管理持久化定时任务 |
| close | transport、session、Gateway 三个层级 | client.close、sessions.close 分开 |

PilotDeck SDK 另外暴露 `client.cron.create/list/update/delete/stop/runNow`。这是对原生 `cron_*` Gateway 协议的资源客户端，属于 PilotDeck 专有产品编排能力，不是 Claude Query 的后台任务控制接口，也不应被用于宣称 Claude SDK 兼容。

### Options 配置域

Claude Options 覆盖 cwd、additionalDirectories、env、debug、model、effort、thinking、betas、maxTurns、maxBudgetUsd、permissionMode、allowedTools、disallowedTools、canUseTool、continue、resume、forkSession、persistSession、sessionStore、tools、mcpServers、agents、plugins、skills、settingSources、systemPrompt、appendSystemPrompt、outputFormat、planModeInstructions、includePartialMessages、includeHookEvents、forwardSubagentText、abortController、hooks、onElicitation、sandbox 等。

PilotDeck 以宿主 ownership 拆分这些字段：

| Options 领域 | 原生模块 | SDK 处理方式 |
|---|---|---|
| cwd/目录 | AgentSession、Gateway project/workspace、path safety | 作为 session/run 输入并由服务端校验 |
| model/effort/thinking | Router、model runtime、canonical thinking | 传递选择，读取实际 resolved model |
| maxTurns | AgentSubmitOptions、TurnRunner | run option，直接映射 |
| maxBudgetUsd / taskBudget | Gateway `submit_turn`、AgentSession/TurnRunner/AgentLoop、Router cost estimate、Gateway durable budget ledger | `maxBudgetUsd` 为 per-turn ceiling；`taskBudget.total` 为 Gateway-owned experimental session/project shared ceiling，SDK 只传 total/scope，不持有 spent cost |
| permission/tool allowlist | PermissionRuntime、ToolRegistry、filterAvailableTools | SDK 提供 options 和 decision API，服务端最终裁决 |
| continue/resume/fork/persist | Session、Transcript、Gateway | sessions resource，不在客户端复制状态 |
| tools/mcpServers | ToolRegistry、McpRuntime | tool catalog 与 MCP resource |
| agents | AgentSubagentDefinition、SubAgentSession | agents/subagents resource |
| plugins/skills/settings | PluginRuntime、SkillManager、PromptAssembler | list/read/reload/config API |
| output/system prompt | ContextRuntime、PromptAssembler、structured output | 提交声明，服务端组装最终 prompt |
| stream/hooks/elicitation | AgentEvent、HookRuntime、ElicitationChannel | event stream 和 callbacks |
| forwardSubagentText | `SubAgentSession.forwardActivity()`、Gateway event mapper、SDK stream projector | 默认保持 generic status；opt-in 后仅将 child text 投影为 `subagent.message`，不改变 parent output、transcript 或 child runtime |
| sandbox | SDK `sandbox.tool_policy`、Gateway session ToolRegistry filter、ToolRuntime、Bash policy、宿主部署环境 | SDK 仅序列化 restrictive tool policy；Gateway 对 owning session 移除相关 native/MCP/custom/shell/task/subagent bridge。它不在 SDK 本地假设 OS/container 隔离 |

### SDKMessage、结果和控制协议

Claude SDKMessage 包括用户、助手、partial、result、system、compact、status、retry、hook、task、background、permission、rate-limit、thinking、plugin、memory、elicitation、notification、control 和文件持久化事件。

PilotDeck 原生来源：

- AgentEvent 和 AgentTurnResult：[`src/agent/protocol/events.ts`](../../src/agent/protocol/events.ts)、[`src/agent/protocol/result.ts`](../../src/agent/protocol/result.ts)；
- Gateway event/request/response：[`src/gateway/protocol/types.ts`](../../src/gateway/protocol/types.ts)、[`src/gateway/protocol/frames.ts`](../../src/gateway/protocol/frames.ts)；
- Hook execution events：[`src/extension/hooks/events/HookExecutionEventBus.ts`](../../src/extension/hooks/events/HookExecutionEventBus.ts)；
- Transcript entries：[`src/session/transcript/TranscriptEntry.ts`](../../src/session/transcript/TranscriptEntry.ts)。

SDK 必须将这些内部事件投影为稳定公共联合类型，并区分：

- completed、failed、aborted、result_unknown；
- tool progress 与 tool final；
- permission denied 与普通 tool failure；
- transport close 与业务终态；
- usage、model usage、artifact 和 checkpoint。

### Hooks 全量事件族

Claude Hook 事件包括 PreToolUse、PostToolUse、PostToolUseFailure、PostToolBatch、Notification、UserPromptSubmit、UserPromptExpansion、SessionStart、SessionEnd、Stop、StopFailure、SubagentStart、SubagentStop、PreCompact、PostCompact、PreModelSwitch、PostModelSwitch、PermissionRequest、PermissionDenied、Setup、TeammateIdle、TaskCreated、TaskCompleted、Elicitation、ElicitationResult、ConfigChange、WorktreeCreate、WorktreeRemove、InstructionsLoaded、CwdChanged、FileChanged、DirectoryAdded、MessageDisplay。

PilotDeck 对应：

- 事件协议：[`src/extension/hooks/protocol/events.ts`](../../src/extension/hooks/protocol/events.ts)；
- 输入/输出：[`src/extension/hooks/protocol/`](../../src/extension/hooks/protocol/)；
- command、prompt、http、agent、callback executor 和 HookRuntime：[`src/extension/index.ts`](../../src/extension/index.ts)。

`@pilotdeck/sdk` 已将原生已发射 lifecycle event 暴露为 `Options.hooks` callback：SDK 进程托管带 bearer token 的 HTTP endpoint，Gateway 只接收 URL、headers、event/matcher/timeout 并转换为原生 HTTP hook。原生 HookRuntime 负责执行、effect 和超时语义，turn/session 终态仍归宿主所有。Claude 专属事件不自动成为 PilotDeck 兼容承诺；远程 Gateway 必须能访问调用进程通过 `hookServer.publicUrl` 提供的 endpoint。

### 工具、MCP、Subagents 和扩展

Claude 的工具 schema 覆盖文件、shell、web、notebook、plan、todo、task、MCP resources、artifact、projects、cron、worktree、notifications、skills、goals 和 workflow。PilotDeck 的内置工具、schema validation、availability、scheduler、audit 和 result projection 都在 [`src/tool/index.ts`](../../src/tool/index.ts) 与其子目录中。

Claude 的 MCP 支持 stdio、SSE、HTTP、SDK in-process、proxy、resources、tool policy、动态 server、reconnect、toggle、OAuth/elicitation、tool search、searchHint 和 alwaysLoad。PilotDeck 的 MCP runtime 在 [`src/mcp/index.ts`](../../src/mcp/index.ts)，工具桥接在 [`src/mcp/runtime/PluginToToolBridge.ts`](../../src/mcp/runtime/PluginToToolBridge.ts)。`@pilotdeck/sdk` 的 `createPilotDeckMcpServer()` 已把 SDK 调用者的 JavaScript handler 通过标准、可达的 MCP endpoint 接入这条既有路径；不是把 handler 放入 Gateway WebSocket。`@pilotdeck/sdk/embedded` 现已提供 `createEmbeddedToolRegistry()`，可把同进程 `tool()` handler 发布给 `createLocalGateway().updateSubsystems()` 并复用原生 ToolRuntime/PermissionRuntime/scheduler；还可由宿主创建 `createEmbeddedGatewayEndpoint()`，使 `createEmbeddedQuery()`/`startupEmbedded()` 和 `createEmbeddedPilotDeckClient()` 在同一进程、无 TCP listener 的条件下复用 Gateway wire dispatcher。`createEmbeddedPilotDeckHost()` 进一步组合 typed client、可选 local tools 与 registry attachment，关闭时仅 detach SDK attachment/endpoint，不 dispose host Gateway。client/control 与 Query 共享一次 handshake。它们都不创建第二套 AgentLoop；Gateway 的 `nativeSessionStorage` 提供 host-controlled filesystem layout，`createGatewayAsyncTranscriptStorageAdapter()` 还可接入跨后端的 transcript、file-history checkpoint 与 tool-result payload durable storage。独立 runtime 与完整 sandbox 仍是后续能力。

Claude AgentDefinition 包含 tools、model、MCP、skills、background、memory 和 maxTurns。PilotDeck 对应 [`src/tool/builtin/agent.ts`](../../src/tool/builtin/agent.ts) 的 AgentSubagentDefinition、BUILTIN_SUBAGENTS、createAgentTool，以及 [`src/agent/sub/SubAgentSession.ts`](../../src/agent/sub/SubAgentSession.ts)。SDK 动态 Agent 的 `model` 已由 Gateway model catalog 解析后写入原生 `SubagentDefinition.modelOverride`，未声明时保留 project subagent default/parent-model 继承；`mcpServers` 可使用 fork-local server map，也可使用 Claude 形状 `("tickets" | { docs: config })[]`。其中字符串只引用当前 SDK session 内已启用的 MCP endpoint，Gateway 在 child 创建前复制 transport config；未知或禁用引用拒绝创建，plugin/config-owned MCP 没有该名称空间。每次 fork 的 `McpRuntime` 都独立启动、只注册 child tools 并在结束时关闭，故 parent 的 toggle/reconnect 不会改写 active child；`skills` 只能缩小父技能域且同时限制 prompt/`read_skill`，`memory: "disabled"` 只停用 child memory retrieval/capture。`background: true` 经 [`BackgroundSubagentRuntime`](../../src/agent/sub/BackgroundSubagentRuntime.ts) 在 Gateway 侧创建 non-blocking child task，父 turn 结束后继续，sidechain transcript、abort、timeout 和 shutdown 均由宿主持有。`initialPrompt` 只在 child directive 前加入 user message，`criticalSystemReminder_EXPERIMENTAL` 只追加给 child system prompt。observer/observerMessage、team 与 Claude callback 语义仍不能直接互换，因此整体仍为部分等价。

### SessionStore、Checkpoint、Sandbox 和账户

Claude 公开 SessionStore、InMemorySessionStore、SessionKey、SessionStoreEntry、SessionSummaryEntry、importSessionToStore、resumeSessionAt、rewindFiles、SandboxSettings、SandboxFilesystemConfig、SandboxNetworkConfig、SandboxIgnoreViolations、AccountInfo、ModelInfo、ModelUsage、Transport、SpawnOptions 和 WarmQuery。

PilotDeck 有 project storage、JSONL/in-memory transcript、Claude-like SessionStore、FileHistoryStore、backup/restore、Gateway/RemoteGateway 和 module/sidecar transport。除 `FileSessionStore` 外，SDK 的 `createSessionStoreFromAdapter()`（embedded 别名 `createEmbeddedSessionStore()`）可把 SDK event mirror 写入宿主的 async snapshot persistence，并保留 schema/key/UUID 校验和单实例 append 串行；它绝不接管 Gateway transcript、checkpoint 或 active run。SDK 已提供 `Query.rewindFiles()`；snapshot 与 post-edit fingerprint 由 transcript replay 在 Gateway 重启后惰性恢复，外部修改会 fail-closed。SDK 还提供 Gateway-owned `sandbox.tool_policy`，可收紧一个 session 的模型可见工具面；它不替代统一 OS/container SandboxSettings。Claude account API 仍缺失。SDK 文档必须把这些标为部分对应、缺失或不适用，不能因为内部存在相似类名就宣称兼容。

## 哪些内容不应放进 SDK

以下内部实现不应成为普通 SDK 用户必须理解的接口：

- `AgentLoop` 内部状态机；
- `TurnRunner` 组装过程；
- `ToolScheduler` 的调度细节；
- provider-specific model message；
- transcript JSONL 文件格式；
- Gateway 原始 frame；
- permission 内部 matcher；
- compaction 算法；
- Plugin 和 Skill 的内部加载器；
- PilotDeck 数据库或文件目录结构。

这些内容可以继续作为内部模块 API，但不能等同于稳定公共 SDK。

## 人类开发者应该选择哪一层

### 使用 SDK

适合以下场景：

- 在 Web、桌面端、CLI 或后端服务中调用 PilotDeck；
- 希望快速创建 session 并运行 Agent；
- 只关心事件、结果、审批和文件产物；
- 不想了解 Agent Loop 内部结构；
- 需要远程调用和稳定版本兼容。

### 使用原生模块

适合以下场景：

- 开发或修改 PilotDeck 本身；
- 增加模型 provider；
- 增加内置工具或调度策略；
- 修改 context、compaction、permission 或持久化；
- 开发新的 Gateway、sidecar 或宿主 adapter；
- 需要进程内嵌入并能承担 runtime 组装成本。

### 优先判断规则

```text
只是“调用 PilotDeck”      -> 使用 SDK
需要“改变 PilotDeck 怎么运行” -> 修改原生模块
需要跨进程接入新能力       -> 使用 module/sidecar protocol
需要本地嵌入 Agent Runtime -> 使用独立 Embedded SDK 或内部模块
```

## 推荐的第一版 SDK

第一版 SDK 只需要覆盖最常见的人类接入流程：

1. 连接 Gateway；
2. 创建或恢复 session；
3. 发起 run；
4. 消费流式事件；
5. 处理 permission 和用户问答；
6. steer、cancel 和 abort；
7. 获取结果、usage、transcript 和 artifacts；
8. 管理基础 MCP 配置；
9. 关闭客户端。

模型调用、工具执行、context、permission policy、compaction、session persistence 和 Agent Loop 仍由原生模块负责。

## 当前状态说明

PilotDeck 当前已经具有上述大部分原生模块和 Gateway 能力，但还没有正式发布、具有稳定版本承诺的公共 SDK。现阶段可以复用内部 TypeScript 模块或 Gateway 协议，但对外提供前应增加稳定的客户端 façade、公共类型、错误模型、兼容策略和发布流程。

详细设计和实施流程见：

- [PilotDeck SDK 开发与接入 SOP](pilotdeck-sdk-development-sop.zh.md)
- [PilotDeck 当前可复用表面](pilotdeck-sdk-current-surface.zh.md)
- [SDK 能力差距矩阵](sdk-capability-gap-matrix.zh.md)
