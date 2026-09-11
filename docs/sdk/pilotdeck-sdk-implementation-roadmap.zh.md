# PilotDeck SDK 实现 Roadmap

状态：实施中。能力状态、P0/P1/P2 backlog 与版本排期只在本 Roadmap 维护；当前已实现能力和待实现能力的唯一汇总见 [4.1.1 能力状态总览](#411-能力状态总览唯一状态来源)，4.2 给出逐项边界与验收口径。SOP 只规定开发约束和验收流程，不重复这些状态。
目标读者：PilotDeck Runtime、Gateway、SDK、测试和应用接入团队
基线：PilotDeck 提交 20b88268，Claude Agent SDK TypeScript 0.3.263 作为 API 体验参考
更新日期：2026-09-11

## 0. 一页结论

本 Roadmap 是能力状态和优先级的唯一来源：4.1.1 说明当前已实现能力及 P0/P1/P2 总览，4.2 记录每项能力的交付状态、剩余工作和验收门槛。判断“已实现”的标准是：`@pilotdeck/sdk` 有 public type/façade，Gateway 有对应 wire contract，且有契约或集成测试；只有内部模块或未接线的协议草案，不算 SDK 已实现。

当前 alpha 的完整能力清单、P0/P1/P2 的已交付项和待办，以及不进入 backlog 的 Claude 专属能力，统一见 [4.1.1 能力状态总览](#411-能力状态总览唯一状态来源)。本节不再维护第二份状态表，避免与唯一状态来源发生漂移。

注意：P1 已接通 `outputStyles()`/`setOutputStyle()`/`reloadOutputStyles()`、`usage()` aggregate、`modelUsage()`、per-turn `maxBudgetUsd`、session-scoped `Options.skills`/`.plugins`、动态 `AgentDefinition.mcpServers`/`.skills`/`.memory`/`.initialPrompt`/`.criticalSystemReminder_EXPERIMENTAL`、`persistSession: false` 与 session/project scope `taskBudget.total` 的 Gateway/SDK 全链路。output style、checkpoint、skills、plugins、动态 AgentDefinition、ephemeral session 和 model usage 的具体边界以 4.1.1 为准。`taskBudget.total` 的 Gateway ledger 持久化 AgentLoop 本次实际记账的成本，独立于 Router diagnostics；默认 `session` scope 以 session 计账，`project` scope 将同一 Gateway project 的 SDK sessions 合并为共享额度。两种 scope 都可在 Gateway 重启后恢复，project ledger 不因任一 session 删除而清除；达到记录阈值后，Gateway 会以同目录临时文件和原子 rename 将 journal 压缩为 snapshot，同时保留已消费金额、project ceiling、retention contract 与已结算 `runId` 的幂等信息。显式 `projectRetentionMs` 仅适用于 `project` scope；保留期内 total/retention contract 固定，最后一次创建或已结算 spend 后超时的下一次配置会先清除旧 ledger 再创建新周期。`usage()`/`modelUsage()` 还返回请求数口径的 `costSources`，明确区分 provider reported、显式价格表、内置估算、回退估算与 legacy unknown；Gateway host 可用 `router.stats.retentionMs` 按正整数毫秒窗口筛除过期 Router stats，并在 retention-aware writer lock 下同目录原子压缩 JSONL。未配置时保持原有 append-only 留存；`maxBudgetUsd` 在一次模型调用完成后、任何恢复或工具副作用之前由 Gateway/Runtime 停止该 turn，并返回 `agent_max_budget_reached`/`max_budget`。

旧版 MCP transport、`fallbackModel`、`agentProgressSummaries` 和 `onUserDialog` 的 native elicitation/opt-in `input`/`select`/`confirm`/schema-backed `form` adapter 均不再是 P2 待实现项。`Query.setMcpServers()`/`mcpServers` 现在接受 legacy `sse`，并把 Claude `type: "http"` 规范化为 Gateway `streamable_http`；`PilotDeckOptions.fallbackModel` 由 Gateway 按模型目录校验并解析，由 Router 在主模型出现可重试、且尚未向调用方输出可见内容的故障后执行本 session 的回退；`agentProgressSummaries: true` 则将现有工具的 transient progress 映射为 SDK `tool.progress`；`supportedDialogKinds` 对应 session 的 cloned ToolRegistry 按需注册 `request_user_input`、`request_user_choice`、`request_user_confirmation`、`request_user_form`。Gateway 管理 request id、pending state、类型/choice/schema 校验、取消和回包；SDK 可以托管 callback，或以 `userDialogMode: "manual"` 将 live pending request 交给 `Query.respondUserDialog()`/`client.dialogs.*`。它们都是兼容切片而非第二套运行时：Gateway/McpRuntime 拥有 MCP 连接、发现和关闭生命周期，Gateway/Router 拥有模型解析、重试、回退、progress 和 dialog lifecycle，SDK 只序列化配置、托管 callback 或投影 Gateway state；SDK-hosted `tool()` server 仍仅发布 `streamable_http`，新集成也应优先使用该 transport。

`promptSuggestions: true` 同样已脱离 P2 backlog：Gateway 只在成功、非 abort 的 turn 后发起隔离辅助模型调用，成功时在 `turn_completed` 前投递一次 transient `prompt_suggestion`。该建议不写入 transcript 或模型对话状态；生成失败或超时时只省略该事件，原 turn 的结果与终态不变。

P2 的 `onUserDialog` 已从单一 `input` 扩展为受限的 `input`、`select`、`confirm` 和 schema-backed `form`。它们分别注册 session-local 的 `request_user_input`、`request_user_choice`、`request_user_confirmation`、`request_user_form`：`select` 的返回值必须匹配该次请求声明的 option value，`confirm` 的返回值必须为 boolean，`form` 必须返回匹配 Gateway form-schema subset 的 object。显式声明 `$schema: "https://json-schema.org/draft/2020-12/schema"` 时，Gateway 使用标准 Draft 2020-12 validator 进行本地 schema 编译和 answer validation，并对外部引用 fail closed；SDK 已提供 Node terminal、browser-native 和 framework-free DOM renderer。browser 版本可使用原生 `prompt`/`confirm` 和 JSON object form、`createDomBrowserDialogDriver()` 的原生 form control，也可注入异步 `driver.render(request, { signal })`，让应用自己的 React/Web Component/modal 拿到完整 typed request 与 schema；DOM renderer 对 object、标量、可递归解析的 local `$ref`、`items` 数组和 `prefixItems` tuple 提供 typed controls，并按默认值、`minItems`/`maxItems` 约束追加或移除可变 item；未声明 `items` 的 prefix tail、`patternProperties` 和显式 additional field 使用 JSON editor。它还会安全合并无冲突的 root/field `allOf`，并为不含条件/否定约束的 `oneOf`/`anyOf` 提供 typed branch selector；其他 composition 与未知 field 继续回退 JSON editor。SDK 只接受标准 answer envelope，Gateway 仍做最终验证。未声明 `$schema` 时继续使用历史 PilotDeck subset：它校验 object/array/string/number 的常用约束、schema 型 `additionalProperties`、`patternProperties`、`contains`/`minContains`/`maxContains`、`propertyNames`、tuple `prefixItems`、`email`/`uri`/`uuid`/`date`/`time`/`date-time` 字符串 format，以及受全局 schema 深度/节点、每分支 32 条与每个依赖映射 64 条限制的 `allOf`/`anyOf`/`oneOf`/`not`、`if`/`then`/`else`、`dependentRequired`/`dependentSchemas`。历史路径还支持根 `$defs` 内至多 64 个简单命名的定义，以及精确的 `#/$defs/<name>` 本地引用；未知 definition、循环、外部 URI 和任意 JSON Pointer 会拒绝。未知 keyword、format 也会拒绝。Gateway 持有 pending request、类型/选项/schema 校验、取消、turn-end cleanup 和重复/迟到回包拒绝；SDK 可托管 callback，或以 `userDialogMode: "manual"` 让调用者消费事件、经 `Query.respondUserDialog()` 或 `client.dialogs.list/respond()` 回包。persistent session 的 Gateway 在发出请求前以 transcript 旁的原子 journal 记录 pending request；重启后 `dialogs.list()` 将其投影为带 `recovery: "next_turn_context"` 的 `user_dialog_terminated`/`gateway_restarted`。对原始 contract 校验通过的 `respond()` 会返回 `{ delivered: true, recovered: true, reason: "gateway_restarted" }`，并将合成的 durable user message 写入 transcript，供下一次显式提交的新 turn 作为正常上下文读取；无效答案不会消耗 journal，已处理记录不会重复投递。embedding host 还可提供 `GatewayUserDialogStore`：基础 store 只增强 durable recovery；仅完整的 `listLive`/`claimLive`/`releaseLive`/`submitLiveAnswer`/`takeLiveAnswer` 原子协议允许第二个 Gateway 协作 renderer lease 与 answer handoff，原始 Gateway 保持旧 AgentLoop/tool promise 的 continuation。它不恢复重启后的旧 AgentLoop、turn、tool promise 或 transcript run state，仍不是全量、多宿主 JSON Schema UI 或可恢复的 dialog 状态机。

## 1. Roadmap 目标

本 Roadmap 的目标是把 PilotDeck 当前已有的内部 Agent、Gateway、Session、Tool、Permission、MCP 和 Extension 能力，逐步包装成一个可安装、可测试、可演进的 TypeScript SDK。

最终产品目标是 **Claude Code SDK-like**：外部开发者能够使用接近 `query()`、`Options`、`Query`、session helper、`tool()`/MCP、hooks、permission 和 typed messages 的接口；这些接口只对齐调用体验和能力分组，不复制 Claude 的 provider 登录、CLI 二进制、transcript 格式或内部实现。SDK 适配可以修改协议层，但不得改变 PilotDeck 原生模块的 Agent Loop、工具、权限、上下文、持久化或终态语义。

建议第一阶段采用 Gateway-first 路线：

~~~text
应用
  -> PilotDeck SDK
  -> Gateway protocol
  -> AgentSession / AgentLoop
  -> Model / Tool / Context / Permission / Session
~~~

原因：

- Gateway 已经具备 session、turn、stream、permission、elicitation、项目、文件、模型、skills 和 MCP 等控制面；
- 远程 SDK 不需要在调用者进程中组装 TurnRunner、ToolRuntime 和 ContextRuntime；
- session、run、permission 和 transcript 的权威状态可以继续由宿主维护；
- 后续 Embedded SDK 可以复用同一套公共事件、结果和错误类型。

## 2. 最终产品形态

建议最终提供两个入口。

### 2.1 Gateway Client SDK

建议包名：@pilotdeck/sdk，最终名称需在发布前确认。

适合：

- Web 后端；
- 桌面应用；
- CLI；
- 自动化服务；
- 第三方平台；
- 本地或远程 Gateway。

预期调用形态：

~~~ts
const client = createPilotDeckClient({
  gatewayUrl,
  authToken,
});

const session = await client.sessions.create({ projectKey });

const run = client.runs.start({
  sessionId: session.id,
  input: { type: "text", text: "检查并修复测试失败" },
});

for await (const event of run.events()) {
  render(event);
}

const result = await run.result();
~~~

### 2.2 Embedded SDK

建议入口：@pilotdeck/sdk/embedded。

适合：

- PilotDeck 宿主开发；
- 在同一 Node.js 进程中已创建权威 Gateway、但不希望开放 TCP/WebSocket listener 的嵌入；
- 需要注册本地 TypeScript 工具；
- 能承担 Gateway runtime、permission、storage 和 sandbox 组装成本的高级用户。

当前 experimental `@pilotdeck/sdk/embedded` 已提供 `createEmbeddedQuery()`、`startupEmbedded()`、`createEmbeddedPilotDeckClient()`、`createEmbeddedPilotDeckHost()`、`createEmbeddedSessionStore()` 和 `PilotDeckEmbeddedTransport`。宿主先创建权威 Gateway，并用 `createEmbeddedGatewayEndpoint()` 暴露同一套 Gateway wire dispatcher；SDK 再通过内存连接消费与远程模式相同的 Query/WarmQuery、stream、result、typed resource client 与错误协议。`createEmbeddedPilotDeckHost()` 还将 client、可选 local `tool()` registry 与其 `updateSubsystems()` attachment 组合起来，关闭时只 detach registry 并关闭 SDK endpoint，绝不 dispose 传入的 Gateway。`createEmbeddedSessionStore()` 以宿主 async snapshot persistence 保存 SDK 事件镜像，并保留 UUID 去重、单实例 append 串行和 schema 校验；它不读写 Gateway transcript/checkpoint 或 active run。

Gateway host 可通过 `createLocalGateway({ nativeSessionStorage })` 将 persistent session 的 JSONL、sidechain、file-history checkpoint 与 artifact 目录解析到宿主控制的本地 layout。需要 DB 或 object store 时，`createGatewayAsyncTranscriptStorageAdapter({ store })` 提供 host-owned primary/subagent transcript append/read；可选 `list`、`has`、`delete`、`deleteSession` 与原子 `replace` 接管 session list/delete、portable archive restore 和包含递归 sidechain payload 的 transcript-only fork，`fileHistoryBackups` 接管 file-history backup blob，`prepareReplacement`/`finalizeReplacement`/`recoverReplacements` 接管 last-turn replacement。可选 `toolResultArtifacts.write/read/delete/deleteAll` 还持久化大文本和媒体 tool-result payload：重启时 Gateway 从受控 transcript reference 重建 workspace cache，fork 复制被引用 payload 并重写 reference，delete 清理 session payload。默认不配置时仍使用现有 filesystem 路径。

Gateway 仍拥有 session、run、resume、fork、export/restore、delete 和 checkpoint 语义，SDK 不获得存储 handle。一个 endpoint 只完成一次 hello，client 的控制面和每个 Query transport 共享这条已认证连接；关闭单个 Query 只释放该 Query 的 listener，client close 才关闭 endpoint。它不自行创建 AgentLoop、模型、Gateway storage、permission 或 sandbox，也不是“无 Gateway”的独立 runtime。

## 3. 范围与非目标

### 第一阶段范围

- TypeScript/Node.js；
- Gateway WebSocket 客户端；
- session 管理；
- run 提交、流事件和最终结果；
- steer、cancel steer、abort；
- permission 和 elicitation；
- transcript、models、commands、projects、files；
- usage、artifacts 和 typed errors；
- 基础 MCP 配置和状态；
- npm 包、文档和示例。

### 第一阶段非目标

- 浏览器直接保存长期 Gateway token；
- 公开 AgentLoop、TurnRunner、ToolScheduler 等内部类；
- 在远程 SDK 中直接传输 JavaScript handler；
- 自动重放可能产生副作用的请求；
- 完整复制 Claude Agent SDK 的函数名；
- 跨机器 SessionStore；
- 稳定的 file rewind/checkpoint 公共 API；
- 独立于 Gateway 的 Embedded Agent Runtime；
- Python SDK；
- 对所有内部 Hooks、Plugins、Skills 类型做一比一导出。

## 4. 实施原则

1. Gateway 是第一版公共服务边界。
2. SDK 不维护第二套 session/run 状态机。
3. public API 与 wire protocol 类型分离。
4. transport close 不等于 run 成功或取消。
5. 未知结果必须表达为 result_unknown。
6. permission、timeout、abort 和 failure 不能归一化为成功。
7. 新增公共 API 必须有运行时行为、类型和兼容性测试。
8. 先发布小而稳定的资源 API，再增加 Embedded 和高级扩展。
9. 内部源码导出不自动成为 SDK public exports。

## 4.1 当前实现快照（alpha）

当前 `packages/sdk` 已落地 Gateway-first alpha 骨架及其协议适配：

- 已实现：`query()`/`startup()`、WebSocket hello 与能力信息、session continue/resume/list/messages/fork/rename/tag/delete、流式事件、permission/elicitation callback（含只适配 native elicitation 的 `onUserDialog`）、原生 lifecycle `hooks` HTTP bridge、`setPermissionMode()`、`setMcpPermissionModeOverride()`（指定 MCP server 的保守 session ask 覆盖）、模型与 session thinking 控制、session-scoped `fallbackModel`、opt-in `agentProgressSummaries`/`tool.progress`、opt-in `forwardSubagentText`/`subagent.message`、模型/命令/内置 subagent 查询、动态 `AgentDefinition` 的 prompt/tools/maxTurns/effort/permissionMode、per-agent `model`、fork-local `mcpServers`/`skills`/`memory`、Gateway-owned experimental `background`、`initialPrompt`、child-only `criticalSystemReminder_EXPERIMENTAL`、`Options.skills` 的 session-scoped prompt/read access、Gateway-local `Options.plugins` session view、MCP status、项目文件读取、`rewindFiles()`（含 `file_snapshot_recorded` transcript replay）、自定义 system prompt、tool alias、额外工作目录、明确工具集、`allowedTools`/`disallowedTools` 会话级过滤、SDK-owned `stdio`/`streamable_http` MCP 动态配置、PilotDeck JSON-schema structured output、Gateway `usage_snapshot` aggregate 与 `model_usage_snapshot`、SDK `usage()`/`modelUsage()`、per-turn `maxBudgetUsd`、output-style list/select/reload、Gateway-owned ephemeral `persistSession: false`、幂等 `result()` 与 `result_unknown` 恢复态；以及 PilotDeck 专有的 `client.cron.create/list/update/delete/stop/runNow` 定时任务资源。`Options.skills` 在 Gateway 以唯一技能名解析，未知或歧义项会在原生 session 创建前拒绝；显式列表只约束 `<available-skills>` 与 `read_skill`，不改变项目 PluginRuntime。`Options.plugins` 只接受 absolute Gateway-local path，在 Gateway 配置阶段加载 manifest 并以 read-only session view 投影 commands、skills、hooks、output styles 与 plugin MCP；它不写入 project registry，plugin MCP 在 session close/delete/eviction 时关闭。AgentDefinition 的 `mcpServers` 在每一次 child fork 内创建并关闭 `McpRuntime`，MCP tools 只进入 child registry；其 `skills` 只能缩小父 session 技能域，`"all"` 继承已缩小的父域，且同时限制 prompt 与 `read_skill`。`background: true` 为该 child fork 创建 Gateway-owned task，立刻向父 Agent 返回 task id；其 abort、timeout、sidechain transcript 与 runtime invalidation cleanup 均由 Gateway 管理，不复用 Bash background runtime。`initialPrompt` 会在 child directive 之前添加 user message，`criticalSystemReminder_EXPERIMENTAL` 只追加到该 child 的 system prompt。`memory: "disabled"` 仅令 child ContextRuntime 不含 `MemoryResolver`，因此不检索也不捕获该 fork 的 memory。per-agent `model` 是 Gateway 目录解析的唯一可用 `provider/model`，SDK 不自行猜测；未设置时仍遵循原生 subagent-default/parent-model 继承。`fallbackModel` 由 Gateway 解析为当前 session 的候选 `provider/model`，并由 Router 仅在主模型可重试失败且未产生可见内容时使用；未设置时仍走原生 Router 回退路径，子 Agent 继承其 parent runtime 配置。`agentProgressSummaries: true` 只把原生 `PilotDeckToolRuntimeContext.progress` 投影成 `tool.progress`，不记录到 transcript，也不更改工具调度、最终 tool result 或未开启时的事件流。`forwardSubagentText: true` 只把现有 child `text_delta` 投影为 typed `subagent.message`，不参与 parent output、transcript 或 AgentLoop。`onUserDialog` 与 `onElicitation` 互斥；其 `dialogKind` 只能为 `elicitation`，返回值通过 Gateway 的既有 request id 往返投递，未知 dialog kind 仍显式返回 `unsupported_capability`。`persistSession: false` 仅限新 session，SDK 把显式 wire config 交给 Gateway；Gateway 以 `InMemoryTranscriptWriter` 和系统临时目录创建 session，绝不创建 project transcript，且在删除、close、idle eviction 或 shutdown 后清理临时 artifact。`permissionMode: "auto"` 已接受并保留为 SDK 公共请求模式，但在创建和 `setPermissionMode("auto")` 时均保守映射为 Gateway `default`/`basePermissionMode: "default"`；它不伪造 Claude classifier，不自动放行工具，仍由原生 permission 与 `canUseTool` 决定。另有受限的 `updateSettings("localSettings", …)`：Gateway 在自身 `$PILOT_HOME/pilotdeck.yaml` 上对 allowlist 的非 secret runtime settings 完成临时完整校验、原子写入和 `PilotConfigStore` 重载；顶层 `resolveSettings()` 可返回同一 Gateway 的已脱敏配置 snapshot、来源和诊断。`packages/sdk/examples/` 已加入可安装 tarball，覆盖基础 query、streaming、permission、resume/fork、abort、MCP 和 structured output；transport contract tests 已覆盖认证失败、协议版本失败、transient hello 重试、乱序 response、sequence gap、重复 final、未知 notification 与 close 时 pending request。
- 已实现（P2 experimental）：`onUserDialog` 还可声明 `supportedDialogKinds: ["input"]`，使 Gateway 只在该 SDK session 的 cloned ToolRegistry 注册 `request_user_input`。工具发出 `user_dialog_request` 后，SDK callback 以 `user_dialog_respond` 返回一段短文本或取消；Gateway 负责 request id、pending state、取消、turn-end cleanup 与重复/迟到回包拒绝。它不要求 `canUseTool`，也不改变 permission prompt 策略；当 `onElicitation` 只处理 native elicitation、`onUserDialog` 只声明 `input` 时，两者可以共存。该能力只覆盖单个 free-form input，不是任意 dialog kind、UI renderer 或通用状态机。未携带 `userDialogKinds` 时，不注册工具、不改变原生 tool schema、permission、session 或 transcript 行为。
- 已实现（P2 experimental）：`supportedDialogKinds` 还接受 `select`、`confirm` 和 `form`。它们只在 opt-in session 分别注册 `request_user_choice`、`request_user_confirmation`、`request_user_form`；前者将 2--12 个声明式 choice value 连同可选 label/description 发给 host，Gateway 只接受其中之一，后者只接受 boolean。`form` 将 object schema 交给 host，支持 Gateway form-schema 的 properties/`patternProperties`/required/items/`prefixItems`/enum/const、字符串与数值范围、`contains`/`minContains`/`maxContains`、`propertyNames`、`email`/`uri`/`uuid`/`date`/`time`/`date-time` format、array/object size、schema 型 `additionalProperties`，以及有全局深度/节点、每分支 32 条与每个依赖映射 64 条限制的 `allOf`/`anyOf`/`oneOf`/`not`、`if`/`then`/`else`、`dependentRequired`/`dependentSchemas`；根 schema 可声明最多 64 个简单命名 `$defs`，并在字段或 definition 中以 `#/$defs/<name>` 复用。Gateway 在消费 pending request 前验证 object answer。unknown definition、循环、外部 URI、任意 JSON Pointer、nested `$defs`、unknown keyword 与 format 会被拒绝。三者和 input 一样不复用 permission prompt、不写入额外 dialog transcript，也不改变未 opt-in session 的 ToolRegistry、AgentLoop 或 scheduler。
- 已实现：Claude-like `SessionStore`、`InMemorySessionStore`、Node `FileSessionStore`、增量 `foldSessionSummary()`、批量 `importSessionToStore()`；key 包含 project/session/subpath，支持 UUID 幂等去重与 subagent sidechain。`FileSessionStore` 以 schema version 1 JSON snapshot、同目录原子 rename 和进程内串行写入持久化 SDK event mirror，并提供显式 `exportSession()`/`importSession()` 的 `reject`/`append`/`replace` 冲突策略；它只恢复调用方镜像，不写入或取代 Gateway transcript/session。另有 P1 experimental 的 `exportSessionTranscript()`/`restoreSessionTranscript()` 与 `client.sessions.exportTranscript()`/`.restoreTranscript()`：Gateway 从已完成 native transcript 导出 schema v1 `portable_text_messages`，并只向全新、非活动的 persistent session 原子写入归档；文件 checkpoint、tool artifact、subagent sidechain、权限、active run 和客户端镜像均不传输。
- 已实现：`createPilotDeckMcpServer()`/`createSdkMcpServer()` 把 SDK 调用者进程中的 `tool()` handler 暴露为可关闭、可发现的标准 MCP endpoint，支持标准 MCP `instructions`、server-level timeout，并在 `mcpServers` 接入时转换为 Gateway `streamable_http` 配置。Gateway 只走既有 MCP/ToolRegistry/PermissionRuntime 路径；不通过 WebSocket 序列化 JavaScript handler，也不新增 callback-RPC。
- 已实现（P2 experimental）：`@pilotdeck/sdk/embedded` 的 `createEmbeddedQuery()`、`startupEmbedded()`、`createEmbeddedPilotDeckClient()`、`PilotDeckEmbeddedTransport` 与 `createEmbeddedGatewayEndpoint()`。宿主将已经创建的权威 Gateway 交给内存 endpoint；endpoint 复用 `GatewayWsConnection` 的 `hello`/`request`/`stream` dispatcher，不启动 TCP listener，SDK 仍经正常 Gateway protocol 创建 session、提交 turn、消费 stream 与读取 final result。`createEmbeddedPilotDeckClient()` 复用远程 client 的 typed sessions/runs/projects/files/models/commands/skills/cron/config façade；控制面和 per-query transport 共享 endpoint 的单次 hello，单个 Query close 不关闭 client endpoint。endpoint close 按 WebSocket 断开规则 abort active turn。它不直调 AgentLoop，也不创建或拥有模型、session、permission、transcript、storage 或 sandbox；这些仍完全由传入的 Gateway/宿主拥有。
- 已实现（P2 experimental）：SDK session 与动态 `AgentDefinition` 的 MCP 配置接受 `stdio`、`streamable_http` 和 legacy `sse`；Claude `type: "http"` 是到 `streamable_http` 的兼容 alias。Gateway/McpRuntime 管理 remote MCP 的连接与关闭，SDK-hosted `tool()` endpoint 仍只提供 `streamable_http`。
- 已实现：`allowedTools`、`disallowedTools`、Gateway host `organizationPolicy.tools.allow`/`.deny` 和 session sandbox 都是会话级工具面约束，而非仅在 parent registry 创建时过滤一次。组织策略 selector 支持精确名称、`prefix*` 和 `*`；未配置 `allow` 时保持历史默认可见性，显式 allowlist 仅保留匹配工具，deny 与 allow 同时命中时 deny 优先。动态 `AgentDefinition.mcpServers` 在 child fork 内晚注册时，Gateway 会在 child scheduler 创建前重新投影 registry；因此 fork-local MCP 不能重新暴露被顶层 allow/deny、host policy 或 sandbox 隐藏的工具。该过滤只缩小 child model-visible surface，不改变 MCP handler、ToolRuntime、permission 或 session ownership。
- 已实现（P2 experimental）：`PilotDeckOptions.promptSuggestions: true` 请求 Gateway 在成功、非 abort 的 turn 后生成一条建议，并在 `turn_completed` 前发出 transient `prompt_suggestion` 事件。建议生成使用隔离的辅助模型请求，绝不写入 transcript 或模型对话状态；失败或超时只省略该事件，不改变原 turn。它是 post-turn suggestion，不会替代独立交付的 `input` dialog，也不复制 Claude 的 parent-prompt-cache 语义。
- 明确未实现或未完成：Claude 专属 hook 事件载荷、完整 deferred/async hook effect、Claude experimental callback 面、provider-specific JSON mode、完整 Claude settings control（`applyFlagSettings()` 和 `updateSettings("localSettings", …)` 都是严格受限子集）、account façade。`observer`/`observerMessage` 已交付 PilotDeck 定义的 P1 experimental 语义，但不是 Claude 持续 `ObserverReport` 工具循环的等价实现。durable checkpoint、output-style Gateway/SDK 控制面、usage aggregate/cost provenance/retention、per-turn `maxBudgetUsd`、带 project retention 的 session/project scope `taskBudget.total` 和动态 AgentDefinition 的 model/MCP/skills/memory/initial prompt/background/observer/child-only critical reminder 已作为 P1 experimental 切片接通，不能据此宣称 Claude 完全等价。未支持的 settings key 显式返回 `unsupported_capability`。
- `stopTask()` 可通过 Gateway 控制当前 SDK session 所拥有的 Bash 或 background-subagent task；background-subagent 的 task id 位于启动它的流式 `tool.completed.data.backgroundTaskId`，`backgroundTasks()` 只报告是否仍有活跃 child。observer 是内部 detached sidechain，不进入这两个用户控制面；对其他原生 Bash task 继续诚实报告其天生 detached、没有可转换的 foreground task，不把 cron 当作替代品。其余没有真实协议或宿主语义支撑的方法继续显式返回 `unsupported_capability`，不伪造成功。PilotDeck `client.cron` 管理持久化定时任务及其 run，仍不等价于 Claude 的 query-level background task。
- 上一项中的 deferred/async hook result 指可任意回写 native lifecycle effect 的 Claude 完整语义。当前已接通的 P1 experimental 范围仅为 context-only `asyncHookId` 回传：Gateway 负责 session/run 归属、deadline、turn cleanup 和幂等；SDK 只提交 `additionalContext`。它不支持 delayed block/allow、permission、input rewrite 或 system message，详细状态以 4.1.1 和 4.2 为准。
- 协议层允许的修改仅用于上述 SDK wire contract；AgentLoop、TurnRunner、ToolRuntime、PermissionRuntime、ContextRuntime 和 Session transcript 的语义与所有权不变。
- 对于无法只用 wire schema 表达的公开选项，可在 session/runtime 构造边界增加默认关闭的协议适配字段；未携带字段的原生路径必须保持不变，并通过 runtime parity 证明 prompt、工具顺序、权限结果、终态、transcript 和副作用次数未受影响。

后续迭代应以 fake Gateway contract tests 和真实 `createLocalGateway` 黑盒测试为门槛，再逐项解除 `unsupported_capability`，每解除一项必须同时补齐 wire schema、运行时实现、类型、文档和回归测试。

### 4.1.1 能力状态总览（唯一状态来源）

本节是“当前已实现能力”和 P0/P1/P2 待实现 backlog 的唯一总览；4.2 是每项能力的实施明细与验收口径。SOP 只规定开发约束和验收流程，不重复维护下表。新增、完成、降级或取消能力时，必须先更新本节的状态，再同步更新 4.2、映射表和差距矩阵的证据；不得把状态更新写入 SOP。

判读规则：只有同时具备 `@pilotdeck/sdk` public type/façade、Gateway wire contract 与契约或真实 Gateway 测试的能力，才计为“已实现”。`experimental` 描述发布成熟度，不代表仍有同一功能的待办；“待实现”只列尚未具备上述完整链路的新增能力。发布、安装、重启、隔离、兼容性与原生语义回归是对应能力的验收门槛，不另算作 P0/P1/P2 的新增功能待办。

| 范围 | 当前状态 | 当前已实现能力 | 新增功能待办（不含发布/回归验收） |
|---|---|---|---|
| 当前 alpha SDK | 已交付，持续进行发布回归 | 核心调用与传输、session/transcript、permission/dialog、tools/MCP、模型与扩展、usage/budget、checkpoint、output style、动态 subagent、hooks、settings/sandbox 的已交付切片，以及 Embedded client/资源 API。具体 public API 见下方“当前已实现能力”。 | 不按“当前 alpha SDK”另建 backlog；只以 P0/P1/P2 三行判断待实现范围。内部模块存在或未接线 wire 草案均不计为 SDK 已实现。 |
| P0 | 功能开发已完成 | `title`、transcript-boundary resume、strict MCP、load timeout、保守 permission、hook event、custom prompt 和 plan instructions 均已具备 public facade、wire contract 与测试。 | **0 项。**发布回归不属于功能 backlog。 |
| P1 | 功能开发已完成（alpha/experimental） | checkpoint recovery、output style、usage/model usage/cost provenance、per-turn 与 project task budget、skills/plugins、ephemeral session、portable transcript archive/restore、动态 AgentDefinition、context-only async hook、支持的 Gateway lifecycle、FileChanged/ConfigChange 与 SessionStore mirror。 | **0 项。**Phase 7 的重启、隔离、安装、兼容性与原生语义回归是发布验收，不属于功能 backlog。 |
| P2 | 功能开发已完成（experimental） | legacy MCP、fallback model、tool progress、opt-in `forwardSubagentText` typed child stream、prompt suggestions、受限 dialogs、Node terminal/browser-native/framework-free DOM dialog renderer、live pending-dialog/manual response、`client.dialogs.watch()` server-pushed 变更提示及 `createManualUserDialogRenderer()` lease coordinator；persistent session 的 restart-terminal dialog record（`user_dialog_terminated`/`gateway_restarted`，不恢复旧 turn），以及 host-owned `GatewayUserDialogStore` durable discovery/recovery。`FileGatewayUserDialogStore` 在共享本地文件系统以 per-session lock/atomic rename 实现完整 live-store 协议；`HttpGatewayUserDialogStore` 以 bearer-protected、版本化 HTTP service 把同一完整协议提供给独立 Gateway 主机，支持 renderer lease、form answer handoff 与 owner heartbeat。原 Gateway 始终继续自己的 AgentLoop/tool promise；owner 过期后只能走 terminal recovery，下一条新 turn 才消费 recovered context。完整 Gateway-owned managed settings/source cascade（固定 source precedence、host overlay/enforcement、provider ID/origin/credential-source、permission/model/tool/turn-limit policy）也已交付。 | **0 项。**完整 host/OS-native sandbox 是非排期技术差距，按当前范围不实施，不计入 P2 backlog。 |

#### 待实现能力摘要

截至当前基线，新增功能待办计数固定为：**P0 = 0，P1 = 0，P2 = 0**。P0/P1/P2 均转入发布质量与原生语义回归；它们不是新增 SDK 功能。完整 host/OS-native sandbox 保留为 deferred 技术差距，当前范围不实施，也不计入 backlog；其余能力的边界和验收证据在 4.2 维护。

#### 当前已实现能力（alpha）

- **P2 Gateway-managed settings/source cascade（experimental）**：`settingSources` 以 Gateway 固定的 `managed < user < project < local` precedence 合并；`managedSessionSettings`、`sessionDefaults`、`sessionDefaultSources` 与 `enforcedSessionSettings` 均只能由 embedding host 的 `organizationPolicy.settings` 注入，SDK 无法传入、读取或修改。host `settingSources.allow`/`.deny` 在读取前拒绝不可信 source，显式 SDK `settings` 仅覆盖允许的非密钥 agent overlay，token cap 与 enforced settings 保持最终优先级。`organizationPolicy.providers` 还可按 exact provider ID、credential-free HTTP(S) origin 和 non-secret credential source（`environment`、`literal`、`provider_default`）allow/deny；策略在 session model selection、Router 与直接 ModelRuntime 调用前生效，拒绝不会触发 provider request。所有 provider endpoint、API key、环境变量名和 host policy 内容都不在 SDK wire 上。真实 Gateway E2E 覆盖 source precedence/host deny/native-path isolation，以及 origin/credential deny-before-request 和 allow path。该完成定义是受控的 host policy cascade，不是允许远程 SDK 上传 provider 配置或凭据。
- **P2 Node terminal dialog renderer（experimental）**：`createTerminalUserDialogHandler()` 可直接作为 `onUserDialog` callback，`renderTerminalUserDialog()` 也可处理 `userDialogMode: "manual"` 下从 live `dialogs.list()` 重新发现的请求。二者处理 input/select/confirm，按字段收集 simple scalar、enum、object 与 local `$ref` form input，并将 composition/unknown field 回退为 JSON 输入。它们只投递答案，Gateway 仍是 schema validator、pending request 与 turn lifecycle 的权威；不提供多宿主 UI、持久化 dialog state 或跨 Gateway restart continuation。
- **P2 browser-native dialog renderer（experimental）**：`createBrowserUserDialogHandler()` 可直接作为 `onUserDialog` callback，`renderBrowserUserDialog()` 可渲染 live manual dialog，`createWindowBrowserDialogDriver()` 惰性封装浏览器的 `prompt`/`confirm`。它的原生 fallback 支持 input/select/confirm 与 JSON object form；应用可只提供异步 `driver.render(request, { signal })`，以自身组件渲染完整 typed request/schema，返回标准 answer envelope 或 `undefined` 走 fallback。无效 renderer 回包 fail-closed，模块导入不会访问 browser global，因此可安全用于 Node/SSR。它只提交 Gateway 最终校验的 answer，不提供内置组件级、schema-driven 多宿主 UI、dialog state 持久化或跨 Gateway restart continuation。
- **P2 browser DOM dialog renderer（experimental）**：`createDomBrowserDialogDriver()` 将 Gateway request 渲染为可样式化的 DOM modal，`renderDomBrowserUserDialog()` 可渲染 manual live request。它为 form 的 string、number/integer、boolean、enum、object/递归 local `$ref`，以及 `items` 数组和 `prefixItems` tuple 生成原生 control；数组按默认值、`minItems`/`maxItems` 创建、追加或移除可变 typed item，未声明 `items` 的 prefix tail 用 JSON editor。无冲突 root/field `allOf` 会合并为 typed form，不含条件/否定约束的 `oneOf`/`anyOf` 提供 branch selector；`patternProperties`、explicit additional field、其余 composition 和未知字段回退 JSON editor。对可编译 schema，它会用 bundled Ajv Draft 2020-12 在本地拦截结构性错误并保持 modal；无法编译时保守跳过，Gateway 仍是唯一最终 validator。应用可通过 `document`、`mount` 和 `className` 接入任意页面或组件宿主。它只返回 answer/cancel envelope，不读取或保存 Gateway state，abort/cancel 后移除 DOM，因此不宣称持久化 dialog state 或跨 Gateway restart continuation。
- **P2 terminal form prevalidation（experimental）**：renderer 使用 bundled Ajv Draft 2020-12 对已收集 form answer 做本地 structural validation；`allOf`、`oneOf`、依赖等跨字段约束失败会重新提示 form。SDK 无法编译的 Gateway-local schema extension 保守跳过本地校验，最终 acceptance 仍只由 Gateway 决定。
- **P2 Gateway restart dialog recovery（experimental）**：persistent SDK session 发出 `input`/`select`/`confirm`/`form` request 前，Gateway 在 transcript 同目录以临时文件加 rename 写入 session-local journal；正常 answer、cancel、timeout 和 turn-end cleanup 会移除它。新 Gateway 读取遗留 journal 后，`client.dialogs.list()` 返回 `user_dialog_terminated` 与原 request 的展示上下文。调用 `client.dialogs.respond()`/`Query.respondUserDialog()` 时，Gateway 重新按原 contract 验证 input/select/confirm/form answer；成功会原子写入 synthetic durable user message 与终止 recovery turn，删除 journal，并返回 `{ delivered: true, recovered: true, reason: "gateway_restarted" }`。下一次新提交的 turn 将该 message 作为普通模型上下文；无效 answer 不会消耗 journal，重复 answer 在 cleanup 后返回 `delivered: false`。该切片绝不重建 AgentLoop、run、tool promise、permission 或 checkpoint，也不实现自动跨 Gateway continuation。
- **P2 host-owned durable dialog store（experimental）**：`createLocalGateway({ userDialogStore })` 接受 embedding host 提供的 `GatewayUserDialogStore`。基础 `put/list/remove/clear` 让 pending dialog 脱离本地 `.dialogs.json`，第二个 Gateway 可发现并投影为 restart-terminal recovery；回答仍只写入 durable synthetic context，不能复活旧 AgentLoop。仓库导出的 `FileGatewayUserDialogStore` 是共享本地文件系统的持久实现：它以 per-session lock 保护 read-modify-write，以 sibling temporary file + rename 落盘，并完整实现 live renderer lease、answer handoff 与 owner heartbeat。`HttpGatewayUserDialogStore` 与 `startGatewayUserDialogStoreHttpServer()` 则定义 bearer-protected、版本化的 host-to-host HTTP 协议；服务端要求 backing store 实现完整 live/owner 方法，因此可部署在独立存储主机或替换为事务型 DB store。两个 Gateway 可经 `client.dialogs.list/claim/release/respond` 协作 renderer；第二个 Gateway 只拥有 renderer lease 和 answer handoff，原 Gateway 轮询 `takeLiveAnswer()`、以原 request contract 校验答案，并继续自己拥有的 tool promise、turn 与 AgentLoop。owner heartbeat 过期时 `listLive()` 不再投影该记录，第二个 Gateway 自动回落到既有 restart-terminal recovery。真实 Gateway E2E 覆盖了远端 JSON Schema form 的无效 answer 拒绝、有效 answer handoff、原 owner turn 完成，以及 owner 过期后的 `gateway_restarted` terminal recovery。缺少任一 live 接口的自定义 store 继续 fail closed 为 recovery-only，不误报跨 Gateway continuation；重启后的旧 turn 永不自动续跑。
- **核心调用与传输**：`query()`、`startup()`、WebSocket hello/能力协商、typed errors、流式消息、`result()` 幂等读取、`result_unknown` 恢复态、`interrupt`/`abort`、steer/cancel-steer，以及完成后释放 SDK socket 而不改变 Gateway session/run 的 `Query.close()`。
- **进程内 Embedded client（P2 experimental）**：`@pilotdeck/sdk/embedded` 的 `createEmbeddedQuery()`/`startupEmbedded()`/`createEmbeddedPilotDeckClient()` 通过 `PilotDeckEmbeddedTransport` 连接宿主提供的 `createEmbeddedGatewayEndpoint()`；请求仍穿过 Gateway 的 `hello`/`request`/`stream` dispatcher，产生正常 Gateway-owned session、run、permission、transcript 与工具副作用。client 复用远程模式的 typed resource façade，且控制面与 child Query transport 共享一次已认证 hello；关闭单个 Query 不关闭 client endpoint。它避免 TCP listener，不创建第二套 AgentLoop 或状态机；`createEmbeddedToolRegistry()` 仅补充同一 local Gateway 的工具注册。
- **Session 与 transcript**：create/list/continue/resume/fork/messages/rename/tag/delete；Claude-like `SessionStore`、`InMemorySessionStore`、`FileSessionStore`、summary fold、批量 import，以及 subagent sidechain key。`FileSessionStore` 可跨 SDK 进程恢复版本化本地事件镜像，使用显式 snapshot 冲突策略；它不恢复 Gateway 运行态或 transcript。P1 experimental `exportSessionTranscript()`/`restoreSessionTranscript()` 由 Gateway 导出已完成历史的 portable text archive，并用 schema 校验、fresh/inactive target 冲突检查与同目录临时文件 rename 生成新的持久 transcript；下一次 native session 构造会从该 transcript 恢复文本上下文。它不传递 checkpoint、artifact、sidechain、permission 或 active run。另有 `persistSession: false` 的 Gateway-owned 内存 transcript 与临时 artifact 生命周期。
- **权限与交互**：permission/elicitation callback、`onUserDialog` 的 native elicitation adapter 和 opt-in `input`/`select`/`confirm`/schema-backed `form` dialogs，以及 `userDialogMode: "manual"`、`Query.respondUserDialog()` 和 `client.dialogs.list/watch/claim/release/respond()` 的 live-Gateway pending-dialog 投影；`watch()` 对同一 session 的 `requested`、lease 和 settled mutation 投递 best-effort server notification，漏通知或重连后 renderer 必须 `list()` resync；`createManualUserDialogRenderer()` 将这一顺序、opaque lease 续租、abort/release 和回包封装为 SDK convenience coordinator，但 Gateway 仍拥有 pending state、validation 和 turn lifecycle。`claim()` 提供带到期时间的 Gateway-owned renderer lease，使多个 SDK client 不会同时提交同一 live dialog。`setPermissionMode()`、保守映射到 Gateway `default` 的 `permissionMode: "auto"`、`dontAsk`/`permissionPrompts: "none"`、受限 `acceptEdits`、MCP server permission override；服务端仍拥有最终裁决。`auto` 没有 Claude classifier 或自动放行语义。manual `dialogs` 不持久化或跨 Gateway restart 恢复 dialog/run state。
- **工具与 MCP**：工具别名、显式工具集、`allowedTools`/`disallowedTools`、额外工作目录；SDK-owned `stdio`/`streamable_http`/legacy `sse` MCP、Claude `http` 到 `streamable_http` 的兼容 alias、`tool()`/`createPilotDeckMcpServer()`，以及不创建/消费 `Query` 的 `client.mcp.status()`/`.setServers()`/`.reconnect()`/`.toggle()`/`.setPermissionModeOverride()`。后者只控制 Gateway-owned session-local MCP 配置和状态，SDK-hosted endpoint 仍须由调用方保持存活。`sse` 仅用于旧服务兼容；新接入和 SDK-hosted `tool()` server 仍使用 `streamable_http`。
- **Prompt、模型与扩展查询**：自定义/数组 `systemPrompt`、`planModeInstructions`、主 Agent 模型和 thinking 控制（含受限的 flag/settings 子集）、session-scoped `fallbackModel`、动态 AgentDefinition 的 per-agent `model`、fork-local `mcpServers`/`skills`/`memory`、`initialPrompt`、Gateway-owned experimental `background`、`observer`/`observerMessage` 与 child-only `criticalSystemReminder_EXPERIMENTAL`、模型/命令/内置 subagent/skills 查询、项目文件读取、PilotDeck JSON-schema structured output。
- **P2 post-turn prompt suggestions（experimental）**：仅在 `PilotDeckOptions.promptSuggestions: true` 时，Gateway 会在成功且未 abort 的 turn 结束后，以原始用户 prompt 和最终 assistant 文本发起隔离的辅助模型请求；清洗后的结果作为一次 `prompt_suggestion` 事件在 `turn_completed` 前投递。它不是 transcript 或模型对话状态，绝不写入 transcript；生成超时或失败时不发事件，也不影响原 turn 的终态。该切片不提供通用 dialog 状态机，也不复制 Claude 的父 prompt cache 语义。
- **P2 受限 dialogs（experimental）**：仅在 `onUserDialog` 与 `supportedDialogKinds` 同时声明时，Gateway 才在 session-local cloned registry 中按需注册 `request_user_input`、`request_user_choice`、`request_user_confirmation`、`request_user_form`。`input` 经 `user_dialog_request` 投递 `prompt`、可选 `placeholder` 和 `allowEmpty`，回传短文本或取消；`select` 声明 2--12 个 choice value，回传必须为其中之一；`confirm` 只能回传 boolean；`form` 使用 Gateway 专属、显式关键字的 object schema subset：properties/`patternProperties`/required、boolean 或 schema 型 `additionalProperties`、items/`prefixItems`、enum/const、字符串 length/pattern、`email`/`uri`/`uuid`/`date`/`time`/`date-time` format、数值 range/multipleOf、array items/uniqueItems、`contains`/`minContains`/`maxContains`、object property-count/`propertyNames`，以及有全局深度/节点、每分支 32 条和每个依赖映射 64 条限制的 `allOf`/`anyOf`/`oneOf`/`not`、`if`/`then`/`else`、`dependentRequired`/`dependentSchemas` 都会在 Gateway 消费 pending response 前校验。根 schema 还可声明最多 64 个简单命名 `$defs`，并在字段或定义中用 `#/$defs/<name>` 引用；循环、未知定义、外部 URI、任意 JSON Pointer、嵌套 `$defs`、未知关键字和 format 都会明确拒绝。request id、pending lifecycle、类型/choice/schema 校验、abort/turn-end cleanup、重放过滤与重复/迟到回包都由 Gateway 持有。普通 tool call/result 仍照常进入 transcript 和下一次模型请求，没有隐藏 UI transcript。它不提供全量 JSON Schema、完整 schema-driven host UI 或可持久化 dialog state；未 opt-in 的 session 不会暴露这些工具或改变工具 schema。
- **瞬态工具进度**：`agentProgressSummaries: true` 使 `bash` 等会发出 `PilotDeckToolRuntimeContext.progress` 的原生工具输出 `tool.progress`；Gateway 负责 session 开关和 event stream，SDK 只做 wire 序列化和类型化投影。该事件不持久化、不替代最终 tool result，未开启时不会改变原生 AgentLoop 的输出。
- **生命周期与资源**：原生 lifecycle hooks HTTP bridge、`includeHookEvents` 的 started/response 事件，以及 experimental `Query.submitAsyncHookResult()`。SDK hook callback 返回 `{ async: true }` 时，Gateway 为当前 session/run 登记 `asyncHookId`；随后只能提交同一 hook event 的 `additionalContext`，Gateway 将它作为 active-turn steer mailbox 的上下文。deadline、turn 结束、重复提交和短期幂等结果均由 Gateway 管理；任意迟到结果不会改变已完成 turn。该切片不能回写 hook input、block/allow 工具或修改 permission，均显式返回 `UNSUPPORTED_ASYNC_HOOK_EFFECT`。SDK 显式配置 `FileChanged` 时，`write_file`、`edit_file`、`edit_notebook` 成功写入后会在独立 SDK Hook runtime 派发该事件，并投影 callback 与 hook stream；它不能阻止或回滚已经完成的写入，也不会激活项目原有的未接线 FileChanged Hook。SDK 显式配置 `ConfigChange` 时，Gateway 的 `PilotConfigStore` reload 会向当前存活 session 的独立 SDK lifecycle 派发 `changedPaths`/`changeClasses`，并投影 hook stream；它不会激活 project hook，不能改变 reload、runtime invalidation 或 AgentLoop。该观察事件不登记 `asyncHookId`，因此任何异步 result 都由 Gateway 返回 `unknown`，不会注入 active turn。`AgentDefinition.background: true` 会把现有 `agent` fork 变为 Gateway-owned non-blocking task：任务 id 立即作为 tool result 返回，子 Agent 不随父 turn 结束，sidechain transcript、abort/timeout 与关闭均由 Gateway runtime 持有，`Query.stopTask()`/`backgroundTasks()` 只允许同一 session 控制。`observer: "<agent-name>"` 在被观察 child 完成后启动独立、无工具、read-only 的 Gateway-owned sidechain；它接收限长活动摘要和可选 `observerMessage`，报告只保存在 observer sidechain，既不进入 parent/observed child 的模型上下文，也不进入 `backgroundTasks()`/`stopTask()`。它不复用 Bash background runtime，也不是 Claude 的持续观察工具循环。此外包含 durable `rewindFiles()`（Gateway 重启后可从 transcript 惰性恢复，外部变更 fail-closed）、当前 SDK session 所拥有的 background task stop/status；PilotDeck 专有 `client.cron.*` 定时任务资源。
- **查询、计量与配置**：`usage()` 优先读取 Gateway `usage_snapshot`，返回 session/project aggregate 的请求数、token、成本、model/provider/role 维度和 `costSources`；`modelUsage()` 读取独立的 `model_usage_snapshot`，由 Gateway/Router stats 分组返回每个 provider/model 的 token、成本、成本来源计数和 main/subagent 维度，不做 SDK 侧拼账。`provider_reported`、`configured_price`、`built_in_estimate`、`fallback_estimate` 与 `legacy_unknown` 明确区分，成本不得被统一伪装为精确账单。`getContextUsage({ detail: "full" })` 还返回 Gateway token accountant 的 local-estimate `system/tools/messages/MCP/memory` 分类；provider 总量仍不被伪装为精确分类。旧 Gateway 对 `usage()` 回退到当前 turn event snapshot，`modelUsage()` 则显式返回 `unsupported_capability`。`reloadPlugins()`/`reloadSkills()`、受限的 `updateSettings("localSettings", …)`/`resolveSettings()`；其中 local settings 已安全覆盖 agent context/output/thinking、subagent default/timeout/maxDepth、hook event、builtin-plugin enablement 与 web-search enablement，但不能改 provider、凭据、plugin path 或 managed source。`options.settings` 与 `settingSources` 是 Gateway-owned、只作用于本次 session 构造的非持久 overlay：Gateway 按固定 `user < project < local` 优先级，从自身 `$PILOT_HOME/pilotdeck.yaml`、`$PROJECT_ROOT/.pilotdeck/pilotdeck.yaml`、`$PROJECT_ROOT/.pilotdeck/pilotdeck.local.yaml` 的完整配置中只提取 allowlist `agent.model`、`agent.fallbackModel`、`agent.maxContextTokens`、`agent.maxOutputTokens`、`agent.thinking`、`agent.subagents.default`、`.timeoutMs` 和 `.maxDepth`，再由显式 `options.settings` 覆盖；`maxDepth: 0` 禁止 fork，正整数按现有 AgentLoop 深度语义生效，并受 host `organizationPolicy.limits.maxSubagentDepth` 只收紧的 cap 约束。两类 model 与 fallback 均经 Gateway catalog 校验，primary/fallback `null` 分别恢复 host default/禁用 source fallback，subagent default 的 `null`/`"inherit"` 恢复 parent-model 继承；显式 `Options.model` 与 `.fallbackModel` 仍是更高优先级的 per-turn/session override。provider 配置/凭据、插件、路径、工具及 permission grant 仍永不进入 overlay。另有 session-scoped、只收紧的 `managedSettings`：除 tool pattern 的 deny/ask 和 `defaultMode: "plan"` 外，还可设 `canPrompt: false` 使 Gateway native `PermissionContext` 拒绝交互式 permission prompt；三者均不能 grant access，且 managed `canPrompt: false` 优先于普通 session override。独立 `@pilotdeck/sdk` ESM exports、可安装 tarball 示例，以及 transport/SDK contract tests。
- **查询、计量与配置**：`usage()` 优先读取 Gateway `usage_snapshot`，返回 session/project aggregate 的请求数、token、成本、model/provider/role 维度和 `costSources`；`modelUsage()` 读取独立的 `model_usage_snapshot`，由 Gateway/Router stats 分组返回每个 provider/model 的 token、成本、成本来源计数和 main/subagent 维度，不做 SDK 侧拼账。`provider_reported`、`configured_price`、`built_in_estimate`、`fallback_estimate` 与 `legacy_unknown` 明确区分，成本不得被统一伪装为精确账单。`getContextUsage({ detail: "full" })` 还返回 Gateway token accountant 的 local-estimate `system/tools/messages/MCP/memory` 分类；provider 总量仍不被伪装为精确分类。旧 Gateway 对 `usage()` 回退到当前 turn event snapshot，`modelUsage()` 则显式返回 `unsupported_capability`。`reloadPlugins()`/`reloadSkills()`、受限的 `updateSettings("localSettings", …)`/`resolveSettings()`；其中 local settings 已安全覆盖 agent context/output/thinking、subagent default/timeout/maxDepth、hook event、builtin-plugin enablement 与 web-search enablement，但不能改 provider、凭据、plugin path 或 managed source。`options.settings` 与 `settingSources` 是 Gateway-owned、只作用于本次 session 构造的非持久 overlay：Gateway 按固定 `user < project < local` 优先级，从自身 `$PILOT_HOME/pilotdeck.yaml`、`$PROJECT_ROOT/.pilotdeck/pilotdeck.yaml`、`$PROJECT_ROOT/.pilotdeck/pilotdeck.local.yaml` 的完整配置中只提取 allowlist `agent.model`、`agent.fallbackModel`、`agent.maxContextTokens`、`agent.maxOutputTokens`、`agent.thinking`、`agent.subagents.default`、`.timeoutMs` 和 `.maxDepth`，再由显式 `options.settings` 覆盖；`maxDepth: 0` 禁止 fork，且 host `organizationPolicy.limits.maxSubagentDepth` 只能压低该值。两类 model 与 fallback 均经 Gateway catalog 校验，primary/fallback `null` 分别恢复 host default/禁用 source fallback，subagent `null`/`"inherit"` 恢复 parent-model 继承；显式 `Options.model` 与 `.fallbackModel` 仍是更高优先级的 per-turn/session override。provider 配置/凭据、插件、路径、工具及 permission grant 仍永不进入 overlay。另有 session-scoped、只收紧的 `managedSettings`：除 tool pattern 的 deny/ask 和 `defaultMode: "plan"` 外，还可设 `canPrompt: false` 使 Gateway native `PermissionContext` 拒绝交互式 permission prompt；三者均不能 grant access，且 managed `canPrompt: false` 优先于普通 session override。Gateway embedding host 还可通过 `createLocalGateway({ organizationPolicy })` 配置不经 SDK wire 传输的组织级 restrictive policy：`permissions` 可合并 deny/ask、强制 plan 或禁用 prompt，`models` 可用 `*`、`provider/*`、`provider/model` allow/deny selector 收紧 primary、dynamic subagent、SDK fallback 与 Router fallback；`tools.deny` 可用 exact-name/`prefix*`/`*` 在 native、SDK MCP、plugin/custom、动态 AgentDefinition fork-local MCP 及延迟 MCP search contribution 合入后剔除 model-visible 工具。被拒绝的 deferred target 不会被 catalog/reveal 重新暴露；若策略拒绝后注册的 `search_tools`，Gateway 也会在该 session 中移除它。deny 优先，Router 在 provider 请求前过滤，若 Gateway 默认模型不允许则不发起 session title/prompt-suggestion 的 best-effort 直接请求。规则在 session policy、remembered allow 与 bypass mode 之前生效，且不提供 provider 配置、credential、allow grant 或完整 source cascade。独立 `@pilotdeck/sdk` ESM exports、可安装 tarball 示例，以及 transport/SDK contract tests。
- **跨 turn task budget（P1 experimental）**：`taskBudget: { total, scope?: "session" | "project", projectRetentionMs?: number }` 将正 USD ceiling 放入 `sdkSessionConfig`。默认 `session` scope 以 `projectRoot + sessionKey` 键控；显式 `project` scope 将同一 Gateway project 的 SDK sessions 合并到一个 durable ledger。Gateway 在每个 turn 开始读取 ledger，并将 AgentLoop 实际记账的每个 `runId` 成本幂等写回；session scope 的 Router aggregate 只作补充诊断来源，snapshot 取两者较大值。统计关闭时两种 scope 都可跨 Gateway restart 恢复；project budget 不会因任一 session 删除而清除。记录达到阈值后，Gateway 将 journal 原子重写为 snapshot，保留 spent cost、project total、retention contract 和 settled `runId`，从而保持重启后的幂等性。模型调用跨限会在任何恢复、工具和副作用前终止为 `agent_task_budget_reached`/`task_budget`；随后的 turn 在 native session 创建前拒绝，SDK 从不上传 spent/cost。`projectRetentionMs` 是可选正整数毫秒值，只允许 `project` scope；Gateway 以首次配置的 total/retention 固定合约，按创建或已结算 spend 更新活动时间，超时后的下一次配置原子清除旧 ledger 并开始新周期。未配置时保持永久保留。
  第一个成功配置的 `project` scope 会将 `total` 和可选 `projectRetentionMs` 写入 Gateway durable ledger；后续 session 必须使用同一 contract，较大的 total 也不能抬高额度，冲突会在创建 native session 前返回 `SDK_PROJECT_TASK_BUDGET_TOTAL_CONFLICT` 或 `SDK_PROJECT_TASK_BUDGET_RETENTION_CONFLICT`。
- **P1 experimental 已交付**：`outputStyles()`、`setOutputStyle()`、`reloadOutputStyles()` 由 Gateway 选取和重载 style registry；运行中的 session 拒绝切换，已选 style 只注入下一次 runtime 构造的 system prompt。`FileHistoryStore` 将 file snapshot 与 post-edit fingerprint 写入 JSONL transcript；Gateway 重启后的 `rewind_files` 会惰性恢复索引，拒绝覆盖外部修改，且 restore 采用原子 rename。`maxBudgetUsd` 通过 Gateway `submit_turn` 传入，Router 按 provider native cost 或配置价格表核算本 turn 的每次模型调用；触及阈值后 AgentLoop 不再发起恢复、工具或下一次模型调用。`modelUsage()` 将同一 Router 的 JSONL stats 重建为逐模型 aggregate。动态 `AgentDefinition.model` 由 Gateway 在建 session 前从模型目录解析，映射为原生 `SubagentDefinition.modelOverride`，优先级高于 project 的 subagent default；每一个 child fork 还可启用独立 MCP、受父 session 上限约束的 skills，以及 `memory: "disabled"` 的 child-only memory 抑制。`background: true` 把该 child fork 注册为 Gateway-owned task，立即返回 task id，父 turn 完成后继续运行；Gateway 负责 abort、timeout、session ownership、sidechain transcript 和 runtime invalidation cleanup。`initialPrompt` 仅在 child directive 前追加用户上下文，`criticalSystemReminder_EXPERIMENTAL` 仅在 child system prompt 增加提醒；二者均不影响父 session。SDK async hook result 也已建立 Gateway-owned invocation id、deadline、turn cleanup 和幂等结果；目前只允许把 `hookSpecificOutput.additionalContext` 注入进行中的 turn，不能反向改变已经执行的 native hook lifecycle effect。SDK `FileChanged` 使用独立的 post-write hook runtime，只有显式 SDK 配置时才为 `write_file`、`edit_file`、`edit_notebook` 发射，既不阻止已经完成的写入，也不改变全局项目 Hook 的行为。其余 P1 真实项目验收见下方表，不能据此宣称 Claude 完全等价。
- **P1 experimental observer 已交付**：`observer` 必须引用同一 session 中另一个已定义的 AgentDefinition，不能自指；`observerMessage` 为空时忽略。被观察 child 结束后，Gateway 构造一个限长的只读 digest，并用目标 AgentDefinition 在无工具、无 MCP、无 memory、无 skills 的 detached sidechain 中运行 observer。observer report 不写回 parent 或被观察 child 的模型上下文，不进入 `backgroundTasks()`/`stopTask()`，但会保存在 observer sidechain transcript；在原始 turn 仍活跃时可投影为事件，不能当作可靠的 post-turn stream delivery 契约。runtime invalidation/shutdown 会取消它。该行为是 PilotDeck 定义的 post-completion observer，不是 Claude 的连续 `ObserverReport` loop。
- **P2 experimental 已交付**：`Query.setMcpServers()`/`mcpServers` 接受 legacy `sse`，并将 Claude `type: "http"` 规范化为 Gateway `streamable_http`。`PilotDeckOptions.fallbackModel` 由 Gateway 解析和验证，并由 Router 仅在主模型的可重试、pre-content 故障后尝试，避免已流式输出内容被重复；`agentProgressSummaries: true` 则把 native tool progress 映射为瞬态 `tool.progress`。`promptSuggestions: true` 则由 Gateway 在成功、非 abort 的 turn 后发起隔离的辅助模型请求，并在终态前发出一次非持久化 `prompt_suggestion`；默认关闭，失败或超时不改变原 turn。`sandbox: { type: "tool_policy" }` 的 `filesystem: "read_only"` 收紧文件写入，`filesystem: "deny"` 移除所有 `kind: "filesystem"` 工具；两者都移除可绕开的 host bridge。`network: "deny"` 与 `process: "deny"` 分别收紧网络与进程相关工具及 bridge。该策略只作用于 owning session 的 model-visible ToolRegistry，不提供 host/OS 隔离。SDK-hosted MCP server 或单个 `tool()` 设置 `alwaysLoad: false` 时，SDK 将 deferred MCP metadata 与 endpoint 一并交给 Gateway；`PilotDeckOptions.deferredTools` 还可按 canonical name 延迟 native、plugin 或 MCP tool。Gateway 在发现和所有 policy/availability/turn tool filters 后合并目录，只在首个模型请求暴露 session-local `search_tools`。命中后才把对应 definition 加回同一 session 的 ToolRegistry，下一次原生 AgentLoop request 才可调用它；已排除的 target 不进入目录，若 `search_tools` 被显式排除则 target 保持 hidden。SDK 只序列化配置，MCP lifecycle 仍由 Gateway `McpRuntime` 管理；`tool()`/`createPilotDeckMcpServer()` 不因兼容层改为 SSE server。
- **P2 named host sandbox 已交付**：`sandbox: { type: "host", profile, toolIsolation?: "strict" }` 把 profile 名作为 SDK session config 交给 Gateway，`createLocalGateway({ sandboxProfiles })` 才决定 profile 是否存在并创建 runner。标准 `createBubblewrapSandboxProfile()` 返回 `BubblewrapSandboxCommandRunner`，后者以 `bwrap` 的空 root、最小 runtime bind、私有 `/tmp`、namespace、清空 environment 和 project workspace mount 执行 native `bash` 与 opt-in `execute_code` Python；Python 仅挂载该次私有 RPC 目录并只接收运行所需环境变量。`filesystem: "read_only"` 将 workspace mount 改为只读，`filesystem: "deny"` 不挂载 workspace、仅在私有 `/tmp` 执行 scratch process。`execute_code` 仅在 profile 声明 `supportsExecuteCode: true` 时暴露；`supportsFilesystemReadOnly`、`supportsFilesystemDeny`、`supportsNetworkDeny` 分别是对应收紧组合的显式前提，未声明均 fail closed。收紧时 Gateway 从 Python helper RPC allowlist 移除文件写入、全部文件或网络 helper，避免回调绕过 profile。MCP/custom/task/subagent 等未经 runner 控制的 bridge 继续隐藏；`toolIsolation: "strict"` 仍只保留 profile-owned Bash 与 Gateway-local structured output/request-user tools。未知 profile、无 runner 和 workspace 外 cwd 会 fail closed。strict 模式仍不隔离 provider、Gateway 或既有基础设施，因此不宣称完整 OS isolation。

## 4.2 P0/P1/P2 实施明细与验收口径

本节是 4.1.1 状态总览的唯一实施明细：P0、P1、P2 均已完成新增功能开发，只维护发布回归；完整 host/OS-native sandbox 仅作为 deferred 技术差距记录，当前不实施、不计入 P2 backlog。Claude CLI 进程控制、Claude 账号登录、Claude Code preset、provider-specific JSON mode 等产品专属能力不进入实现 backlog。

### P0：补齐现有 Gateway 能力的 SDK 接口（已完成，无待实现功能）

目标：不新增第二套运行时，只把已有 session、transcript、permission、MCP、hook 和 prompt 能力完整接到公共 SDK。

| 能力 | 当前状态 | 实现与边界 | 验收证据 |
|---|---|---|---|
| `Options.title` | 已实现 | 新建、resume、fork 后通过 `rename_session` 设置；RPC 错误向上返回 | SDK transport contract：title RPC 参数与失败传播 |
| `resumeSessionAt` | 已实现 | 通过 `fork_session` 建立新 session，源 transcript 不原地截断；支持任意 chain entry | SDK contract：`resumeAt`、新 session key、源 session 不执行 resume |
| `resumeDropsTurn` | 已实现（防误删校验） | Gateway fork adapter 校验 discarded range 全部属于指定 accepted-input turn；拒绝时使用稳定前缀 | `ForkSessionError` 的 invalid/mismatch 分支；源 transcript 保持不变 |
| `strictMcpConfig` | 已实现 | 任一 server error 终止配置；仅关闭本次调用新启动的 SDK-hosted server | strict/non-strict 代码路径与资源清理；错误不静默 |
| `loadTimeoutMs` | 已实现 | 初始化 deadline 独立于 turn `timeoutMs`；超时关闭 transport 和 SDK-owned hook/MCP 资源 | SDK contract：初始化超时为 typed `timeout`，不自动重放 turn |
| `permissionPrompts: "none"`、`dontAsk` | 已实现 | `canPrompt=false` 走原生 fail-closed deny；不改变 native permission mode | Permission 定向测试：不挂起、不 fail open |
| `acceptEdits` | 已实现 | 仅 `write_file`、`edit_file`、`edit_notebook` 的 workspace-safe 路径自动 allow；Bash/MCP 和 workspace 外路径仍走原生规则 | Permission 定向测试：文件编辑放行，其他工具和外部路径不放宽 |
| `includeHookEvents` | 已实现 | `HookExecutionEventBus` 的 started/response 投影为 Gateway `hook_started`/`hook_response`，SDK 映射为 `hook.*` | 开关由 session config 控制；HookRuntime effect/终态仍由原生生命周期负责 |
| custom/数组 `systemPrompt`、`planModeInstructions` | 已实现 | SDK 规范化字符串、数组和 custom prompt；plan instructions 仅传入 native plan mode | SDK serialization/typecheck；未传字段仍走原生默认路径 |

### P1：Gateway 持久化和生命周期（功能开发已完成；无待实现功能）

本表记录已接通的 SDK 切片及其已完成验收。一个切片只有具备 public type/façade、Gateway wire contract 和对应测试时才计入“当前已实现”；本轮已完成表中列出的真实 Gateway、重启或隔离验收。alpha/experimental 升级为稳定 npm 发布仍需 Phase 7 的发布矩阵，不构成 P1 待实现能力。

| 能力 | 状态 | 当前基础 | 边界与发布回归 | 验收重点 |
|---|---|---|---|---|
| 跨 Gateway 重启 checkpoint 恢复 | **已实现（experimental）** | `FileHistoryStore`、backup/restore、`file_snapshot_recorded`、post-edit fingerprint、`replayFromTranscript()`、Gateway lazy `rewind_files`、SDK `rewindFiles()` | 保持 100-snapshot retention/GC 与 legacy 无 fingerprint snapshot 的兼容策略；不把 checkpoint ownership 移入 SDK | 真实 `createLocalGateway`：AgentLoop 写文件后销毁/重启 Gateway，直接 dry-run/rewind；外部修改返回 `conflicts` 且不覆盖；缺失 backup 不改动 workspace；restore 用同目录临时文件 + 原子 rename |
| Output Style 选择与独立 reload | **已实现（experimental）** | `PluginLoader`/`PluginRuntime` registry，Gateway `output_styles_list`/`set_output_style`/`reload_output_styles`，SDK `outputStyles()`/`setOutputStyle()`/`reloadOutputStyles()` | 保持对旧 Gateway 的 `unsupported_capability` 降级；将 style 变更与 extension watcher 的全量项目刷新区分开 | 真实项目 plugin E2E 验证初次 load、namespace 稳定、V1/V2 在下一 runtime 构造时切换；PluginRuntime 测试验证 reload 不重载 command contribution |
| usage/modelUsage/cost | **Gateway aggregate、逐模型 API、cost provenance、usage retention、per-turn budget 与带 retention 的 session/project task budget 已实现** | `CanonicalUsage`、Router `TokenStatsCollector` 的 durable `perModelUsage` aggregate、Gateway `usage_snapshot`/`model_usage_snapshot`、SDK `usage()`/`modelUsage()`、`maxBudgetUsd`、`taskBudget.total`。每个 aggregate 的 `costSources` 计数明确 provider reported、configured price、built-in/fallback estimate 和 legacy unknown；Gateway host 的 `router.stats.retentionMs` 可选地按毫秒窗口筛除过期 JSONL record 并保留 atomically compacted journal | 调整 retention 期限是 Gateway host configuration，不由 SDK 自行累积或重写；缺省保持历史 append-only 行为 | 多模型、cache token、stats JSONL 重建、重连和 resume 后累计口径正确；SDK 不会把 estimate 伪装为精确账单；过期 record 不出现在 Gateway snapshot，重启后仍不重现；task budget restart 不依赖 Router stats，project scope 跨 SDK sessions 共享总额，retention reset 不由 SDK 客户端累计或触发 |
| `maxBudgetUsd` | **已实现（experimental，per-turn）** | SDK `PilotDeckOptions.maxBudgetUsd`、Gateway `submit_turn`、`AgentSession`/`TurnRunner`/`AgentLoop`、Router `TokenStatsCollector.estimateCost()` | 定义跨 turn/session 预算是否需要独立 API；补多 provider/native cost/price-table 精度边界 | 不由客户端轮询；每次模型调用后、任何恢复或工具副作用前停止；`agent_max_budget_reached` 与 `max_budget` 明确终态 |
| `taskBudget.total` | **已实现（experimental，带 project retention 的 session/project scope）** | SDK 将正 USD total、可选 `scope` 和仅 project scope 允许的 `projectRetentionMs` 放入 `sdkSessionConfig`；默认 `session` 以 `projectRoot + sessionKey` 键控，`project` 将同一 Gateway project 的 sessions 合并到一个 durable ledger。Gateway 在 turn 开始前读取已消费金额，并把它传入 `AgentSession`/`TurnRunner`/`AgentLoop`；完成的 turn 将 AgentLoop 实际记账成本以 `runId` 幂等写入 ledger。达到阈值后，ledger 以同目录临时文件和原子 rename 重写为 snapshot，保留 spent cost、project total、retention contract 和 settled `runId`。session scope 的 Router aggregate 仅作补充，snapshot 取两者较大值 | 保留期的语义已固定为“首次配置 contract + 创建/settled spend activity + 到期后下一次配置重置”，未配置时永久保留；费用数值的来源由 usage/modelUsage `costSources` 明确标记 | 第一模型调用跨限时在工具、副作用和恢复前停止；后续 turn 不创建 native session、不发模型请求，返回 `agent_task_budget_reached`/`task_budget`；stats-disabled Gateway restart 仍拒绝下一 turn；project scope 跨 SDK session 共享余额；retention 到期后重启 Gateway 仍能从新的 period 花费；SDK 仅传 `total`/retention，从不上传 spent/cost |
| 完整 `AgentDefinition` | **部分实现：基础字段、model、fork-local MCP/skills/memory、initial prompt、critical reminder、background、observer** | 已支持 prompt/tools/maxTurns/effort/permissionMode；`model` 由 Gateway model catalog 解析成唯一可用 provider/model，并作为 `SubagentDefinition.modelOverride` 优先于原生 subagent default；`mcpServers` 兼容 legacy server map，也接受 Claude 形状的 `("tickets" \| { docs: config })[]`：字符串只可引用当前 SDK session 中已启用的 MCP endpoint，Gateway 在 native child 创建前克隆其 config；inline map 仍是 fork-local config。child registry 的 `McpRuntime` 独立连接并随 fork 关闭，plugin/config-owned MCP 不进入该引用名空间；`skills` 只能缩小父 scope 且同时限制 prompt/`read_skill`，`memory: "disabled"` 停用 child retrieval/capture；`initialPrompt` 仅在 directive 前加入 child user message，`criticalSystemReminder_EXPERIMENTAL` 仅追加到 child system prompt；`background: true` 经 Gateway task registry 启动 child AgentLoop，立即返回 task id，不等待 fork 完成；`observer: "<agent-name>"` 在 child 完成后以 Gateway-owned、无工具、read-only sidechain 运行目标定义，`observerMessage` 追加到其限长 digest | Claude experimental callback 仍须定义有 PilotDeck ownership 的语义，或持续返回 `unsupported_capability`；background/observer 均需维持取消、timeout、runtime invalidation 与 transcript 回归。不存在或已禁用的 MCP reference 在 native session 创建前分别返回 `SDK_AGENT_MCP_REFERENCE_NOT_FOUND` / `SDK_AGENT_MCP_REFERENCE_DISABLED` | 子 Agent MCP 不泄漏到 parent；字符串引用会在 fork 前快照解析，随后 parent MCP 的 toggle/reconnect 不会改写 active child；技能不能扩权；禁用 memory、initial prompt 和 critical reminder 都不影响 parent；模型未声明时仍走原生 default/parent 继承；父 session 权限不被放宽；background child 在父 turn 后继续、只允许 owning session stop、sidechain transcript 完整；observer report 不进入 parent context 或用户 background task 控制面 |
| `Options.skills` / `Options.plugins` | **已实现（experimental）** | SDK `PilotDeckOptions.skills`/`.plugins`、Gateway `sdkSessionConfig`、`PluginRuntime.createView()`、session 构造边界 | `skills: string[] | "all"` 由 Gateway 以当前项目目录解析为唯一 canonical name，列表仅筛选 session 的 prompt 投影和 `read_skill`；未知/歧义项在创建原生 session 前失败，`"all"`/省略沿用原生技能面。`plugins` 只接受 absolute Gateway-local directory，Gateway 使用独立 read-only view 加载 manifest/contributions；commands、skills、hooks、output styles 与 plugin MCP 不会修改 project PluginRuntime 或其他 session，plugin MCP 随 owning session 的 runtime 停止 | 保持插件目录快照、MCP name conflict 和 session cleanup 回归；远程调用方必须自行确保路径在 Gateway host 可见，`pluginDelivery: "argv"` 继续显式不支持 |
| SDK async hook result | **已实现（experimental，context-only）** | SDK `HostedHookServer` 为 `{ async: true }` 回调返回 `asyncHookId`；`Query.submitAsyncHookResult()`、Gateway `WsConnection` 和 `RemoteGateway.submitAsyncHookResult()` 都以同一 `hook_async_result` RPC 交给 Gateway。Gateway 按 session/run 登记 invocation，拥有 deadline、turn-end cleanup 和短期幂等 outcome。显式 SDK `FileChanged` 配置在 native file write 后用独立 runtime 发射，复用该注册与回传路径 | 保持 native hook parity；除 `hookSpecificOutput.additionalContext` 外的 deferred effect（input rewrite、block、permission、system message 等）继续返回 `UNSUPPORTED_ASYNC_HOOK_EFFECT`，不得在 SDK 客户端补造 | 正常提交只注入一次 active-turn context；重复为 `duplicate`；deadline 或 turn 结束为 `expired`；未知 id 为 `unknown`；迟到结果不改变 native lifecycle action 或已完成 turn。真实 `createLocalGateway` E2E 已覆盖 FileChanged callback payload、`hook_started`/`hook_response` stream，以及写入后异步 context 在下一次可构造模型请求中只注入一次 |
| SDK-hosted hook 终态与 Gateway lifecycle | **已实现（experimental）** | `Query` 在收到 `turn_completed` 或终态 error 时保留 SDK HTTP hook host，直到 Gateway stream 真正关闭；因此 native `SessionEnd` 仍可调用 host callback 并投影 `hook.started`/`hook.response`。`ConfigChange` 由 Gateway `PilotConfigStore` reload 触发，并仅对显式注册该 SDK hook 的存活 session 使用独立 lifecycle 分发；其 callback output 不参与配置 reload、runtime invalidation 或 AgentLoop 决策。`Notification`、`CwdChanged` 与 `WorktreeCreate`/`WorktreeRemove` 都没有 per-query Gateway lifecycle emitter：后两者只属于 Always-On workspace runtime，SDK 会在建 host 时明确返回 `unsupported_capability` | 保持 callback host 只服务当前 query；显式 `close()`/abort 仍按取消语义关闭 host，不伪造未完成的 lifecycle 回调。`ConfigChange` 不得激活 project hook 或改变未携带 SDK hook 的原生配置 reload | SDK unit 覆盖不适用事件拒绝；真实 WebSocket Gateway E2E 覆盖 `SessionEnd` callback、`ConfigChange` 的 `changedPaths`/`changeClasses` payload、`hook.*` 投影和终态后资源清理 |
| Context usage 分类 | **已实现（experimental）** | `TokenAccountingRuntime.estimateRequestBreakdown()`、Gateway `context_budget`、SDK `Query.getContextUsage({ detail: "full" })` | Gateway 对实际 prepared request 以本地 tokenizer 输出 additive 的 system/tools/messages/MCP/memory 分类；provider 的 exact 总量不用于伪造分类 | token-accounting unit、Gateway event mapping、SDK transport contract 和真实 `createLocalGateway` 黑盒均验证；旧 Gateway 或 `summary` 返回 `breakdownAvailable: false` |
| `persistSession: false` | **已实现（experimental）** | SDK 将字段放入 `sdkSessionConfig`；Gateway 在 session 创建时选择 `InMemoryTranscriptWriter` 和系统临时 artifact root；SDK 终态仍发 `delete_session` 作提前清理 | 保持不可 resume/fork/list/read transcript 的 ephemeral 语义；进程崩溃后仅可能残留系统临时文件，不会留下项目 transcript | SDK transport contract；真实 `createLocalGateway` 在创建、turn 完成和 `delete_session` 后均验证 project JSONL 不存在；持久 session 回归保持原路径 |
| 可恢复 SessionStore / transcript | **client-mirror recovery 与 Gateway portable archive/restore 已实现（experimental）** | SDK `SessionStore`、`InMemorySessionStore`、`FileSessionStore`、summary fold/import，以及 `exportSessionTranscript()`/`restoreSessionTranscript()` 和 `client.sessions.exportTranscript()`/`.restoreTranscript()`。`FileSessionStore` 使用 schema version 1 snapshot、同目录 atomic rename、UUID 去重、进程内串行写入，并公开 `exportSession()`/`importSession()`；Gateway archive 是单独的 schema v1 `portable_text_messages` protocol | 维持 archive schema/version、size limits、fresh/inactive target 冲突和 Gateway restart 回归；不把 FileSessionStore mirror 视为可回写 transcript，也不扩展归档到 checkpoint、artifact、sidechain、permission 或 active run | SDK wire contract 验证 export/new-session/restore；真实 Gateway WebSocket E2E 验证 source export、fresh target 原子 restore、重复 target 拒绝以及重启后下一 native AgentSession 读取已恢复文本上下文 |

### P2：高级能力和低优先级兼容（功能开发已完成；sandbox deferred）

本节记录已经接通的 P2 experimental 切片；没有当前实施中的 P2 功能。完整 host/OS-native sandbox 明确 deferred，不计入 P2 backlog，也不新增隐含 P2 待办。

- 已交付（experimental）：form dialog 的标准 Draft 2020-12 本地 validator slice，以及 Node 终端、browser-native 与 framework-free DOM renderer。显式 `$schema: "https://json-schema.org/draft/2020-12/schema"` 时，Gateway 使用 Ajv 进行本地 schema 编译和 answer validation，支持当前 validator 配置覆盖的本地引用及 `unevaluatedProperties` 等已验证约束；外部 `$ref`、`$dynamicRef`、`$recursiveRef` 不会被 Gateway 获取而是 fail closed。`@pilotdeck/sdk` 的 `createTerminalUserDialogHandler()` 可直接作为 `onUserDialog` callback，处理 input/select/confirm，并按字段收集 form；简单 scalar/enum/object/local `$ref` 直接提示，composition 或未知 field 使用 JSON 输入。browser renderer 除原生窗口 fallback 外，允许 async custom renderer 直接消费 typed request/schema；`createDomBrowserDialogDriver()` 提供可挂载、可样式化的 native DOM form control。renderer 不创建 dialog state，Gateway 继续持有 request id、最终 schema 校验和 lifecycle。跨 Gateway 的持久化 state/renderer handoff 由下述 `GatewayUserDialogStore` live protocol 负责；owner 失联后只会产生 terminal recovery 和下一 turn context，绝不恢复旧 turn。未声明 `$schema` 的既有 form 继续使用 PilotDeck restricted subset。
- 已交付（experimental）：framework-free browser DOM dialog renderer。`createDomBrowserDialogDriver()` 可直接作为 `createBrowserUserDialogHandler()` 的 driver，`renderDomBrowserUserDialog()` 也可用于 manual live dialog。它在调用方提供的 `document`/`mount` 中创建可样式化的 DOM modal，并为 input/select/confirm 以及 form 的 string、number/integer、boolean、enum、object/递归 local `$ref`、`items` 数组和 `prefixItems` tuple 生成原生控件；数组可按 default、`minItems`/`maxItems` 预建和追加 typed item，未声明 `items` 的 prefix tail 用 JSON editor。无冲突 root/field `allOf` 会合并为 typed form，不含条件/否定约束的 `oneOf`/`anyOf` 提供 branch selector；`patternProperties`、其他 composition 与未知 field 回退为 JSON editor。对可编译 schema，bundled Ajv Draft 2020-12 会在本地显示结构性错误并保留 pending modal；SDK 无法编译的 Gateway-local extension 会跳过该预校验。它只产生标准 answer/cancel envelope，答案是否接受、pending state、取消和 turn 生命周期仍由 Gateway 唯一拥有；它既不读取 Gateway，也不保存或跨重启恢复 dialog state。
- 已交付（experimental）：terminal renderer 在提交前的 local form prevalidation。SDK 使用 bundled Ajv 编译可识别的 Gateway form schema；若 cross-field composition（如 `allOf`、`oneOf`、dependencies）失败，renderer 会重新收集整个 form，而不让 Gateway response 以 callback failure 结束。编译失败的 Gateway-local extension 会跳过本地预校验，故 Gateway 始终是唯一 final validator 和 lifecycle owner。browser-native renderer 则为 input/select/confirm 提供原生窗口驱动，并以 JSON object 收集 form；它不替代该 schema 预校验或 Gateway 最终验证。
- 已交付（experimental）：session-scoped `fallbackModel`。SDK 只传递非空模型目录引用；Gateway 负责校验和解析为唯一 `provider/model`，Router 负责本 session 的 retry/fallback 生命周期。主模型在可重试错误后且尚未产生可见内容时才回退，因此不会重放已流式输出的文本；未设置时不改变原生 Router 行为。
- 已交付（experimental）：`agentProgressSummaries`。显式为 `true` 时，Gateway 在 AgentLoop 的工具上下文注入瞬态 progress sink，并将已有 native tool progress 作为 `tool.progress` 传递给 SDK；最终工具结果、工具调度和 transcript 仍由原生模块拥有。该切片不是 Claude 的通用 progress/dialog 系统，未开启时不改变事件流。
- 已交付（experimental）：`forwardSubagentText`。默认 child 的 `text_delta` 继续通过兼容的 `agent_status/subagent_text_delta` 投影；显式为 `true` 时，Gateway 将已有 `SubAgentSession.forwardActivity()` 的 child text 以带 `subagentId`、`subagentType` 与 `runId` 的 `subagent_text_delta` wire event 发给 SDK，SDK 投影为 `subagent.message`。它不是 parent `assistant.message`，不会进入 `result().output`、parent transcript 或模型上下文；thinking delta 和子 Agent 的执行、sidechain transcript、调度、权限及 lifecycle 仍归原生宿主拥有。
- 已交付（experimental）：`onUserDialog`/`supportedDialogKinds` 的 native-elicitation adapter。省略 `supportedDialogKinds` 或显式声明 `elicitation` 时，SDK 复用既有 `elicitation_request`/`elicitation_respond` 的 request id、取消和 Gateway delivery 语义；若 `onUserDialog` 不声明 `elicitation`，它可与 `onElicitation` 共存。native elicitation 仍受原生 `canPrompt` 与 permission lifecycle 控制。
- 已交付（experimental）：扩展的受限 generic dialogs。`supportedDialogKinds` 会将 `input`、`select`、`confirm`、`form` 各自的 request-user tool 只注册到 owning SDK session 的 cloned ToolRegistry；`input` 和 `select` 回传字符串，select 只能回传该次声明的 option value，confirm 只能回传 boolean；`form` 回传通过 Gateway form-schema subset 的 object。该 subset 除 properties/`patternProperties`/required、items/`prefixItems` 和 enum 外，还校验 `const`、schema 型 `additionalProperties`、string length/pattern、`email`/`uri`/`uuid`/`date`/`time`/`date-time`、numeric minimum/maximum/exclusive/multipleOf、array length/uniqueItems、`contains`/`minContains`/`maxContains`、object property-count/`propertyNames`，以及有全局深度/节点、每分支 32 条和每个依赖映射 64 条限制的 `allOf`/`anyOf`/`oneOf`/`not`、`if`/`then`/`else`、`dependentRequired`/`dependentSchemas`。根 schema 可用至多 64 个简单命名 `$defs` 并以 `#/$defs/<name>` 复用；未知 definition、循环、外部 URI、任意 JSON Pointer、嵌套 `$defs`、未知 keyword 和 format 会在工具调用前明确拒绝。Gateway-owned bus 持有 request id、pending state、类型/option/schema 校验、abort/timeout/turn-end cleanup、active-turn replay filtering 和重复/迟到响应拒绝。默认 session 完全不注册这些工具；普通 tool result 照常持久化，不另建 dialog transcript。SDK 已提供 terminal、browser-native 与 DOM renderer convenience callback，但仍不支持全量、多宿主 JSON Schema UI 或持久化 dialog state。
- 已交付（experimental）：manual generic dialog resource。`userDialogMode: "manual"` 与 `supportedDialogKinds` 配合时抑制 SDK callback，保留 `user_dialog.requested` event；调用者可在同一 Query 用 `respondUserDialog()`，或以另一个 `createPilotDeckClient()` 连接调用 `client.dialogs.list({ sessionId })`/`.watch(...)`/`.claim(...)`/`.release(...)`/`.respond(...)`。`watch()` 通过 Gateway Server notification 为同一 session 投递 `requested`、lease 和 settled 的 best-effort change hint；通知不携带 lease token、不是 durable event log，漏通知、断线或重连后 renderer 必须 `list()` 获取权威快照。`createManualUserDialogRenderer()` 先注册 watch、再读取 list，并在获得 opaque lease 后自动续租、调用 caller renderer、回包或在 callback failure/close 时 release；它没有本地 pending-state ownership，也不会恢复旧 turn。`claim()` 为一个 live request 原子创建 1 秒至 5 分钟的 opaque renderer lease；list 只投影 `expiresAt`，不泄露 token。lease 存在时只有携带该 token 的答复可消费 request；持有者可续租或释放，过期后其他 renderer 可接手。lease 不影响 Gateway 的 abort、timeout 和 turn-end cleanup，它们仍能强制清理 native tool wait。Gateway `user_dialog_list` 返回 `GatewayUserDialogBus` 持有的 immutable pending request snapshot，Gateway 在 answer、abort、timeout 或 turn end 后删除它；persistent session 还会将 pending request 原子 journal 化。Gateway restart 后该 journal 被投影为 `gateway_restarted` terminal record：校验通过的 recovery answer 会作为 synthetic durable user message 写入，供下一次新 turn 读取，但不会恢复旧 AgentLoop、turn、dialog promise 或 active run。
- 已交付（experimental）：`promptSuggestions: true`。Gateway 在成功、非 abort 的 turn 完成后，使用原始用户 prompt 与最终 assistant 文本发起隔离的辅助模型请求；结果会在 `turn_completed` 前作为一次 `prompt_suggestion` 事件投递。建议文本不写入 transcript、不会回到模型上下文，也不构成 generic dialog；辅助请求超时或失败时静默省略建议，原 turn 的结果与终态不受影响。该实现不复制 Claude 的 parent-prompt-cache 行为。
- 已交付（experimental）：通用 deferred tool search。SDK-hosted `createSdkMcpServer({ alwaysLoad: false })` 或单个 `tool(..., { alwaysLoad: false, searchHint })` 仍会把 MCP metadata 与 Streamable HTTP endpoint 一并交给 Gateway；此外 `PilotDeckOptions.deferredTools: [{ name, searchHint? }]` 可按 canonical 名称延迟 native、plugin 或 MCP definition。Gateway 在 native/plugin/MCP 发现、organization/managed/sandbox policy、availability 及本 turn `allowedTools`/`disallowedTools` 收紧后合并两类目录，在首个 request 只向模型暴露 session-local `search_tools`。该工具按 name/description/`searchHint` 匹配并 reveal 命中的 definition，下一次 AgentLoop request 才获得实际 schema。空数组、重复名和保留 `search_tools` 会在 SDK/Gateway 边界拒绝；已被 policy 或显式工具集合排除的 target 不进入目录。若 `search_tools` 自身被显式排除，target 保持 hidden，绝不回退 eager。MCP connection、permission、ToolRuntime、scheduler 和 handler lifecycle 均不改变；模型绕过 search 直接调用隐藏名称会得到 `tool_not_found`。
- 已交付（experimental）：扩展的 Gateway-hosted `Query.updateSettings("localSettings", settings)`。公开 `PilotDeckLocalSettingsUpdate` 除 agent context/output/thinking 与 hook event 开关外，还支持 `agent.subagents.default`/`.timeoutMs`/`.maxDepth`、`extension.builtinPluginsEnabled` 和 `tools.webSearch.enabled`。`maxDepth: 0` 显式禁用 fork，`null` 清除配置；Gateway 以临时目录完整校验 `$PILOT_HOME/pilotdeck.yaml`，然后原子替换并通过 `PilotConfigStore.reload()` 触发原生 change class/runtime invalidation；SDK 不持有第二套配置状态。provider/model、凭据、web-search endpoint、任意 plugin path 和 managed source 仍显式不支持。
- 已交付（experimental）：`PilotDeckOptions.managedSettings` 的 restrictive policy 子集。它接受 session-scoped 的 `permissions.deny`、`permissions.ask`、`permissions.defaultMode: "plan"`、`permissions.canPrompt: false`，`tools.allow`/`.deny` 的 exact-name/`prefix*`/`*` selector，以及 `models.allow`/`.deny` 的 `*`、`provider/*`、`provider/model` selector；SDK 将其序列化为 Gateway `managedPermissions`/`managedTools`/`managedModels`。Gateway 将 deny/ask 编译为 `source: "policy"` 的原生 PermissionRule，并把 `canPrompt: false` 作为 native `PermissionContext` 的不可放宽限制；tool selector 则在 native、plugin、SDK MCP、deferred `search_tools` 和动态 AgentDefinition child MCP 全部合入后重复收紧模型可见 registry，deny 优先，不能注册工具、改变 handler 或绕过 organization policy/sandbox。model selector 同样 deny 优先，在 session config、显式 turn/session model、fallback、动态 subagent 和 Router fallback 的解析路径拒绝越界模型。session 构造不会因项目默认模型越界而抢在显式、允许的 per-turn `Options.model` 前失败；Router 仍在每个实际 provider 请求前拒绝未覆盖的默认模型及所有后续 fallback。permission policy 排在 session remembered allow 之前，`canPrompt: false` 也优先于普通 session override，因而 managed policy 不能被 remembered allow 或调用方 re-enable 绕过。它不提供 permission allow、provider 配置或凭据、文件 source、持久化或完整 settings cascade。
- 已交付（experimental）：Gateway embedding host 的 `createLocalGateway({ organizationPolicy })`。这是不经过 SDK/Gateway wire 的 host-only 组织策略层。`permissions`、`models`、`tools`、turn/token cap 和 `localSettings` write deny 都只会收紧现有原生路径。`settingSources.allow`/`.deny` 可控制远程 SDK 是否选择 Gateway-local `managed`、`user`、`project`、`local` source，deny 优先且在读取前拒绝。`settings.sessionDefaults`、`.managedSessionSettings`、`.sessionDefaultSources` 与 `.enforcedSessionSettings` 只作用于带 SDK marker 的 session；source 固定按 `managed < user < project < local` 合并，远程调用方不能移除或重排 host source。`organizationPolicy.providers` 增加 exact provider ID、credential-free HTTP(S) origin 与 non-secret credential-source 的 allow/deny：`environment`、`literal`、`provider_default`。它在 Gateway session selection、Router 和直接 ModelRuntime 调用三层拒绝，从而不会发出被拒 provider request；policy、API key、endpoint path 与环境变量名均不通过 SDK wire 暴露。未配置时所有既有 PermissionRuntime、Router、settings source 与 tool registry 行为不变。
- 已交付（experimental）：Gateway host 的 `organizationPolicy.limits.maxTaskBudgetUsd`。该正数 cap 在 `setSdkSessionConfig()` 接收时压低显式 `taskBudget.total`；新 SDK 对声明 `sdk_session_defaults` 的 host 发送空 marker，因此未显式设置 budget 的 SDK session 会获得 host total。直接 native Gateway 调用不携带 marker，不会被伪造为 SDK task budget。已存在的 project-scope durable ledger 仅在 host cap 更低时向下收紧，不能被 SDK 调用方抬高；session/run、spent cost、持久化和终止仍由 Gateway ledger 与 AgentLoop 共同拥有。

- 已交付（experimental）：Gateway-owned `PilotDeckOptions.settings`/`.settingSources` session overlay。`settingSources` 接受 Gateway-local `managed`、`user`、`project`、`local`，无论 SDK 传入顺序如何都按 `managed < user < project < local` 解析。`managed` 只选择 `organizationPolicy.settings.managedSessionSettings` 的 host-owned non-secret overlay；后三者分别对应 `$PILOT_HOME/pilotdeck.yaml`、`$PROJECT_ROOT/.pilotdeck/pilotdeck.yaml`、`$PROJECT_ROOT/.pilotdeck/pilotdeck.local.yaml`。Gateway 只提取 `agent.model`、`agent.fallbackModel`、`agent.maxContextTokens`、`agent.maxOutputTokens`、`agent.thinking`、`agent.subagents.default`、`.timeoutMs` 和 `.maxDepth`，显式 `settings` 最后覆盖。`maxDepth: 0` 禁止 subagent fork，任意值都受 host `organizationPolicy.limits.maxSubagentDepth` 收紧。embedding host 可在其之下提供同一 allowlist 的 `sessionDefaults`/`.sessionDefaultSources`，或以 `.enforcedSessionSettings` 在 source、SDK overlay、`Options.model`/`.fallbackModel` 和 `set_session_thinking` 后重写；host token cap 仍是最终限制。SDK 不能上传、读取或修改 managed 内容，直接 native Gateway 调用也不会继承 SDK overlay。provider 配置/凭据、plugin/path/tool 和 permission grant 均不会进入 session config；endpoint 与 credential source 只可由 host `organizationPolicy.providers` 约束。overlay 不写回配置文件、不改变其他 session、也不改变 AgentLoop/ToolRuntime/PermissionRuntime ownership。public SDK serialization、Gateway wire validation、model credential provenance unit test 与真实 Gateway E2E 已覆盖 managed-only、固定 precedence、host deny、explicit overlay、native-path 隔离以及 origin/credential deny-before-request。这就是 PilotDeck 的完整受控 managed settings/source cascade，不等同于远程 SDK 可写的 Claude settings 文件。
- 已交付（experimental）：`PilotDeckOptions.sandbox` 的 `tool_policy` 子集。`filesystem: "read_only"` 移除写入/编辑工具，`filesystem: "deny"` 移除全部 `kind: "filesystem"` 工具；两种 filesystem 模式都会移除可绕开的 shell/MCP/custom/code/task/subagent host bridge。`network: "deny"` 和 `process: "deny"` 也只收紧 owning session 的 model-visible ToolRegistry。
- 已交付（experimental）：named `sandbox: { type: "host", profile }`。SDK 只提交 profile 名；`createLocalGateway({ sandboxProfiles })` 在 Gateway host 查找 profile，并在该 session 用 profile 返回的 runner 替换原生 `bash`，也可在 `supportsExecuteCode: true` 时将 `execute_code` Python 交给同一 runner。`createBubblewrapSandboxProfile()` 是首个内置 host profile：它用 `bwrap` 创建空 root、最小只读 runtime mount、私有 `/tmp`、user/pid/ipc/uts/cgroup/network namespace，默认清空环境，并按需绑定 project workspace；Python 只获得该次私有 RPC 目录和 allowlisted runtime 环境。`filesystem: "read_only"` 将 workspace mount 改成只读，`filesystem: "deny"` 则保留在私有 `/tmp` 执行的 scratch process、完全不挂载 workspace。`execute_code` 在 read-only/deny/network-deny 组合还分别要求 profile 显式 `supportsFilesystemReadOnly`/`supportsFilesystemDeny`/`supportsNetworkDeny`；未声明即 fail closed 隐藏，且 Gateway 相应删除 write/edit、所有 filesystem、或 web helper RPC，避免 Python 回调绕过隔离。host profile session 仍隐藏未受 runner 控制的 MCP/custom/task/subagent bridge，`network: "deny"` 还隐藏 native network tool。profile 缺失、runner 无效或 cwd 越界均 fail closed；SDK 从不传 runner、executable、mount、环境或 credential 给远程 Gateway。它仍不隔离允许保留的原生 filesystem tool、provider、Gateway 进程或已启动基础设施，因此不是覆盖所有执行面的完整 SandboxSettings。
- 已交付（experimental）：strict host profile 的 opt-in `execute_code`。只有 profile 同时声明 `supportsExecuteCode: true` 与 `supportsStrictExecuteCode: true`（`createBubblewrapSandboxProfile({ enableStrictExecuteCode: true })`）时，`toolIsolation: "strict"` 会保留 Python；它仍必须通过 profile-owned runner 执行。Gateway 生成的 `pilotdeck_tools` 是无 socket、无 helper function 的空模块，RPC server 也以空 allowlist 拒绝 raw request，因此 Python 不能借 Gateway helper 返回原生 filesystem/network/MCP/process surface。未声明该 flag 的既有 profile 维持 strict 下只保留 Bash 的行为。此切片仍不隔离 provider、Gateway 进程或已启动基础设施。
- 已交付（experimental）：`@pilotdeck/sdk/embedded` 的 in-process Gateway transport、typed resource client、宿主组合与 SDK mirror storage adapter。`createEmbeddedGatewayEndpoint({ gateway, token })` 在宿主已有的权威 Gateway 上提供无 TCP listener 的内存连接，`createEmbeddedQuery()`/`startupEmbedded()` 与 `createEmbeddedPilotDeckClient()` 经 `PilotDeckEmbeddedTransport` 发出与 WebSocket client 相同的 wire frame，复用 `GatewayWsConnection` dispatcher 创建 Gateway-owned session、run 与 stream；client 同时提供 sessions/runs/projects/files/models/commands/skills/cron/config façade。共享 endpoint 只发送一次 hello；per-query transport close 只解除自身监听，client close 才关闭 endpoint。`createEmbeddedToolRegistry()` 则把 SDK `tool()` 描述转换为该 local Gateway 的原生 ToolRegistry definition；附着到 `updateSubsystems()` 后，register/unregister 会刷新未来 runtime。`createEmbeddedPilotDeckHost()` 将 client、可选 local registry 和 attachment 收敛到一个可关闭对象；关闭时只 detach registry 和关闭 SDK endpoint，不 dispose Gateway，也不再改写宿主当前 native tool configuration。`createEmbeddedSessionStore()` 接受 host-owned async snapshot persistence，复用 SDK mirror 的 schema 校验、UUID 去重、append 串行和可选 list/delete；它不触碰 Gateway transcript、checkpoint、artifact 或 active run。handler 从不经 callback-RPC 传输，仍由原生 ToolRuntime/PermissionRuntime/scheduler 执行。它们都不直调或拥有 AgentLoop、模型、permission、Gateway storage、sandbox 或 session state。
- 已交付（experimental）：Gateway host 的 `createLocalGateway({ nativeSessionStorage })` native layout adapter。adapter 显式提供稳定的 `getProjectChatDir()` 与每 session 的 native `AgentProjectSessionStorage`；create/resume/recreate、model/metadata、session list/message read、fork、last-turn replacement、portable export/restore、delete 与 checkpoint replay 都经同一 layout 解析。未提供 adapter 时保持原项目 JSONL 路径不变；adapter 不能由 SDK request 传入，也不能改变 AgentLoop、transcript、checkpoint、permission 或 session/run ownership。它不是 SDK event mirror，也不是异步数据库/object-store 实现。
- 已交付（experimental）：`createGatewayAsyncTranscriptStorageAdapter({ store })`。Gateway embedding host 提供原子 `store.append(key, entry)` 与 `store.read(key)`，adapter 让 primary 和 subagent `JsonlTranscriptWriter` 的 append 进入该结构化异步 store，并在 `resumeAgentSession`、runtime recreate、session model metadata、`rewindFiles()` 的 transcript replay、`client.sessions.messages()` 与 `getSubagentMessages()` 投影时读取同一 store；store 可选 `list` 返回 project session index，`has`/`delete` 接管 Gateway `listSessions`/`deleteSession`，`deleteSession` 则可在宿主侧一并清理 primary 与 sidechain payload，`replace` 接管 portable archive restore、transcript-only fork 与被 fork primary transcript 引用的递归 sidechain payload copy，未提供时分别保留历史 JSONL scan/stat/rm/atomic-rename 行为；external store 缺少 `replace` 时 Gateway 显式拒绝 restore/fork，不回写 JSONL。可选 `fileHistoryBackups` 把 native `FileHistoryStore` backup blob 的写入、跨 Gateway restart 的 `rewindFiles()` 读取、snapshot eviction、session delete cleanup 和 fork 所引用 backup 的复制交给 host store，同时 transcript 仍是 snapshot 元数据的权威。可选 `toolResultArtifacts` 以 `write/read/delete/deleteAll` 保存大文本和媒体 tool-result payload；Gateway 将 workspace `.pilotdeck/tool-results/` 保留为可重建的本地缓存，以维持 `read_file` 和媒体 materialization。重启时只会 materialize 当前 session 受控目录下的 transcript reference；fork 会复制被引用的 primary/sidechain blob 并重写目标 session reference，delete 会调用 `deleteAll`。若 store 同时提供 `prepareReplacement` 和 `finalizeReplacement`，Gateway 的 last-turn replacement 也在外部 store 内完成 pre-start rollback 与 accepted-input commit；可选、幂等的 `recoverReplacements` 会在读取 transcript 前调用，宿主必须用 owner/lease 等自身规则避免回滚仍活跃 Gateway 的 transaction。默认未配置时仍直接读写历史 JSONL。黑盒已验证：首个 Gateway 不落主 JSONL，关闭后新 Gateway 可恢复同一 session、投影两次 turn、读取 sidechain、列出、导出、fork、删除并 restore 该 session；另有测试覆盖 fork 的 child/grandchild sidechain payload copy、host-owned checkpoint backup 的 restart/rewind/delete、tool-result blob 的 restart/read_file/fork/delete，以及 dead-Gateway replacement recovery。该 adapter 覆盖当前 Gateway 的 durable transcript、checkpoint backup 与 tool-result payload；session、run、checkpoint 和 transcript 的状态所有权仍在 Gateway。
- 已交付（experimental）：Gateway-owned last-turn replacement SDK façade。`client.sessions.prepareLastTurnReplacement(sessionId, { expectedTurnId })` 与顶层 `prepareLastTurnReplacement()` 先让 Gateway 原子移除最新 accepted turn 并返回不透明 transaction；SDK 生成且固定 replacement `runId`，`start()` 只能创建一次使用该 id 的 run，或者调用者可在 run 真正开始前 `rollback()`。Gateway 在 replacement run 的 `input_accepted` 时自行 commit，提交失败或未启动则继续由 Gateway timeout/recovery 处理；SDK 不保存 transaction journal、不调用 commit，也不会改写 AgentLoop/session/transcript 语义。SDK fake contract 与真实 WebSocket Gateway 黑盒覆盖 run-id 绑定、pre-start rollback、accepted-input commit 和 backup cleanup。
#### 非排期技术差距（不计入 backlog）

| 技术差距 | 当前边界 | 后续前提 |
|---|---|---|
| 完整 host/OS-native `SandboxSettings`（deferred，当前范围不实施） | named `host` profile 已为原生 `bash` 和受 profile runner 执行的 `execute_code` Python 提供 Bubblewrap 进程边界；`filesystem: "read_only"`/`"deny"` 已 fail-closed 移除 Gateway 进程内 native filesystem tools 及 Python filesystem helper，避免绕过 profile mount。尚未将 MCP handler、provider 与已启动基础设施放入同一 OS boundary。 | 仅当另行立项时，对所有可执行面实施一致的宿主隔离、拒绝路径 fail closed、未配置保持原生语义，并以真实 Gateway 隔离 E2E 验收。 |

### 不进入实现 backlog

- `pathToClaudeCodeExecutable`、`spawnClaudeCodeProcess`、Claude CLI 的 executable/debug/stderr 控制；
- Claude account/login 语义的 `accountInfo()`；
- Claude Code system/tool preset；
- Claude provider-specific JSON mode；
- 没有 PilotDeck 原生事件或产品场景的 `MessageDisplay`、`TeammateIdle` 等 hook。

这些字段可以继续保留类型兼容，但运行时必须返回 `unsupported_capability`，不得返回占位成功。

## 5. 阶段总览

| 阶段 | 状态 | 目标 | 主要产物 |
|---|---|---|---|
| Phase 0 | 已完成 | 冻结边界和协议基线 | ownership、兼容策略、API 草案 |
| Phase 1 | 已完成 | 固化 Gateway SDK 契约 | wire schema、capabilities、错误和终态规范 |
| Phase 2 | 已完成 | 建立 SDK 包和 transport | package、WebSocket transport、handshake、typed errors |
| Phase 3 | 已完成 | 交付 Session + Run MVP | sessions、runs、event stream、result、abort/steer |
| Phase 4 | 已完成 | 完成交互与资源 API | permission、elicitation、messages、models、files、commands |
| Phase 5 | 已完成 | MCP 和工具控制面 | MCP config/status、SDK-hosted tools、tool allow/deny |
| Phase 6 | 已完成（P1；alpha experimental） | 可靠性、恢复与 Claude-like 兼容补齐 | reconnect、result_unknown、P1 durable checkpoint、compatibility matrix |
| Phase 7 | 进行中 | Alpha 验证并推进 Beta | `0.1.0-alpha.0`、安装黑盒、示例、迁移和真实应用验证 |
| Phase 8 | 部分交付（experimental） | Embedded SDK | 已交付 local tool registry、`createEmbeddedPilotDeckHost()` 宿主组合、`createEmbeddedSessionStore()` SDK mirror storage adapter、复用 Gateway dispatcher 的 in-process Query/WarmQuery transport 与 typed resource client；共享 Gateway host 还可通过 `nativeSessionStorage` 选择 native filesystem layout，或用 `createGatewayAsyncTranscriptStorageAdapter()` 将 transcript、file-history checkpoint 与 tool-result payload 接入 host store，并已有 named Bubblewrap Bash/`execute_code` sandbox profile；仍待完成完整 sandbox composition |

Phase 0--5 作为已落地基线保留在下文，便于追溯公共契约。后续排期不再按原始周数推进，而以 4.2 的 P0/P1/P2 和对应验收门槛为准。

## 6. Phase 0：边界与决策冻结

目标：在写 SDK 代码前，明确哪些是公共承诺，避免直接把 Gateway 内部类型重新导出。

### 工作项

- 确认 npm 包名和仓库目录；
- 确认只支持 Node.js，还是同时支持浏览器 transport；
- 确认第一版最低 Node.js 和 TypeScript 版本；
- 确认 Gateway protocol version 和兼容范围；
- 建立 session、turn、run、operation、permission、checkpoint ownership 表；
- 列出 SDK public API 与明确非目标；
- 定义 stable、experimental、internal 三种 API 稳定级别；
- 决定错误码、result_unknown 和 retryable 的公共语义；
- 决定用户认证信息如何传入，但不把凭证写入日志；
- 确定首个真实接入应用，作为设计合作方。

### 产物

- SDK Architecture Decision Record；
- public API 草案；
- Gateway capability 对照表；
- SDK/Gateway 兼容矩阵模板；
- 测试策略；
- 发布策略。

### 验收条件

- SDK、Gateway 和 Runtime 团队对 ownership 无冲突；
- 每个 Phase 3 MVP 方法都有 Gateway 对应能力；
- 删除、关闭、取消、abort、fork 和 resume 的语义已区分；
- 没有把内部 AgentLoop 类列入第一版 public exports。

## 7. Phase 1：固化 Gateway SDK 契约

目标：让 Gateway 协议足以支撑稳定 SDK，而不是由客户端解析不稳定的内部事件。

### 工作项

#### 7.1 Handshake 与能力协商

- 明确 hello/hello_ok；
- 固化 protocolVersion；
- 返回 Gateway capabilities；
- 返回服务端模式和支持的资源 API；
- 定义不兼容版本错误。

#### 7.2 Request/Response

- 每个请求具有唯一 requestId；
- response 必须关联原 requestId；
- 明确错误 envelope；
- 区分 validation、auth、not_found、conflict、timeout 和 server error；
- 明确 optional method 在服务端不支持时的行为。

#### 7.3 Stream 与终态

- stream event 包含 session、run、sequence；
- sequence 单调；
- 一个 run 只有一个最终结果；
- 重复 final 的幂等规则明确；
- transport close 不能代替 final；
- 无法确认结果时支持状态查询或 result_unknown；
- 明确 warning、notification 与业务 event 的区别。

#### 7.4 Permission 和 Elicitation

- request id、deadline 和 session/run identity 完整；
- response 幂等；
- 过期 decision 被明确拒绝；
- 没有处理器时 fail closed；
- permission 和 elicitation 使用不同 schema。

### 产物

- Gateway SDK wire schema；
- event 和 result schema；
- error code 表；
- capability 表；
- 至少一组完整成功、失败、取消和断线消息序列。

### 验收条件

- fake client 能完成 handshake、request、stream 和 final；
- 非法 identity、sequence gap 和重复 final 被检测；
- 所有 MVP 方法可以通过协议表达；
- Gateway 不要求 SDK 读取 transcript JSONL 或内部数据库。

## 8. Phase 2：SDK 包骨架与 Transport

目标：发布一个尚未包含完整资源 API，但连接和协议层可靠的内部开发包。

### 建议目录

~~~text
packages/sdk/
  package.json
  tsconfig.json
  src/
    index.ts
    client.ts
    errors.ts
    types.ts
    transport/
      websocket.ts
      connection-state.ts
      reconnect.ts
    protocol/
      wire-types.ts
      encode.ts
      decode.ts
      capabilities.ts
    internal/
      request-router.ts
      stream-router.ts
  test/
~~~

### 工作项

- 建立 package、build、typecheck 和 test；
- 定义 package exports；
- 实现 WebSocket transport；
- 实现 connection state；
- 实现 hello/capability negotiation；
- 实现 request router；
- 实现 pending request 清理；
- 实现 typed error；
- 实现 client.close；
- 加入 AbortSignal 和 request timeout；
- 日志支持 requestId，但默认不输出 token 和输入正文。

### 首批 public API

~~~ts
createPilotDeckClient(options): PilotDeckClient

interface PilotDeckClient {
  connect(): Promise<void>;
  describeServer(): Promise<ServerInfo>;
  close(): Promise<void>;
}
~~~

### 验收条件

- package 可以从打包产物安装；
- connect 和 close 幂等；
- handshake 前不会发送业务请求；
- auth 或 protocol failure 不无限重连；
- pending request 在 close 时得到明确错误；
- public exports 不依赖 monorepo 私有路径。

## 9. Phase 3：Session + Run MVP

目标：完成最核心的人类接入路径。

### 9.1 Session Resource

~~~ts
interface SessionsResource {
  create(input: CreateSessionInput): Promise<Session>;
  get(sessionId: string): Promise<Session>;
  list(input?: ListSessionsInput): Promise<Page<SessionSummary>>;
  resume(sessionId: string): Promise<Session>;
  fork(sessionId: string, input?: ForkSessionInput): Promise<Session>;
  close(sessionId: string): Promise<void>;
}
~~~

注意：

- close 不得命名为 delete；
- resume 不得在找不到 session 时静默新建；
- fork 必须说明 transcript、文件和模型状态复制范围；
- SDK 返回公共 Session 类型，不直接返回 GatewaySessionInfo。

### 9.2 Run Resource

~~~ts
interface RunsResource {
  start(input: StartRunInput): RunHandle;
  get(runId: string): Promise<RunSnapshot>;
}

interface RunHandle {
  readonly id: string;
  readonly sessionId: string;

  events(options?: { signal?: AbortSignal }): AsyncIterable<PilotDeckEvent>;
  result(options?: { signal?: AbortSignal }): Promise<PilotDeckResult>;
  steer(input: PilotDeckInput): Promise<void>;
  cancelSteer(): Promise<void>;
  abort(reason?: string): Promise<void>;
}
~~~

### 9.3 Public Events

首版事件至少包含：

- session.started；
- turn.started；
- model.delta；
- assistant.message；
- tool.started；
- tool.progress；
- tool.completed；
- tool.failed；
- permission.requested；
- elicitation.requested；
- compaction.started/completed；
- subagent.started/completed/failed；
- warning；
- retry.progress；
- turn.completed；
- turn.failed；
- session.ended。

### 9.4 Public Result

~~~ts
type PilotDeckResult =
  | { status: "completed"; output: unknown; usage?: Usage; artifacts?: Artifact[] }
  | { status: "failed"; error: PilotDeckRunError; usage?: Usage }
  | { status: "aborted"; reason?: string; usage?: Usage }
  | { status: "result_unknown"; recovery?: RecoveryHint };
~~~

### 验收条件

- 一个最小示例能创建 session、提交 turn 并收到 completed；
- tool lifecycle 可以完整消费；
- abort 返回 aborted，而不是普通 failure；
- transport 中断时不会误报 completed；
- events 和 result 可重复消费的规则已定义；
- RunHandle.result 多次调用返回相同不可变结果；
- Gateway 与内部 AgentEvent 的转换有单元测试。

## 10. Phase 4：Permission、Elicitation 与资源 API

目标：让 SDK 可用于真实交互式应用。

### 10.1 Permission

~~~ts
client.permissions.onRequest(async request => {
  return request.allow({ scope: "once" });
});
~~~

需要支持：

- allow；
- deny；
- reason；
- once；
- session grant；
- timeout；
- duplicate response；
- expired request；
- handler error。

### 10.2 Elicitation

~~~ts
client.elicitation.onRequest(async request => {
  return {
    answers: await renderQuestions(request.questions),
  };
});
~~~

要求：

- 与 permission 类型分离；
- 支持取消；
- canPrompt=false 时不得无限等待；
- request 与 session/run/tool call 关联。

### 10.3 资源 API

首版加入：

- sessions.messages；
- sessions.subagentMessages；
- projects.list/get；
- files.list/read；
- models.list/get/set/clear；
- commands.list；
- skills.list/read；
- config.reload；
- extensions.reload。

### 验收条件

- 人工 allow 和 deny 都有真实 Gateway 集成测试；
- 无 handler、超时和异常路径 fail closed；
- transcript 不要求调用者解析 JSONL；
- 模型切换与 run 使用的模型可验证；
- 不支持的 optional capability 返回明确 UnsupportedCapabilityError。

## 11. Phase 5：MCP 与工具控制面

目标：支持应用配置工具能力，并交付 Claude Code SDK-like 的本地 handler MCP 接入；不在 Gateway WebSocket 上执行或传输任意 JavaScript handler。

### 第一版 MCP API

~~~ts
interface McpResource {
  list(): Promise<McpServerInfo[]>;
  register(input: RegisterMcpServerInput): Promise<McpServerInfo>;
  reconnect(name: string): Promise<void>;
  setEnabled(name: string, enabled: boolean): Promise<void>;
  remove(name: string): Promise<void>;
}
~~~

支持的 provider：

- stdio；
- HTTP/streamable HTTP；
- 现有 PilotDeck 支持的其他 MCP transport；
- plugin 提供的 MCP server 只读展示。

### 工具控制面

- 查询当前可用工具；
- 配置 allow/deny；
- 接收 tool lifecycle；
- 展示 tool schema 和 annotations；
- 处理 permission；
- 读取 MCP status 和 error；
- 明确工具实际运行位置。

### Claude-like SDK handler MCP

~~~ts
const tickets = createPilotDeckMcpServer({
  name: "tickets",
  tools: [tool("find_ticket", "查询工单", schema, findTicket)],
});

const run = query({
  prompt: "查询 PDX-123",
  options: { mcpServers: { tickets } },
});
~~~

实现通过标准 `streamable_http` MCP transport 使 Gateway 调用 SDK 调用者进程中的 handler。SDK 要负责 endpoint start/close、可达地址校验、JSON-schema 与 MCP tool schema 映射、handler abort/error 映射；Gateway、MCP runtime、ToolRegistry、scheduler 和 PermissionRuntime 继续拥有工具发现、审批与实际 agent-loop 生命周期。

这个阶段不实现 `client.tools.register({ execute })` 这类绕过 MCP 的远程 callback RPC；该 API 只能作为未来 Embedded SDK 的独立能力考虑。

### 验收条件

- 能注册 MCP server 并完成一次 tool call；
- MCP connection failure 有稳定 error；
- 工具结果正确进入 Agent Loop；
- permission denial 不执行工具；
- MCP 配置变化不会覆盖 plugin-owned server；
- tool event 不暴露不稳定的内部 handler 对象。

## 12. Phase 6：可靠性、恢复与兼容性

目标：从“能运行”提升到“可以在真实应用中长期运行”。

### 12.1 重连

- 指数退避和抖动；
- 最大重试策略；
- auth failure 不重试或有限重试；
- protocol failure 不重试；
- close 后停止重连；
- 网络恢复后重新 handshake。

### 12.2 Run 恢复

- reconnect 后查询 active run；
- 支持服务端 cursor/sequence 时恢复事件；
- 检测 replay duplicate；
- 检测 sequence gap；
- 无法确认终态时返回 result_unknown；
- 不自动重放可能产生副作用的 submit。

### 12.3 幂等和并发

- request id 唯一；
- permission response 幂等；
- final 只 resolve 一次；
- cancel/abort race 有定义；
- 同一 session 多 run 的允许规则明确；
- client close 与 pending operation race 有测试。

### 12.4 兼容矩阵

至少验证：

| SDK | Gateway | 预期 |
|---|---|---|
| 当前 | 当前 | 完整支持 |
| 当前 | 上一支持版本 | 降级或完整支持 |
| 上一 SDK | 当前 Gateway | 新增可选能力不破坏 |
| 不兼容版本 | 任意 | handshake 阶段明确失败 |

### 12.5 Claude-like P0 兼容收口（已完成）

本提交已完成 4.2 中 P0 能力的 SDK/Gateway 适配：

- session 创建、fork 和指定 transcript 边界恢复；
- `dontAsk`、`acceptEdits` 和禁止 prompt 的保守权限映射；
- strict MCP 初始化与独立加载超时；
- hook execution event stream；
- custom system prompt 形状和 plan instructions。

这些适配写入 session-scoped、默认关闭的 Gateway 配置。调用者没有传入对应选项时，原生 prompt、权限、工具集合和 transcript 保持原路径。

### 12.6 Durable recovery

checkpoint 恢复不能依赖 SDK 客户端缓存。Gateway 必须持久化并恢复：

- checkpoint 与 session、user message、project root 的稳定关联；
- 文件路径、备份文件名、版本、mode、时间和冲突检测信息；
- 完整提交标记及损坏记录诊断；
- session 重建时的索引 replay；
- 锁、最大保留数、备份 GC 和 session 删除清理。

SDK 的职责仅是声明 `enableFileCheckpointing`、调用 dry-run/rewind 并呈现 Gateway 的明确结果。

### 验收条件

- 故障注入测试覆盖断线、延迟、重复、乱序和丢帧；
- SDK 不会因未知非关键事件崩溃；
- SDK 遇到未知终态会失败并保留诊断；
- compatibility matrix 在 CI 中执行；
- 长时间连接 smoke test 通过。
- P0 每个选项已有 fake Gateway/SDK contract 测试；真实 Gateway 黑盒和 parity 测试继续作为 Phase 7 的发布门槛；
- checkpoint restart E2E 已覆盖正常恢复、备份缺失和 workspace 外部修改；后续保持重复 rewind、100-snapshot GC 和 legacy snapshot 的回归覆盖；
- 未携带新增 SDK 配置时，AgentLoop parity 的 prompt、工具顺序、权限结果、终态、transcript 和副作用次数不变。

## 13. Phase 7：Alpha、Beta 与稳定发布

### 13.1 Internal Alpha

版本建议：0.1.0-alpha.x。

目标：

- 由一个 PilotDeck 官方应用接入；
- API 可以调整；
- 收集真实事件、权限和断线问题；
- 不承诺长期兼容。

必须完成：

- basic-run；
- streaming-events；
- permission-handler；
- resume-session；
- fork-session；
- abort-run；
- mcp-server 示例。

### 13.2 Public Beta

版本建议：0.1.0-beta.x。

目标：

- 至少两个独立应用接入；
- public API 基本冻结；
- 兼容矩阵和迁移说明建立；
- 开始执行 deprecated policy。

Beta 门槛：

- 无已知会误报成功的错误；
- 无 permission fail-open；
- 断线恢复或 result_unknown 行为稳定；
- package 安装和 examples 从 dist 运行；
- API reference 完整。

### 13.3 Stable 1.0

1.0 不应只按时间发布，应同时满足：

- Session/Run/Event/Permission API 稳定；
- Gateway protocol 支持范围明确；
- 至少一个长期运行的生产接入；
- major/minor/patch 策略已执行过；
- public exports 无 internal 类型泄漏；
- 文档、示例、错误码和迁移指南完整；
- 安全和凭证边界经独立评审；
- 上一版本有清晰回滚方案。

## 14. Phase 8：Embedded SDK

目标：为高级用户提供不开放网络 listener 的进程内 SDK 接入，并逐步补齐可复用的宿主组合；权威 Gateway 仍是 session、run、permission、transcript 和工具副作用的唯一所有者。

当前已交付 `createEmbeddedGatewayEndpoint()`、`PilotDeckEmbeddedTransport`、`createEmbeddedQuery()`、`startupEmbedded()`、`createEmbeddedPilotDeckClient()`、`createEmbeddedToolRegistry()`、`createEmbeddedPilotDeckHost()` 和 `createEmbeddedSessionStore()`。前五者把 Query/WarmQuery 与完整 typed resource client 接入现有 Gateway 的常规 wire dispatcher，registry 注册 local Gateway 工具；`createEmbeddedPilotDeckHost()` 将 client、可选 local tools 和 registry attachment 组合成可关闭 surface，关闭只 detach SDK registry/endpoint，不 dispose host Gateway；`createEmbeddedSessionStore()` 则使用宿主提供的 snapshot persistence 保存 SDK event mirror，不写 Gateway transcript/checkpoint。需要指定 Gateway-native filesystem layout 时，宿主在 `createLocalGateway()` 处提供 `nativeSessionStorage`；要把 primary/subagent transcript 接入 DB 或 object store，可把 `createGatewayAsyncTranscriptStorageAdapter({ store })` 作为该 host adapter。store 的可选 `list`/`has`/`delete`/`deleteSession`/`replace` 接管 session list/delete、portable archive restore 和包含递归 sidechain payload 的 transcript-only fork；`fileHistoryBackups` 接管 checkpoint backup blob 的写入、重启后 rewind、eviction、session delete 和 fork copy；`toolResultArtifacts.write/read/delete/deleteAll` 保存大文本和媒体 tool-result payload，并在重启时重建仅供 `read_file` 与媒体 materialization 使用的 workspace cache；fork 会复制被引用 payload 并重写 target reference，delete 会清理 session payload。`prepareReplacement`/`finalizeReplacement`/`recoverReplacements` 接管 last-turn replacement 的 rollback、commit 和 dead-Gateway recovery，owner/lease 判定仍由 host store 负责。SDK 不暴露 host storage handle，Gateway 仍是 session、run、checkpoint 和 transcript 语义的唯一所有者；这些能力不绕过 Gateway 或直接运行 AgentLoop。

### 可能 API

~~~ts
const endpoint = createEmbeddedGatewayEndpoint({ gateway: local.gateway, token });
const embedded = createEmbeddedPilotDeckHost({
  connection: { endpoint, token },
  gatewayHost: local,
  localTools: [tool("lookup_incident", "Read incident data", schema, handler)],
  projectKey,
});
const run = embedded.client.query("Summarize the incident.");
await embedded.close(); // Does not dispose `local`.
~~~

### 必须先解决的问题

- host/OS sandbox；
- local model/provider、MCP、hooks/plugins/skills 的显式宿主配置；
- endpoint close、资源清理与 failure/abort 的长期运行回归；
- 与远程 Gateway SDK 公共类型的一致性。

### Embedded 发布门槛

- 不要求用户直接 new AgentLoop 或 TurnRunner，且 SDK 不得绕过 Gateway dispatcher；
- 默认 permission 不 fail open；
- 本地 handler 支持 AbortSignal、timeout 和 typed result；
- 内存与文件 storage 都有测试；
- 与 Gateway 模式跑相同的 Agent Loop contract suite；
- 作为独立 export 发布，不增加 Gateway 用户 bundle。

## 15. 并行工作流

可以并行开展四条工作流，但公共类型必须统一评审。

### Workstream A：Protocol/Gateway

负责：

- capability；
- wire schema；
- error/result；
- stream identity；
- resume/status；
- compatibility。

### Workstream B：SDK Core

负责：

- package；
- transport；
- client；
- resources；
- event mapper；
- typed errors；
- public exports。

### Workstream C：Runtime Integration

负责：

- AgentEvent 到 GatewayEvent；
- permission/elicitation；
- transcript/messages；
- usage/artifacts；
- MCP/tool lifecycle。

### Workstream D：Quality/Developer Experience

负责：

- fake Gateway；
- contract tests；
- compatibility CI；
- examples；
- API reference；
- migration；
- prerelease 验证。

推荐依赖顺序：

~~~text
Protocol contract
  -> SDK transport
     -> Session/Run
        -> Permission/Resources
           -> MCP
              -> Reliability
                 -> Beta
~~~

Runtime Integration 和测试框架可以从 Phase 1 开始并行。

## 16. 建议的 Epic 拆分

Epic 1--9 已形成当前 alpha 基线，保留如下用于追溯；新增工作从 Epic 10 开始。

### Epic 1：SDK Contract

- ADR；
- ownership；
- public types；
- error/result；
- capability；
- versioning。

### Epic 2：Connection

- WebSocket transport；
- handshake；
- request router；
- close；
- timeout；
- diagnostics。

### Epic 3：Sessions

- create/get/list；
- resume；
- fork；
- close；
- messages/subagent messages。

### Epic 4：Runs

- start；
- events；
- result；
- steer；
- cancel steer；
- abort；
- active snapshot。

### Epic 5：Interaction

- permission；
- session grant；
- elicitation；
- AskUserQuestion；
- headless behavior。

### Epic 6：Resources

- projects；
- files；
- models；
- commands；
- skills；
- extensions/config reload。

### Epic 7：MCP

- list/register/remove；
- reconnect；
- enable/disable；
- tool catalog；
- tool events。

### Epic 8：Reliability

- reconnect；
- resume；
- sequence；
- idempotency；
- compatibility；
- fault injection。

### Epic 9：Release

- package；
- changelog；
- examples；
- reference；
- migration；
- alpha/beta publishing。

### Epic 10：Claude-like P0 Compatibility（已完成）

- title、transcript-boundary resume、strict MCP、load timeout、`dontAsk`、`acceptEdits`、禁止 permission prompt、hook events、custom prompt 和 plan instructions。

### Epic 11：Durable Session Recovery

- checkpoint manifest/transcript；
- restart replay、conflict、lock 和 GC；
- restart E2E。

### Epic 12：Usage And Budget

- run/session/model usage；
- cost accounting；
- Gateway-owned USD budget；
- context category accounting。

### Epic 13：Extension Parity

- output style registry、selection 和 reload；
- session-scoped plugins/skills（experimental 已交付）；
- AgentDefinition `background` 与已交付的 `observer`/`observerMessage` 的取消、timeout、runtime invalidation、隔离和 sidechain transcript 回归；
- context-only async hook result（experimental 已交付）；补充 hook 发射点与稳定化。

### Epic 14：Beta Gate

- SDK/Gateway compatibility CI；
- fault injection；
- packed-package black box；
- two-application integration；
- API freeze and migration guide。

## 17. 每个 Epic 的完成定义

每个 Epic 都必须满足：

- public API 设计已评审；
- ownership 已写入文档；
- wire capability 已记录；
- runtime 类型和行为一致；
- 正常、失败、取消、超时路径都有测试；
- unsupported behavior 返回明确错误；
- public API 有最小示例；
- 没有要求调用者引用仓库 src/；
- changelog 和兼容矩阵已更新；
- 不会把 transport error、permission denial 或 unknown result 当作成功。

## 18. 风险与应对

| 风险 | 影响 | 应对 |
|---|---|---|
| 直接 re-export Gateway 内部类型 | SDK 被内部重构绑死 | 建立独立 public types 和 mapper |
| Gateway 事件没有稳定终态 | 客户端误报成功 | Phase 1 先固化 final/result_unknown |
| SDK 自己保存 session 状态 | 与服务端状态分叉 | 客户端只保存引用和只读快照 |
| 远程 SDK 接收本地 handler | 执行位置不明确或 Gateway 无法连回调用者 | 仅通过可达的标准 MCP endpoint；不可达时明确失败，不走 callback RPC |
| 自动重试 submit | 重复副作用 | 仅查询状态，除非有 idempotency key |
| permission handler 异常默认允许 | 安全边界破坏 | 无响应、异常、超时全部 fail closed |
| scope 过大 | Beta 长期无法发布 | 按 P0/P1 验收门槛分批交付；Embedded、Python 和 P2 不阻塞 Beta |
| Claude API 一比一模仿 | 与 PilotDeck ownership 冲突 | 参考体验，不复制不适用语义 |
| npm API 过早稳定 | 后续无法修正 | 0.x 分 stable/experimental/internal |
| 浏览器凭证泄漏 | 不适合直接连接 | 首版主推可信 Node.js/桌面宿主 |

## 19. 首版版本建议

### 0.1 Alpha

当前 `0.1.0-alpha.0` 已包含：

- `query()`/`startup()`、connect/close 和 server capability；
- sessions create/list/resume/fork/rename/tag/delete；
- run stream/result/steer/cancelSteer/abort 和 `result_unknown`；
- permission/elicitation、hooks、MCP 和 SDK-hosted tools；
- structured output、session thinking、tool filter、files/models/commands/skills resources；
- SessionStore mirror、版本化 `FileSessionStore` client-mirror recovery、cron client、typed events/errors 和可安装包示例。
- `@pilotdeck/sdk/embedded` experimental in-process Query/WarmQuery transport、typed resource client 与 local tool registry；宿主仍须显式提供权威 Gateway。

后续 alpha patch 保持 P1 已接通切片的真实 Gateway/重启/隔离**发布回归**，并继续验证 usage/budget、extension parity 和已交付 Embedded transport 的宿主边界；不承诺在 alpha 中交付独立 Embedded runtime。

### 0.2 Beta

增加：

- durable checkpoint 的 retention/GC、legacy snapshot 兼容和重复 rewind 回归；
- output style 选择和独立 reload 的真实项目验收与资源隔离；
- `AgentDefinition.background` 与已交付 `observer`/`observerMessage` 的取消、timeout、runtime invalidation、隔离和 sidechain transcript 回归；
- context-only async hook result 的补充 hook 发射点与稳定化；
- compatibility matrix 和至少两个真实应用接入。

### 0.3

增加：

- portable transcript archive/restore 的 schema version、size limit、fresh target 冲突与 Gateway restart 回归维护（client-mirror `FileSessionStore` 已完成）；
- advanced extension/config/sandbox APIs；
- 补充 MCP transport；
- browser-compatible transport feasibility；
- telemetry hooks；
- API ergonomics 优化。

### 1.0

冻结：

- Client；
- Sessions；
- Runs；
- Events；
- Results/Errors；
- Permissions/Elicitation；
- MCP；
- 支持的 Gateway protocol 范围。

Embedded SDK 单独按 experimental 发布，不阻塞 Gateway SDK 1.0。

## 20. 下一步建议

当前骨架、核心 run/session、MCP、基础可靠性以及 P0/P1 Claude-like 范围的功能开发均已完成。下一步按以下实施批次推进：

1. **Phase 7 release regression**：持续运行 Gateway aggregate、`costSources` provenance、`router.stats.retentionMs`、per-turn `maxBudgetUsd`、session/project `taskBudget.total`、checkpoint retention/GC、legacy snapshot、plugins、background/observer、async hook 和已支持 lifecycle 的重启、并发、隔离回归。这些是已完成 P1 的发布质量门槛，不是新增 P1 功能项。
2. **P2 release regression**：managed settings/source cascade 与完整的多宿主 JSON Schema dialog 已完成，均转入回归。dialog 路径以 Draft 2020-12 validation、terminal/browser/DOM renderer、`GatewayUserDialogStore` live protocol、`FileGatewayUserDialogStore` 和 bearer-protected `HttpGatewayUserDialogStore` 为基础；真实 Gateway E2E 覆盖 remote form handoff 与 owner-expiry terminal recovery。跨 Gateway 重启只允许 `gateway_restarted` recovery 在下一条新 turn 注入 context，绝不续跑旧 AgentLoop。host/OS-native sandbox 保持 deferred，按当前范围不实施；新接入继续首选 `streamable_http`。
3. **Beta gate**：执行上一 Gateway/当前 Gateway 兼容矩阵、故障注入、安装包黑盒和两个真实应用接入。

每个批次都必须遵循同一顺序：先定义 Gateway capability 与 wire schema，再实现默认关闭的宿主适配，然后补 SDK public type/façade，最后运行 fake Gateway contract、真实 Gateway 黑盒和受影响的 AgentLoop parity。不得为了接口同名在 SDK 客户端复制 session、permission、checkpoint 或终态状态机。

## 相关文档

- [PilotDeck SDK 与原生模块：简单说明](pilotdeck-sdk-vs-native-modules.zh.md)
- [PilotDeck SDK 开发与接入 SOP](pilotdeck-sdk-development-sop.zh.md)
- [Claude Agent SDK 与 PilotDeck：逐函数代码对应表](claude-agent-sdk-pilotdeck-function-map.zh.md)
- [PilotDeck 当前可复用表面](pilotdeck-sdk-current-surface.zh.md)
- [SDK 能力差距矩阵](sdk-capability-gap-matrix.zh.md)
