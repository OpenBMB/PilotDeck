# Claude Agent SDK 与 PilotDeck：逐函数代码对应表

## 说明

本文以 @anthropic-ai/claude-agent-sdk@0.3.263 的 TypeScript 导出为 Claude 基线，以本 worktree 的 PilotDeck 提交 20b88268 为原生语义基线，并记录本次实现的 `packages/sdk` Gateway-first alpha。

“对应”分为三种：

- 直接对应：职责和调用形态基本相同；
- 组合对应：能力存在，但需要多个 PilotDeck 对象协作；
- 无对应：当前提交没有同类入口，或属于 Claude/CLI 专属控制面。

PilotDeck 路径均相对于仓库根目录；`src/` 链接指向内部源码，不代表已经是稳定 npm SDK。除特别标注外，`@pilotdeck/sdk` 指本次交付的 alpha public package。

## 1. 总体代码形态

### Claude：一个 query 入口

~~~ts
import { query } from "@anthropic-ai/claude-agent-sdk";

const stream = query({
  prompt: "检查测试并修复失败项",
  options: { cwd: "/workspace/demo", maxTurns: 10 },
});

for await (const message of stream) {
  console.log(message);
}
~~~

### PilotDeck：Session、Gateway 和 Run 分层

进程内源码 API：

~~~ts
import { createAgentSession } from "../../src/agent/index.js";

const session = createAgentSession({
  sessionId,
  turnRunner,
  cwd: "/workspace/demo",
});

for await (const event of session.submit(
  { type: "text", text: "检查测试并修复失败项" },
  { maxTurns: 10, canPrompt: false },
)) {
  consume(event);
}
~~~

远程 Gateway API：

~~~ts
import { createRemoteGateway } from "../../src/gateway/index.js";

const gateway = await createRemoteGateway(connectionOptions);
for await (const event of gateway.submitTurn({
  sessionKey,
  input: { type: "text", text: "检查测试并修复失败项" },
})) {
  consume(event);
}
~~~

Claude 的 query 在 PilotDeck 中通常分解为：

~~~text
createAgentSession / Gateway session
  -> submitTurn / AgentSession.submit
  -> TurnRunner
  -> AgentLoop
  -> AgentEvent / GatewayEvent
  -> final AgentTurnResult / Gateway event
~~~

## 2. Claude 顶层函数逐个对应

### query()

Claude：

~~~ts
query({
  prompt: "列出项目中的 TypeScript 错误",
  options: { maxTurns: 5 },
});
~~~

PilotDeck 入口：

- AgentSession.submit：src/agent/session/AgentSession.ts；
- createAgentSession：src/agent/session/createAgentSession.ts；
- TurnRunner 和 AgentLoop：src/agent/turn/TurnRunner.ts、src/agent/loop/AgentLoop.ts；
- 远程 submitTurn：src/gateway/client/RemoteGateway.ts。

结论：SDK alpha 已直接对应：`@pilotdeck/sdk` 的 `query()` 通过 Gateway `submit_turn` 驱动同一原生循环；它不重新实现 AgentLoop，session/turn/run 的权威状态仍在 Gateway。

### startup()

Claude：

~~~ts
const warm = await startup({ options: { cwd: "/workspace/demo" } });
~~~

PilotDeck 入口：

- createAgentSession：src/agent/session/createAgentSession.ts；
- createGateway、startGatewayServer：src/gateway/Gateway.ts、src/gateway/index.ts；
- createRemoteGateway：src/gateway/client/RemoteGateway.ts。

结论：SDK alpha 已直接对应：`startup()` 完成 Gateway hello 并返回单次预热的 `query(prompt)` 句柄；底层仍由 Gateway 负责连接与 session 创建。

### tool()

Claude：

~~~ts
const lookup = tool(
  "lookup_ticket",
  "查询工单",
  { ticketId: z.string() },
  async ({ ticketId }) => ({
    content: [{ type: "text", text: await lookupTicket(ticketId) }],
  }),
);
~~~

PilotDeck 入口：

- PilotDeckToolDefinition：src/tool/protocol/types.ts；
- ToolRegistry：src/tool/registry/ToolRegistry.ts；
- createMcpTool：src/tool/builtin/mcpTool.ts；
- ToolRuntime：src/tool/execution/ToolRuntime.ts。

PilotDeck 把 definition、registry、runtime、scheduler 和 permission 分开。SDK 的 `tool()` 返回 Claude-like 描述对象；`createSdkMcpServer()` 会把 handler 运行在 SDK 调用者进程的标准 Streamable HTTP MCP endpoint，Gateway 再经既有 MCP bridge、ToolRegistry 和 ToolRuntime 调用它。handler 不会被 WebSocket 序列化；embedded 宿主仍可通过 `toEmbeddedTool()` 转成 `extraTools`。结论：已提供真实 handler 接入，仍保留 PilotDeck 的工具命名、权限与调度语义。

### createSdkMcpServer()

Claude：

~~~ts
const server = createSdkMcpServer({
  name: "ticket-tools",
  version: "1.0.0",
  tools: [lookup],
});

query({
  prompt: "查询 T-123",
  options: { mcpServers: { tickets: server } },
});
~~~

PilotDeck 入口：

- McpClient 和 McpRuntime：src/mcp/index.ts；
- createMcpToolDefinitionsFromRuntime：src/mcp/runtime/PluginToToolBridge.ts；
- MCP 配置加载：src/mcp/config/loadMcpServerConfig.ts。

结论：部分对应。`createSdkMcpServer()` 与 `createPilotDeckMcpServer()`（别名）都会启动 SDK-hosted Streamable HTTP MCP endpoint，并支持标准 MCP `instructions` 及 server-level `timeout`；`query({ options: { mcpServers: { name: server } } })` 自动将该 endpoint 配置给 Gateway。已经创建 session 时，也可用不消费 Query 的 `client.mcp.setServers({ sessionId, servers })` 进行同一配置，并以 `client.mcp.status()`/`.reconnect()`/`.toggle()` 管理 Gateway-owned session-local config。Gateway 继续通过 MCP bridge、ToolRegistry、ToolRuntime 和 PermissionRuntime 调用它；远程 Gateway 必须能访问 endpoint 的 `publicUrl`，否则初始化显式失败。

### listSessions()

Claude：

~~~ts
const sessions = await listSessions({ dir: projectDir });
~~~

PilotDeck：

~~~ts
import { listAllSessions, listProjectSessions } from "../../src/session/index.js";

const all = await listAllSessions(options);
const projectSessions = await listProjectSessions(projectOptions);
~~~

源码：src/session/storage/SessionList.ts。

结论：直接/组合对应。有 project storage 查询，但参数和返回类型不是 Claude 的 SDKSessionInfo。

### getSessionMessages()

Claude：

~~~ts
const messages = await getSessionMessages(sessionId, options);
~~~

PilotDeck：

~~~ts
import { readTranscript, buildConversationChain } from "../../src/session/index.js";

const transcript = await readTranscript(transcriptPath);
const conversation = buildConversationChain(transcript.entries);
~~~

源码：src/session/transcript/TranscriptReader.ts、src/session/transcript/TranscriptChain.ts。远程对应是 Gateway 的 readSessionMessages。

结论：SDK alpha 已提供 `getSessionMessages()`/client session helpers；它们通过 Gateway 读取权威 transcript，本地 reader 仍是原生内部组合入口。

### getSessionInfo()

Claude：

~~~ts
const info = await getSessionInfo(sessionId);
~~~

PilotDeck：

~~~ts
// readSessionInfo() 当前位于 session storage 内部实现，不从 src/session/index.ts 公共导出。
import { readSessionInfo } from "../../src/session/storage/SessionList.js";

const info = await readSessionInfo(sessionPath, sessionId, projectRoot);
~~~

源码：[`src/session/storage/SessionList.ts`](../../src/session/storage/SessionList.ts)。

结论：SDK alpha 提供 `getSessionInfo()`/client session helpers；原生 `SessionInfo` 类型与 Claude 的返回结构仍不同。

### renameSession()

Claude：

~~~ts
await renameSession(sessionId, "回归测试");
~~~

PilotDeck 入口：

- SessionMetadataStore：src/session/metadata/SessionMetadataStore.ts；
- title generator：src/session/title/SessionTitleGenerator.ts；
- Gateway session metadata/title 操作。

结论：SDK alpha 提供 `renameSession()` 与 `client.sessions.rename()`；metadata 的存储与并发约束仍由 Gateway 管理。

### tagSession()

Claude：

~~~ts
await tagSession(sessionId, "important");
~~~

PilotDeck alpha Gateway 为 session metadata 提供 tag patch。

结论：SDK alpha 提供 `tagSession()` 与 `client.sessions.tag()`；tag 是 PilotDeck transcript metadata，不与 Claude 的持久化格式兼容。

### prepareLastTurnReplacement()（PilotDeck 专有）

Claude：没有公开的“原地替换 session 最新 accepted turn”SDK helper；文件 checkpoint rewind 和 transcript/session resume 是不同语义。

PilotDeck：`prepareLastTurnReplacement(sessionId, { expectedTurnId })` 与 `client.sessions.prepareLastTurnReplacement()` 通过 Gateway `replace_last_turn` 创建 durable transaction。SDK 生成 replacement `runId` 并把它固定到返回对象的单次 `start()`；只有携带同一 run id 的 `submit_turn` 可以消费 transaction。`rollback()` 仅在 run 尚未真正开始时调用 Gateway `finalize_last_turn_replacement(action: "rollback")`。一旦 input 被 Gateway 接受，`InProcessGateway.commitAcceptedTurnReplacement()` 负责 commit；SDK 不发 commit，也不保存 backup/journal。

源码：[`packages/sdk/src/client.ts`](../../packages/sdk/src/client.ts)、[`packages/sdk/src/types.ts`](../../packages/sdk/src/types.ts)、[`src/gateway/client/InProcessGateway.ts`](../../src/gateway/client/InProcessGateway.ts)、[`src/web/server/replaceLastTurn.ts`](../../src/web/server/replaceLastTurn.ts)。

结论：PilotDeck 专有。它以 Gateway 为 transaction、timeout、崩溃恢复和 transcript ownership 边界；SDK 只提供类型化 prepare/start/rollback façade，不能把它表述为 Claude `rewindFiles()` 或跨 Gateway checkpoint 恢复。

### deleteSession()

Claude：

~~~ts
await deleteSession(sessionId);
~~~

PilotDeck SDK 新增 Gateway `delete_session` adapter：先拒绝活动 turn，再关闭缓存 runtime，删除 transcript、subagent transcript、file-history 与 tool-result sidecars。`close_session` 仍只关闭运行时，不删除持久化数据。

源码：src/gateway/protocol/types.ts、src/gateway/client/RemoteGateway.ts、src/session/storage/ProjectSessionStorage.ts。

结论：SDK façade 已对应；原生 `closeSession` 仍不是永久删除，删除语义只由显式 `delete_session` 提供。

### forkSession()

Claude：

~~~ts
const forked = await forkSession(sessionId, options);
~~~

PilotDeck：

~~~ts
const forked = await gateway.forkSession({
  sessionKey,
  // Gateway fork 字段
});
~~~

源码：src/gateway/protocol/types.ts、src/gateway/client/RemoteGateway.ts；文件历史见 src/session/filesystem/FileHistoryStore.ts。

结论：组合对应。还需定义 project、文件历史和宿主状态的复制范围。

### getSubagentMessages 和 listSubagents

Claude：

~~~ts
const children = await listSubagents(sessionId);
const messages = await getSubagentMessages(sessionId, children[0]);
~~~

PilotDeck 入口：

- SubAgentSession：src/agent/sub/SubAgentSession.ts；
- replaySubagentTranscript：src/session/transcript/replaySubagentTranscript.ts；
- Gateway readSubagentMessages：src/gateway/protocol/types.ts。

结论：组合对应。有子 Agent transcript 和 Gateway 查询，但没有同名顶层函数。

### resolveSettings()

Claude：

~~~ts
const resolved = await resolveSettings({ cwd: projectDir });
~~~

PilotDeck 入口：

- SDK `resolveSettings()` → Gateway `resolve_settings` → `PilotConfigStore.getSnapshot()`；
- 协议投影：`src/cli/createLocalGateway.ts` 的 `toGatewayResolvedSettings()`；
- 配置加载与脱敏：`src/pilot/config/loadPilotConfig.ts`、`src/pilot/config/redact.ts`。

结论：部分对应。SDK 返回 Gateway 宿主当前的、已脱敏的 `PilotConfigStore` snapshot（`config`、`sources`、`diagnostics`、schema/version/content hash），而不读取 SDK 调用者本机文件。它提供真实的来源与诊断，但不是 Claude 全 settings source/provenance schema，也不返回未脱敏 provider 凭据。

### importSessionToStore、InMemorySessionStore 和 FileSessionStore

Claude：

~~~ts
await importSessionToStore(sessionId, store);
const memoryStore = new InMemorySessionStore();
const fileStore = new FileSessionStore({ rootDir: ".pilotdeck-sdk-mirror" });
~~~

PilotDeck 入口：

- JsonlTranscriptWriter：src/session/transcript/JsonlTranscriptWriter.ts；
- InMemoryTranscriptWriter：src/session/transcript/InMemoryTranscriptWriter.ts；
- createAgentProjectSessionStorage：src/session/storage/ProjectSessionStorage.ts。

结论：部分对应。`FileSessionStore` 已为 Node 调用者提供 version 1 mirror snapshot、原子写入和 `exportSession()`/`importSession()` 的 `reject`/`append`/`replace` 冲突策略，能跨 SDK 进程恢复观察日志。Gateway transcript、active turn、权限和 fork 状态仍不接受客户端镜像回写。P1 experimental 另提供 `exportSessionTranscript()`/`restoreSessionTranscript()` 及 `client.sessions.exportTranscript()`/`.restoreTranscript()`：Gateway 从已完成 native transcript 投影 schema v1 `portable_text_messages`，只对 fresh/inactive persistent session 原子恢复，下一次 AgentSession 构造会读取该文本上下文；checkpoint、artifact、subagent sidechain、permission 与 active run 不在归档范围。因此它仍不是 Claude 的完整跨机器 SessionStore，但已经有 Gateway-owned restore protocol。

### AbortError、filterEscalatingDefaultMode 和 foldSessionSummary

`AbortError` 已由 `@pilotdeck/sdk` 导出，并用于区分调用者取消事件观察与普通传输错误；Gateway-owned run 的终态仍通过 `PilotDeckResult.status = "aborted"` 返回。

`filterEscalatingDefaultMode()` 与 `HOOK_EVENTS` 现在作为兼容性导出提供：PilotDeck 不公开 Claude 的 trust-tier settings cascade，因此该纯函数只返回 Gateway settings snapshot 的深拷贝，不作额外权限放宽/收紧；`HOOK_EVENTS` 仅是 Claude 事件名常量，实际可用事件仍由 Gateway native lifecycle 校验。

`foldSessionSummary()` 则继续由 SDK 的 `SessionStore` 实现，数据所有权仍在调用者提供的 store。

结论：这些导出只补齐公共符号和纯数据辅助语义，不伪造 Claude provider/settings 行为。

## 3. Query 方法逐个对应

Claude Query 是 AsyncGenerator<SDKMessage, void> 上附加的控制方法。PilotDeck 的近似能力分布在 AgentSession、Gateway 和 MCP runtime 中。

| Claude Query 方法 | PilotDeck 代码对应 | 状态 | 说明 |
|---|---|---|---|
| interrupt | SDK `Query.interrupt()` → Gateway `abort_turn` → AgentSession.abort | 部分对应 | SDK 已提供 query control；取消终态、session 状态仍由 Gateway 维护。 |
| setPermissionMode | SDK `Query.setPermissionMode()` → Gateway `set_permission_mode` | 部分对应 | SDK 支持 `default`、`plan`、`bypassPermissions` 和 `auto`。`auto` 在创建与运行时切换时都保守映射为 Gateway `default`（初始 `basePermissionMode` 也为 `default`），SDK 保留其公共请求值；它不实现 Claude classifier 或自动放行，仍由原生 permission 与 `canUseTool` 决定。 |
| setMcpPermissionModeOverride | SDK `Query.setMcpPermissionModeOverride()` 或 `client.mcp.setPermissionModeOverride()` → Gateway `set_mcp_permission_mode_override` → `ProjectRuntimeRegistry.setMcpPermissionModeOverrideForSdk()` → session `PermissionContext.rules.ask` | 部分对应 | `client.mcp` 还可在不消费 Query 时使用 `status`/`setServers`/`reconnect`/`toggle` 管理 SDK-owned session MCP。`default` 与 `auto` 都对指定 MCP server 的 `mcp__<server>__*` 工具注入 session-scoped ask 规则；`auto` 因无 Claude classifier 采用保守 ask 并返回 warning；`null` 清除覆盖。未调用时不改变原生权限。 |
| setModel | SDK `Query.setModel()` → sessionModelSet/sessionModelClear | 部分对应 | 模型选择仍是 Gateway session resource；SDK 先经 Gateway catalog 消歧。 |
| setMaxThinkingTokens | SDK `Query.setMaxThinkingTokens()` → Gateway `set_session_thinking` → session config override | 部分对应 | 已有同名 façade；在 turn 开始前或 turn 结束后设置，下个 turn 重建 session runtime。embedding host 可用 `organizationPolicy.settings.maxThinkingTokens` 作为不可由 SDK 放宽的非负 cap：它压低已启用 thinking 的 budget，`0` 显式关闭且不凭空启用 thinking。`summarized` display 尚不支持。 |
| applyFlagSettings | SDK `Query.applyFlagSettings()` → Gateway `apply_flag_settings` → `ProjectRuntimeRegistry.applyFlagSettingsForSdk()` | 部分对应 | 当前只支持 `effortLevel` 与 `permissions.defaultMode` 的 session-scoped 子集；配置变化会淘汰缓存 runtime，活动 turn 返回 `SESSION_BUSY`。不实现 Claude 完整 flag-layer 动态 merge、settings 文件持久化或未知 key 的静默忽略。 |
| updateSettings | SDK `Query.updateSettings("localSettings", settings)` → Gateway `update_settings` → `updatePilotLocalSettings()` → `PilotConfigStore.reload()` → session-local SDK `ConfigChange` lifecycle | 部分对应 | 真实持久化 Gateway 宿主 `$PILOT_HOME/pilotdeck.yaml`，且在首个 turn 前可调用；仅 allowlist `agent.maxContextTokens`、`agent.maxOutputTokens`、`agent.thinking`、`agent.subagents.default`/`.timeoutMs`/`.maxDepth`、`extension.includeHookEvents`、`extension.builtinPluginsEnabled` 和 `tools.webSearch.enabled`（`null` 清除）。`maxDepth: 0` 禁止 fork。先在临时 `PILOT_HOME` 校验、再原子替换和原生重载；显式 `hooks.ConfigChange` 的存活 SDK session 收到 `changedPaths`/`changeClasses` 与 hook stream 投影，但 callback output 不能影响 reload、runtime invalidation 或 AgentLoop，且不登记 async result。仍不接受 Claude 其他 settings source、密钥/model/provider、web-search endpoint 或任意 YAML key。 |
| `Options.settings` / `settingSources` | SDK session config → Gateway `setSdkSessionConfig()` → `resolvePilotSdkSessionSettings()` → `createAgentConfig()` | 部分对应 | 已提供非持久、Gateway-owned session overlay。`settingSources` 可选 host-owned `managed`/`user`/`project`/`local`，固定按 `managed < user < project < local` 提取非密钥 agent allowlist，随后 `Options.settings` 覆盖。`managed` 只读取 embedding host 的 `organizationPolicy.settings.managedSessionSettings`，调用者只能选择该 source，不能传入、读取或修改其内容。embedding host 可在 wire 外设置 `sessionDefaults`/`.sessionDefaultSources`，并可用同一 allowlist 的 `enforcedSessionSettings` 在 source、SDK overlay、`Options.model`/`.fallbackModel` 与 `set_session_thinking` 后强制覆盖；host token caps 仍在最末层。Gateway 以 `sdk_session_defaults` capability 让新 SDK 发送空 marker，所以 host enforcement 不影响直接 native Gateway 调用。provider 配置/credential、plugin/path/tool、permission grant 不进入 overlay，亦非 Claude 的完整 managed settings/source cascade。 |
| `Options.managedSettings` | SDK `PilotDeckManagedSettings` → `sdkSessionConfig.managedPermissions`/`managedTools`/`managedModels` → `toManagedPermissionRules()` / ToolRegistry filter / model resolver / `PermissionContext`；Gateway host `createLocalGateway({ organizationPolicy })` | 部分对应 | SDK 暴露 restrictive、session-scoped policy：`permissions.deny`、`permissions.ask`、`defaultMode: "plan"`、`canPrompt: false`，`tools.allow`/`.deny` 的 exact-name/`prefix*`/`*` selector，以及 `models.allow`/`.deny` 的 `*`、`provider/*`、`provider/model` selector。Gateway permission rule 优先于 session remembered allow，`canPrompt: false` 优先于普通 session override；SDK tool policy 在 native、plugin、SDK MCP、deferred search 与动态 AgentDefinition fork-local MCP contribution 合入后从 model-visible registry 剔除定义，deny 优先，不改变 handler、permission 或 host policy。SDK model policy 同样 deny 优先，在 session config、显式 turn/session model、SDK fallback、动态 subagent 与 Router fallback 的解析路径拒绝越界模型；项目默认模型不会阻断一条显式允许的 per-turn model override，Router 在真正 provider request 前做最终校验。embedding host 可在 wire 外增加更高优先级的组织策略。已拒绝的 deferred target 不进入搜索目录或 reveal 路径，后注册的 `search_tools` 也会再经过同一过滤。allow grant、provider 配置、凭据、文件 source 和完整 Claude settings cascade 都显式不支持。 |
| initializationResult | describeServer、Gateway hello/capabilities | 组合对应 | 初始化结果拆成 server info、capabilities 和 handshake。 |
| reinitialize | SDK `Query.reinitialize()` → Gateway describe/hello capabilities | 部分对应 | SDK 重取初始化信息；它不重建原生 session。 |
| supportedCommands | commandsList | 直接对应 | Gateway command catalog；返回类型不同。 |
| supportedModels | modelCatalogList | 直接对应 | Gateway model catalog。 |
| supportedAgents | SDK `Query.supportedAgents()` → Gateway built-in subagent catalog | 部分对应 | SDK 已提供查询；动态 AgentDefinition 支持基础字段、Gateway-resolved per-agent `model`、fork-local MCP map，及 Claude 形状 `("sessionMcpName" | { name: config })[]`。字符串由 Gateway 在 child 创建前仅从已启用 SDK-session MCP map 快照解析；未知/已禁用引用分别返回 `SDK_AGENT_MCP_REFERENCE_NOT_FOUND` / `SDK_AGENT_MCP_REFERENCE_DISABLED`，而 plugin/config-owned MCP 不可引用。每个 child 仍拥有独立 McpRuntime；另支持受父技能域约束的 `skills` 与 `memory: "disabled"`、directive 前的 `initialPrompt`、child-only `criticalSystemReminder_EXPERIMENTAL` 和 Gateway-owned experimental `background`。observer/observerMessage 和 Claude callback 面仍不支持。 |
| mcpServerStatus | SDK `Query.mcpServerStatus()` 或 `client.mcp.status()` → Gateway `mcp_server_status` → McpRuntime status | 部分对应 | resource client 不创建或消费 Query，仍只读取 Gateway-owned session MCP 状态；字段和 ownership 与 Claude 不同。 |
| getContextUsage | SDK `Query.getContextUsage({ detail })` → active turn snapshot/context budget → `TokenAccountingRuntime.estimateRequestBreakdown()` | 部分对应 | 支持 `summary`/`full` 参数并透传原生 TokenBudgetSnapshot 诊断字段。`full` 返回 Gateway-owned additive local-tokenizer `system/tools/messages/MCP/memory` 分类；provider 总量不被伪造为分类，旧 Gateway 或 `summary` 返回 `breakdownAvailable: false`。 |
| usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET / `modelUsage` | SDK `Query.usage()` → Gateway `usage_snapshot`；SDK `Query.modelUsage()` → Gateway `model_usage_snapshot` → `TokenStatsCollector.modelUsageSnapshot()`；`taskBudget.total` → Gateway durable ledger | 部分对应 | `usage()` 提供 session/project aggregate；`modelUsage()` 提供 Gateway-owned provider/model 的请求数、输入/输出/缓存 token、成本与 main/subagent 维度，并随 Router stats JSONL 重建。`taskBudget` 已提供跨 turn 的 session/project shared ceiling，SDK 不上传 spent cost，Gateway restart 后从 ledger 恢复；跨 project/session usage 留存和成本精度仍待定义。 |
| readFile | SDK `Query.readFile()` → Gateway project file API | 部分对应 | SDK 提供 query 控制面读取；path policy 和项目注册仍由 Gateway 处理。 |
| reloadPlugins | reloadExtensions、PluginRuntime | 直接/组合对应 | reload 能力存在，返回结构不同。 |
| reloadSkills | skillsList、skills write/scan/validate/import | 组合对应 | Skills 更像 Gateway resource。 |
| reloadOutputStyles | SDK `Query.reloadOutputStyles()` → Gateway `reload_output_styles` → `PluginRuntime.reloadOutputStyles()` | PilotDeck 专有 | Claude Agent SDK 没有可直接复用的同形状 PilotDeck registry；该方法只刷新 output-style registry，不刷新 hooks/MCP/commands/skills。 |
| accountInfo | Gateway auth/server info | 无直接对应 | 供应商 account control 不属于 PilotDeck AgentLoop core。 |
| rewindFiles | SDK `Query.rewindFiles()` → Gateway `rewind_files` → FileHistoryStore | 部分对应 | 已有同名 façade、dry-run 和空闲态保护；Gateway 重启后从 transcript 惰性恢复 snapshot 与 post-edit fingerprint，外部修改返回 `conflicts` 并拒绝覆盖，缺失 backup 不改动 workspace，restore 使用原子 rename。 |
| seedReadState | SDK `Query.seedReadState()` → Gateway `seed_read_state` → SessionRouter → AgentSession/TurnRunner/AgentLoop 的 `readFileState` + write snapshot | 部分对应 | 已提供同名 façade。只能在 active turn 结束后调用；Gateway 用当前 session 的 workspace path policy 校验路径，并仅在 floored mtime 相等时写入既有 native cache。mtime 不同则静默跳过，后续 Edit 仍要求 fresh Read。 |
| reconnectMcpServer | SDK `Query.reconnectMcpServer()` 或 `client.mcp.reconnect()` → Gateway `mcp_server_reconnect` | 部分对应 | 仅管理 SDK-owned session MCP server；disabled server 会由 Gateway 拒绝重连。 |
| toggleMcpServer | SDK `Query.toggleMcpServer()` 或 `client.mcp.toggle()` → Gateway `mcp_server_toggle` | 部分对应 | 仅管理 SDK-owned session MCP server。 |
| setMcpServers | SDK `Query.setMcpServers()` 或 `client.mcp.setServers()` → Gateway `set_mcp_servers` → MCP config loader/McpRuntime | 部分对应 | resource client 可在不启动 query 时为已有 session 设置 MCP；支持 `stdio`/`streamable_http`，不覆盖 plugin/config-owned MCP。 |
| streamInput | SDK `Query.streamInput()` → Gateway `steer_turn` mailbox | 部分对应 | 已有同名 façade；只能在活跃 turn 中向原生 steer mailbox 注入文本。 |
| stopTask | SDK `Query.stopTask()` → `background_task_stop` → `ProjectRuntimeRegistry.stopBackgroundTaskForSdk()` → `BackgroundTaskRuntime.stop()` / `BackgroundSubagentRuntime.stop()` | 部分对应 | 只停止当前 SDK session 在当前 project runtime 中拥有的 Bash 或 AgentDefinition.background task；非所属或不存在的 task 返回 `BACKGROUND_TASK_NOT_FOUND`。不映射到 cron。 |
| backgroundTasks | SDK `Query.backgroundTasks()` → `background_tasks` → `ProjectRuntimeRegistry.backgroundTasksForSdk()` | 部分对应 | 对 active AgentDefinition.background child，Gateway 返回 `backgrounded: true` 与 task id，SDK façade 将其投影为 boolean；task id 来自同次 child-launch 的流式 `tool.completed.data.backgroundTaskId`。对 PilotDeck `task_create` 等天生 detached task，仍没有 Claude 式 foreground task 可转换，因此保持 `false` 与 `no_foreground_tasks`/`task_not_found`。不把 cron 当作替代品。 |
| close | closeSession、transport close | 组合对应 | Query close、session close、transport close 是不同层级。 |

PilotDeck 的 `client.cron.create/list/update/delete/stop/runNow` 是额外的 PilotDeck 专有资源 API。它们对应 Gateway `cron_create`、`cron_list`、`cron_update`、`cron_delete`、`cron_stop`、`cron_run_now`，由 `CronRuntime`/`CronManager` 持有定时任务和运行实例状态；这套持久化调度生命周期与 Claude 的 Bash/subagent background task 生命周期不兼容。

## 4. Claude 工具、MCP 与 PilotDeck 代码路径

Claude：

~~~text
tool()
  -> SdkMcpToolDefinition
  -> createSdkMcpServer()
  -> Options.mcpServers
  -> query()
  -> MCP tool call/result
~~~

PilotDeck：

~~~text
PilotDeckToolDefinition / createMcpTool()
  -> ToolRegistry
  -> ToolRuntime
  -> ConcurrentToolScheduler / SequentialToolScheduler
  -> PermissionRuntime
  -> AgentLoop tool call/result projection
~~~

关键源码：

- src/tool/index.ts：registry、runtime、scheduler、内置工具导出；
- src/tool/scheduler/ConcurrentToolScheduler.ts：并发调度；
- src/tool/scheduler/SequentialToolScheduler.ts：串行调度；
- src/mcp/index.ts：MCP client/runtime/config；
- src/permission/index.ts：权限上下文和 runtime。

## 5. Claude Hooks 与 PilotDeck Hooks

Claude 通过 Options.hooks 把 HookCallback 直接挂到 query 生命周期：

~~~ts
query({
  prompt,
  options: {
    hooks: {
      PreToolUse: [{
        matcher: "Bash",
        hooks: [async () => ({
          decision: "block",
          reason: "禁止执行 shell",
        })],
      }],
    },
  },
});
~~~

PilotDeck SDK 对应入口：

- `packages/sdk/src/hook-server.ts`：`HostedHookServer` 将 SDK callback 托管为带 bearer token 的 HTTP endpoint；
- `packages/sdk/src/client.ts`：query 初始化时把 endpoint 的 URL、headers、event/matcher/timeout 序列化为 `sdkSessionConfig.hooks`；
- `src/gateway/client/InProcessGateway.ts`：校验仅含 serializable 值的 hook 配置；
- `src/cli/createLocalGateway.ts`：转换并合并为现有 `HookRuntime` HTTP hooks；
- Hook 事件和输入输出：`src/extension/hooks/protocol/`；executors 和 `HookRuntime`：`src/extension/index.ts`；`AgentSession` 通过 lifecycle dispatch SessionStart、Setup、SessionEnd。
- `packages/sdk/src/hook-server.ts`：回调返回 `{ async: true }` 时分配并返回 `asyncHookId`；`packages/sdk/src/client.ts`：`Query.submitAsyncHookResult()` 发起 `hook_async_result` RPC；`src/gateway/client/InProcessGateway.ts`：按 session/run 保存 pending invocation、deadline、turn-end cleanup 和幂等 outcome。

结论：部分等价。Claude 是 query option；PilotDeck SDK 以 HTTP bridge 接入 extension/runtime/lifecycle 组合，不序列化 callback function。experimental 的 `{ async: true }` 只允许经 `submitAsyncHookResult()` 将 `hookSpecificOutput.additionalContext` 投递到 active-turn steer mailbox；迟到、重复和未知 id 分别是 `expired`、`duplicate`、`unknown`。`ConfigChange` 是例外的 Gateway config-store 观察事件：它只向显式注册的存活 SDK session 分发 `changedPaths`/`changeClasses`，同步输出被忽略，异步 callback 不登记 invocation，因此 result 始终为 `unknown`。它不能事后回写 input、block/allow、permission 或 system message，确保 Hook 不拥有 session/turn 最终状态；无 native 发射点的 Claude hook event 继续保持 `unsupported_capability`。

## 6. Claude Options 字段到 PilotDeck 代码

| Claude Options 字段 | PilotDeck 代码入口 | 状态 |
|---|---|---|
| cwd / additionalDirectories | SDK `sdkSessionConfig` → Gateway → AgentRuntimeConfig/PermissionContext | 部分对应 | `cwd` 与绝对 `additionalDirectories` 已支持；不改变宿主根目录或组织 permission policy。 |
| model / effort / thinking | AgentSubmitOptions.modelOverride、Router model runtime、`GatewaySdkAgentDefinition.model`/`.effort` → `SubagentDefinition.modelOverride`/`.effort` | 部分对应 | 主 Agent 的 model/effort/thinking 走现有 session/runtime 控制；动态 AgentDefinition 的 `model` 由 Gateway model catalog 解析为唯一可用 provider/model，优先于 project subagent default。MCP/skills/memory 走 fork-local adapters；`background` 走 Gateway task registry，observer 系列仍没有对应 ownership。 |
| maxTurns | AgentSubmitOptions.maxTurns、TurnRunner | 直接对应 | embedding host 的 `organizationPolicy.limits.maxTurns` 在 Gateway 提交边界压低 top-level 与动态 SDK AgentDefinition 的值；省略 SDK 值时 host cap 是默认值。host-only `organizationPolicy.limits.maxSubagentDepth` 还可将 agent fork 深度压低到 `0`，并压低显式 SDK `settings.agent.subagents.maxDepth`；没有该 SDK 设置时，它仍不能将原生默认的一层 fork 扩大。 |
| maxBudgetUsd | TokenBudgetManager、Router stats | 无同形状字段 | `organizationPolicy.limits.maxBudgetUsd` 可作为 Gateway-owned per-turn cap；它在调用 AgentSession 前压低 SDK 或直接 Gateway 请求，SDK 不维护或绕过 budget 状态。`organizationPolicy.limits.maxTaskBudgetUsd` 则只压低或为标记 SDK session 提供 Gateway-owned `taskBudget.total` 默认值，不将 SDK budget 状态伪造给直接 native 请求。 |
| permissionMode | PermissionMode、PermissionRuntime、Gateway permission | 组合对应 |
| allowedTools / disallowedTools | SDK `sdkSessionConfig` → Gateway session ToolRegistry filter；`SubAgentSession` fork-local MCP attach → `filterSubagentToolRegistry()` | 组合对应 | 顶层 allow/deny 同时约束 parent registry 和动态 `AgentDefinition.mcpServers` 的 late tool contribution；Gateway 在 child scheduler 创建前重新投影 registry，因而 child MCP 不能重新暴露被会话过滤、organization policy 或 sandbox 隐藏的工具。它只缩小 model-visible tool surface，最终 permission 与工具执行仍由 Gateway/runtime 持有。 |
| forwardSubagentText | `PilotDeckOptions.forwardSubagentText` → `GatewaySessionSdkConfig.forwardSubagentText` → `SubAgentSession.forwardActivity()` → `mapAgentEvent()` → SDK `subagent.message` | 部分对应 | 默认继续投影 generic `agent_status/subagent_text_delta`；仅 `true` 时在当前 stream 输出 typed child text（`subagentId`、`subagentType`、`runId`）。它不是 parent assistant delta，不会进入 `result().output`、parent transcript 或模型上下文；child AgentLoop、sidechain、permission 和 scheduler 完全不变。 |
| canUseTool | Gateway permission hook/bus、permissionDecide | 组合对应 |
| continue / resume / forkSession | resumeAgentSession、Gateway resume/fork | 组合对应 |
| persistSession / sessionStore | SDK `sdkSessionConfig.persistSession`、`FileSessionStore`、`createSessionStoreFromAdapter()` / embedded `createEmbeddedSessionStore()`、`exportSessionTranscript()`/`restoreSessionTranscript()`、Gateway `ProjectRuntimeRegistry`、`InMemoryTranscriptWriter`、`createLocalGateway({ nativeSessionStorage })`、`createGatewayAsyncTranscriptStorageAdapter()` | 部分对应 | `persistSession: false` 已在 Gateway 构造时使用内存 transcript 与临时 artifact root，不写 project JSONL；仅限新 session，不能 resume/fork/list/read transcript。`FileSessionStore` 或 host snapshot adapter 可跨 SDK 进程恢复版本化的客户端 event mirror；adapter 保留 SDK key/schema/UUID/append 语义，不接管 Gateway transcript。独立的 Gateway portable text archive/restore 可恢复已完成文本上下文到 fresh persistent session，但不恢复 active run、permission、checkpoint、artifact 或 sidechain。`nativeSessionStorage` 只由 Gateway host 选择 native filesystem layout；`createGatewayAsyncTranscriptStorageAdapter()` 则可把 transcript、file-history checkpoint backup 和大文本/媒体 tool-result payload 接到 host store，并覆盖重启缓存重建、fork reference rewrite/payload copy 与 delete cleanup。SDK request 无法注入 storage handle；active run 和跨 Gateway continuation 仍不等价于 Claude SessionStore。 |
| tools | SDK explicit `tools: string[]` → Gateway session filter → ToolRegistry；embedded `createEmbeddedToolRegistry().register(tool(...))` → local Gateway `updateSubsystems()` → ToolRegistry；`createEmbeddedPilotDeckHost()` → typed client + optional local registry attachment；`createEmbeddedQuery()`/`createEmbeddedPilotDeckClient()` → `createEmbeddedGatewayEndpoint()` → Gateway wire dispatcher | 部分对应 | 支持明确 PilotDeck 工具名数组和空数组。experimental embedded registry 向进程内 Gateway 注册本地 handler；`createEmbeddedPilotDeckHost()` 组合 client、可选 handlers 和 attachment，close 只 detach SDK registry/endpoint，绝不 dispose host Gateway；embedded Query 与 typed resource client 复用该 Gateway 的 `hello`/`request`/`stream` dispatcher。endpoint 只握手一次，child Query close 不关闭 client endpoint。两者仍复用原生 permission/scheduler，不是远程 callback RPC 或独立 Agent runtime；`createEmbeddedSessionStore()` 覆盖 SDK event mirror，Gateway `nativeSessionStorage` 已覆盖 host-controlled native filesystem layout，而 `createGatewayAsyncTranscriptStorageAdapter()` 已覆盖 host-owned transcript、file-history checkpoint 与 tool-result payload 的 durable storage。Claude Code preset 名称无等价集合，返回 `unsupported_capability`。 |
| deferredTools / MCP alwaysLoad | `PilotDeckOptions.deferredTools` / SDK-hosted MCP `alwaysLoad: false` → `sdkSessionConfig.deferredTools` / MCP metadata → `ProjectRuntimeRegistry.prepareSessionRuntime()` → ToolRegistry `hide`/Gateway `search_tools` `reveal` | PilotDeck 专有扩展 | `deferredTools` 接受 canonical native、plugin 或 MCP tool 名，并与 MCP metadata 合并为 session-local search catalog；命中后只有下一次模型请求看到 schema，ToolRuntime/scheduler/permission 不变。SDK 和 Gateway 拒绝空数组、重复名及保留 `search_tools`；organization/managed/sandbox 与本 turn allow/deny 先收紧目录。若 search tool 被显式排除，目标保持 hidden，绝不回退为 eager。Claude 没有同名通用 Options 字段。 |
| mcpServers | McpClient、McpRuntime、config loader | 组合对应 |
| agents | AgentSubagentDefinition、SubAgentSession、createAgentTool、`toSdkSubagentDefinitions()`、fork-local `McpRuntime`/ContextRuntime、`BackgroundSubagentRuntime` | 部分对应 | 支持 description/prompt/tools/disallowedTools/maxTurns/effort/permissionMode、Gateway-resolved `model`，以及 `mcpServers` legacy map 或 Claude 形状数组。数组 string 只能引用当前已启用 SDK-session MCP，Gateway 在 fork 前把 transport config 复制给 child；inline map 是 child-only config，SDK-hosted MCP 也必须先配置到 session 后按名称引用。background child 由 Gateway registry 管理 task id、abort/timeout、sidechain transcript 和 shutdown；fork-local MCP 不泄漏到 parent，引用后的 parent toggle/reconnect 不影响 active child，也不能绕过 top-level `allowedTools`/`disallowedTools`、host organization tool deny 或 session sandbox，技能不扩权；observer/observerMessage 和 Claude callback 字段显式不支持。 |
| plugins / skills | SDK `Options.plugins` → `GatewaySessionSdkConfig.plugins` → `PluginRuntime.createView()`；`skills` → SDK `Options.skills` 或 `AgentDefinition.skills` → Gateway scope resolver → PluginRuntime/PromptAssembler/read_skill | 部分对应 | `skills: string[] | "all"` 已支持 Gateway-resolved scope，只筛选 prompt 投影和 `read_skill`；AgentDefinition scope 只能缩小父 scope，`"all"` 继承父 scope。`plugins` 已支持 `type: "local"` 的 absolute Gateway-local path；manifest 的 command/skill/hook/output-style/MCP contribution 只进入 owning session，不改项目扩展或其他 session。远程调用者承担 Gateway path 可见性，`pluginDelivery: "argv"` 仍无等价。 |
| systemPrompt / appendSystemPrompt / outputFormat | SDK serialized session config → Gateway → optional AgentRuntimeConfig addendum；structured output tool | 部分对应 | `systemPrompt: string`、`appendSystemPrompt: string` 与 PilotDeck JSON-schema 子集已支持；这些字段只在 session 构造边界作为显式 SDK 配置注入，未携带时保持既有默认 prompt 路径。Claude preset 和 provider-specific JSON mode 没有完整等价生命周期。 |
| hooks | SDK `HostedHookServer` → Gateway session config → HookRuntime、lifecycle；`ConfigChange` → `PilotConfigStore.reload()` → SDK-only session lifecycle | 部分对应 | 已覆盖原生生命周期事件；`ConfigChange` 是 Gateway-owned、只读的 config reload 观察事件，不激活 project hook 或注册 async result。远程 Gateway 需可达 endpoint，Claude 专属事件不支持。 |
| sandbox | SDK `sandbox.tool_policy` → Gateway session ToolRegistry filter；`sandbox: { type: "host", profile, toolIsolation?: "strict" }` → `createLocalGateway({ sandboxProfiles })` → `createBubblewrapSandboxProfile()` → `BubblewrapSandboxCommandRunner` → native Bash/`execute_code` | 部分对应；`tool_policy` 仍是工具可见性限制。named `host` profile 由 Gateway 查找，SDK 不能传递 runner/executable/mount/env/credential；Bubblewrap profile 对 Bash 及显式 `supportsExecuteCode: true` 的 Python 进程建立真实 namespace/mount boundary。`filesystem: "deny"` 不挂载 workspace；命名 host profile 的 read-only/deny 均删除 Gateway 进程内 native filesystem tool 和 Python filesystem helper（包括 `read_file`、`glob`、`grep`），使文件读取只能在 profile-owned process 中完成。read-only/deny/network-deny 下 Python 仍须由 profile 声明对应支持。`toolIsolation: "strict"` 默认移除 `execute_code` 和所有 host-facing native/MCP/custom/network/skills/subagent tools；profile 额外声明 `supportsStrictExecuteCode: true` 时，strict Python 经同一 runner 执行，但 Gateway 生成无 socket、无 helper 的 module，RPC server 也拒绝所有 raw tool request。它仍不覆盖 provider 或 Gateway host，故不宣称完整 OS/container 隔离。 |
| onElicitation / onUserDialog | `elicitation`：SDK callback adapter → Gateway elicitation bus → PilotDeckElicitationChannel；`input`/`select`/`confirm`/`form`：SDK callback 或 `userDialogMode: "manual"` → `user_dialog_list`/Gateway `user_dialog_changed` notification/`user_dialog_claim`/`user_dialog_release`/`user_dialog_respond` → GatewayUserDialogBus/`GatewayUserDialogJournal` → session-local request-user tools | 组合对应；`onUserDialog` 已支持 native elicitation、free-form input、option select、boolean confirmation 和 schema-backed form。manual mode 还公开 `Query.respondUserDialog()`、`client.dialogs.list/watch/claim/release/respond()`，供另一个 SDK client 在同一 live Gateway 中接管 renderer；watch 给同 session renderer requested/lease/settled best-effort change hint，不是 durable log，重连或漏通知后必须以 list resync。claim 产生有到期时间的 opaque token，list 不泄露 token，未持有 live lease 的 renderer 无法答复，release/expiry 后可接手。工具只在 owning session 注册，Gateway 持有 pending lifecycle 并校验 dialog answer；`form` 支持 Gateway-only object/array/string/number constraint subset（含 schema 型 `additionalProperties`、`patternProperties`、tuple `prefixItems`、`contains`/`minContains`/`maxContains`、`propertyNames`）与有全局深度/节点、每分支 32 条、每个依赖映射 64 条上限的 `allOf`/`anyOf`/`oneOf`/`not`、`if`/`then`/`else`、`dependentRequired`/`dependentSchemas`。根 schema 可声明至多 64 个简单命名 `$defs`，只允许 `#/$defs/<name>` 本地复用；未知 definition、循环、外部 URI、任意 JSON Pointer、嵌套 definition、未知 keyword/format 均明确拒绝。pending snapshot 在 answer/abort/timeout/turn-end 时删除；persistent session 遇 Gateway restart 时 journal 投影 `user_dialog_terminated`/`gateway_restarted` 与 `recovery: "next_turn_context"`。对其有效 `respond()`，Gateway 会重新验证并写入 durable synthetic user context，返回 `{ delivered: true, recovered: true, reason: "gateway_restarted" }`；下一条新 turn 才消费该 context。它不跨 Gateway restart 恢复旧 AgentLoop、turn 或 tool promise，仍不提供全量 dialog state machine 或 renderer。 |

## 7. 如何选择调用层级

外部应用优先使用未来公共 SDK：

~~~ts
const session = await client.sessions.resume(sessionId);
const run = client.runs.start({ sessionId, input });
for await (const event of run.events()) render(event);
const result = await run.result();
~~~

PilotDeck 宿主/服务端可以调用内部模块：

~~~ts
const session = createAgentSession({ sessionId, turnRunner, cwd });
for await (const event of session.submit(input, submitOptions)) {
  persistOrBroadcast(event);
}
~~~

跨进程/跨语言模块使用 Gateway 或 module/sidecar protocol，不把 TypeScript handler 直接塞进远程 SDK。

## 8. 最终结论

1. Claude SDK 将大量能力收敛为 query、Options、Query 和 session helper functions。
2. PilotDeck 已有大部分语义实现，但入口分散在 AgentSession、Gateway、ToolRuntime、MCP、Session、Context、Permission 和 Extension 模块。
3. 逐函数对应不等于类型兼容：相同职责仍可能拥有不同的 session、turn、run、operation、permission 和 persistence ownership。
4. 对外 SDK 应包装这些内部入口，提供稳定的 Client、Sessions、Runs、Events、Permissions、MCP 和 typed errors，而不是直接 re-export 内部实现。
