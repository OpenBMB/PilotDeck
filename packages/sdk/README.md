# @pilotdeck/sdk

Claude Agent SDK-like 的 PilotDeck Gateway 客户端 alpha。

```ts
import { query } from "@pilotdeck/sdk";

const run = query({
  prompt: "检查测试失败原因",
  options: {
    gatewayUrl: "ws://localhost:8787",
    authToken: process.env.PILOTDECK_TOKEN!,
  },
});

for await (const message of run) {
  console.log(message.type, message);
}

console.log(await run.result());
```

当前包通过 Gateway WebSocket 调用 PilotDeck 原生 AgentLoop。`query()`、`startup()`、session helpers、`tool()` 和 `createSdkMcpServer()` 是 Claude Agent SDK-like façade；尚未由 Gateway 协议兑现的 Claude 选项会显式返回 `unsupported_capability`，不会静默改变运行语义。

`query()`、`streamInput()`、`steer()` 和 `client.runs.start()` 的输入同时接受 PilotDeck 的 `{ type: "text", text }` 和 Claude 风格的 `{ type: "user", message: { role: "user", content } }` 文本消息；SDK 会在提交 Gateway turn 前统一规范化。取消观察操作抛出可通过 `instanceof AbortError` 识别的错误，Gateway-owned run 的最终取消结果仍使用 `result.status === "aborted"` 表达。

连接可选配置 `reconnect: { maxAttempts, initialDelayMs, maxDelayMs, jitter }` 只重试初始 WebSocket/hello 阶段的 transient transport 或 timeout；认证失败、协议不匹配和已经提交的 turn 不会自动重放。活动 stream 断线仍返回 `result_unknown`，由调用方查询 Gateway 状态后决定下一步。

工具有两种明确模式：`createSdkMcpServer()`（`createPilotDeckMcpServer()` 是同义别名）会在 SDK 调用者的 Node.js 进程启动标准 Streamable HTTP MCP endpoint；Gateway 经已有 MCP → ToolRegistry → PermissionRuntime 路径发现并调用 handler。它不会在 WebSocket 上传输 JavaScript function。若 Gateway 是远程主机，调用者必须提供 Gateway 可达的 `publicUrl`。另一种是 Node.js embedded 宿主使用 `@pilotdeck/sdk/embedded` 的 `createEmbeddedPilotDeckHost()` 或低层 `createEmbeddedToolRegistry()` 注册本地 `tool()` handler；handler 由原生 ToolRegistry 执行，不经过 callback RPC。

Embedded 同时支持无 TCP listener 的 Query/WarmQuery transport 和完整 typed resource client：宿主先创建并拥有 Gateway，再用 `createEmbeddedGatewayEndpoint()` 提供内存 protocol endpoint。`createEmbeddedQuery()`、`startupEmbedded()` 与 `createEmbeddedPilotDeckClient()` 仍走正常 Gateway wire dispatcher，不会直接创建 AgentLoop 或接管 session、permission、transcript、storage、模型或 sandbox。推荐的 `createEmbeddedPilotDeckHost()` 将 typed client、可选本地工具和 registry attachment 组合到可关闭对象；关闭时它只关闭 SDK endpoint 并 detach 工具订阅，绝不会 dispose 传入的 Gateway 或再次改写其 native tool state。一个 endpoint 只执行一次 hello；client 的控制面和它创建的 Query transport 复用已认证连接，关闭单个 Query 不会关闭 client endpoint。

```ts
import { createEmbeddedPilotDeckHost } from "@pilotdeck/sdk/embedded";
import { tool } from "@pilotdeck/sdk";

// `local` and `endpoint` are created and owned by the embedding PilotDeck host.
const embedded = createEmbeddedPilotDeckHost({
  connection: { endpoint, token: "embedded-sdk-token" },
  gatewayHost: local,
  projectKey,
  localTools: [tool(
    "lookup_ticket",
    "Read a local ticket",
    { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    async ({ id }) => ({ content: [{ type: "text", text: await lookupTicket(id) }] }),
    { annotations: { readOnly: true } },
  )],
});

const run = embedded.client.query("Summarize ticket T-123.");
console.log(await run.result());
await embedded.close(); // `local.dispose()` remains the host's responsibility.
```

`createEmbeddedSessionStore(adapter)` lets the embedding application persist the SDK's optional `sessionStore` event mirror through its own async snapshot store. The adapter receives versioned snapshots and the SDK performs key/schema validation, UUID de-duplication and per-instance append serialization. This is not a Gateway storage replacement: Gateway transcript, checkpoint, artifact, permission and active-run state remain host-owned.

```ts
import { createEmbeddedToolRegistry } from "@pilotdeck/sdk/embedded";
import { tool } from "@pilotdeck/sdk";

const tools = createEmbeddedToolRegistry();
// `createLocalGateway` is provided by the embedding PilotDeck host.
const local = createLocalGateway({ extraTools: tools.list() });
const detach = tools.attach(local);
tools.register(tool(
  "lookup_ticket",
  "Read a local ticket",
  { type: "object", required: ["id"], properties: { id: { type: "string" } } },
  async ({ id }) => ({ content: [{ type: "text", text: await lookupTicket(id) }] }),
  { annotations: { readOnly: true } },
));
// `register()` refreshes attached local Gateways for subsequently-created runtimes.
detach();
local.dispose();
```

```ts
import { createEmbeddedPilotDeckClient } from "@pilotdeck/sdk/embedded";

// `createLocalGateway` and `createEmbeddedGatewayEndpoint` belong to the
// embedding PilotDeck host. The host owns both Gateway lifecycle and token.
const local = createLocalGateway({ /* host runtime dependencies */ });
const endpoint = createEmbeddedGatewayEndpoint({
  gateway: local.gateway,
  token: "embedded-sdk-token",
});

const client = createEmbeddedPilotDeckClient({
  connection: { endpoint, token: "embedded-sdk-token" },
  projectKey,
  channelKey: "embedded",
});
const session = await client.sessions.create();
const run = client.runs.start({
  sessionId: session.sessionId,
  input: { type: "text", text: "Summarize the incident." },
});

for await (const message of run.events()) console.log(message);
console.log(await run.result());

await client.close();
local.dispose();
```

```ts
import { createSdkMcpServer, query, tool } from "@pilotdeck/sdk";

const tickets = createSdkMcpServer({
  name: "tickets",
  tools: [tool(
    "find_ticket",
    "查询工单",
    { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async ({ id }) => ({ content: [{ type: "text", text: await findTicket(id) }] }),
  )],
});

try {
  const run = query({
    prompt: "查询 PDX-123",
    options: { gatewayUrl, authToken, mcpServers: { tickets } },
  });
  for await (const message of run) console.log(message);
} finally {
  await tickets.close();
}
```

当前已兑现的控制面包括：流式 query 与幂等 `result()`、session continue/resume/fork/list/messages/rename/tag/delete、活动 turn 的 `streamInput()`、permission mode、`canUseTool`、`onElicitation`、MCP 状态查询与指定 server 的 `setMcpPermissionModeOverride()`、项目文件读取、模型与 thinking 控制、模型/命令/内置 subagent 查询、当前进程内 file checkpoint rewind、`seedReadState()`、custom system prompt、工具 alias、额外工作目录、明确的内置工具集，以及 `allowedTools` / `disallowedTools` 的会话级工具过滤。`permissionMode: "auto"` 可用于创建或通过 `setPermissionMode()` 切换；SDK 会将它保守映射为 Gateway `default`（初始 base mode 同样为 `default`），不实现 Claude classifier 或自动放行，仍由原生 permission 与 `canUseTool` 决定。`onElicitation` 与 native-elicitation `onUserDialog` adapter 会独立启用 `ask_user_question` 的 Gateway channel，不要求配置 `canUseTool`；它不会放宽、自动回答或导致其他工具的 permission prompt 挂起。MCP 权限覆盖仅在显式调用时生效：`default`/`auto` 都要求审批，`auto` 会返回“无 Claude classifier、采用保守 ask”警告，`null` 清除覆盖。`deleteSession()` 使用独立的持久化删除协议，不等同于 `close_session`。Gateway 缺少权威终态时，SDK 返回 `result_unknown`；不会把断线误报为成功。

Experimental 的 `onUserDialog` 可通过 `supportedDialogKinds` 请求 `input`、`select`、`confirm` 或 `form`。只有显式 opt-in 的 session 才会让 Gateway 注册对应的 request-user 工具；Gateway 发出 `user_dialog.requested`，SDK callback 的回答经 `user_dialog_respond` 返回。Node 命令行应用可直接传入 `createTerminalUserDialogHandler()`：它提供 input/select/confirm 交互，以及按字段渲染的 form；`enum`、scalar、嵌套 object 和本地 `$ref` 可直接提示，组合或未知 schema field 会回退为 JSON 输入。浏览器应用可用 `createBrowserUserDialogHandler()`；默认 driver 惰性使用 native `prompt`/`confirm`，或由应用提供异步 `driver.render(request, { signal })`，让 React、Web Component 或自有 modal 直接消费完整 typed payload 和 form schema。`createDomBrowserDialogDriver()` 还提供框架无关的 DOM modal：它为 string、number/integer、boolean、enum 和 JSON fallback schema field 生成原生 form control，可指定 document、mount 和 CSS class。custom renderer 可返回标准 answer，或返回 `undefined` 回退到 prompt/confirm；无效或 abort 后的迟到回答会 fail-closed。所有 renderer 只负责收集答案，Gateway 仍执行最终 schema 校验并拥有 request id、pending state、取消和 turn-end cleanup。若应用自行渲染界面，可设 `userDialogMode: "manual"`，再用同一 Query 的 `respondUserDialog()` 或独立 client 的 `dialogs.list()`/`.watch()`/`.claim()`/`.release()`/`.respond()` 完成 Gateway 当前仍 pending 的请求；`watch()` 是 server-pushed 的 best-effort 变更提示，另一个 renderer 收到 `requested`、lease 或 settled 事件后仍应通过 `list()` 取得权威快照，重连或漏通知后也必须 resync。若不想自行协调该流程，可用 `createManualUserDialogRenderer(client, { sessionId, render })`：它会先 watch、再 list，并在 Gateway lease 下自动 claim、续租、调用 renderer 和 respond；它不缓存 pending state，也不替 Gateway 恢复旧 turn。`claim()` 返回的 opaque lease 在存活时阻止其他 renderer 答复，释放或超时后可由另一 renderer 接手，`list()` 只显示 expiry，不泄露 token。标准 PilotDeck server 已绑定该通知；嵌入 host 若手工组合 `createLocalGateway()` 与 server，必须调用返回的 `bindServer(server)`。`renderTerminalUserDialog(request)`、`renderBrowserUserDialog(request)` 或 `renderDomBrowserUserDialog(request, options)` 可把该 live request 渲染为同样的回答。answer、abort、timeout 或 turn 结束会删除 live request。

persistent session 在 Gateway restart 后，`dialogs.list()` 会投影 `user_dialog_terminated` recovery record。可对原 request 调用 `respond()`：Gateway 重新校验 input/select/confirm/form answer，成功时写入 durable synthetic user message 并返回 `{ delivered: true, recovered: true, reason: "gateway_restarted" }`；下一条新 turn 会将该 message 作为普通模型上下文。无效 answer 不会消耗 journal，已经处理的 request 会返回 `delivered: false`。这不恢复旧 AgentLoop、turn 或 tool promise。`input` 与 `select` 回传字符串（select 必须是声明的 choice value），`confirm` 回传 boolean，`form` 回传匹配 Gateway form-schema subset 的 object：properties/required、items、enum/const、schema 型 `additionalProperties`、string length/pattern、`email`/`uri`/`uuid`/`date`/`time`/`date-time` format、number range/multipleOf、array length/uniqueItems、object property-count，以及有全局深度/节点、每分支 32 条和每个依赖映射 64 条上限的 `allOf`/`anyOf`/`oneOf`/`not`、`if`/`then`/`else`、`dependentRequired`/`dependentSchemas` 都会校验。完整内置多宿主 JSON Schema UI、持久化 dialog state 和跨 Gateway restart continuation 尚未实现。

终端 renderer 在提交回答前使用 bundled `Ajv` 做本地 structural JSON Schema 预校验；完整 form 若命中 `allOf`、`oneOf`、依赖等组合约束，会重新提示而不是立刻让 callback 失败。无法在 SDK 中编译的 Gateway-local schema extension 则保守交给 Gateway 校验，绝不把本地校验当作最终裁决。

Experimental 的 `sandbox` 支持 Gateway-owned 的工具面收紧，例如 `{ type: "tool_policy", filesystem: "read_only", network: "deny", process: "deny" }`。`filesystem: "read_only"` 会移除写入和编辑工具；`filesystem: "deny"` 会移除全部 `kind: "filesystem"` 工具。两种模式都会移除可绕过该限制的 shell/code/task、MCP/custom 和 subagent bridge；未配置时不会改变默认工具面。

可信 Gateway host 还可以注册 named `host` profile，SDK 只请求名称，例如 `{ type: "host", profile: "bubblewrap", filesystem: "read_only", network: "deny" }`。Gateway 使用该 profile 返回的本地 runner 替换本 session 的 native `bash`，并可在 profile 显式声明 `supportsExecuteCode: true` 时用同一 runner 执行 `execute_code` Python。Bubblewrap Python 仅挂载本次私有 RPC 目录、只收到必要运行变量；read-only/deny/network-deny 还分别要求 `supportsFilesystemReadOnly`、`supportsFilesystemDeny`、`supportsNetworkDeny`，未声明则 fail-closed 隐藏 `execute_code`。命名 host profile 的 `filesystem: "read_only"` 与 `"deny"` 会移除所有 Gateway 进程内 `kind: "filesystem"` native tool 和全部 filesystem helper RPC，包括 `read_file`、`glob`、`grep`，避免只读路径经 ToolRuntime 绕开 profile 的 mount 边界；需要读取 workspace 时应在 profile-owned Bash/Python 进程内完成。MCP/custom/task/subagent 等未受 runner 控制的 bridge 仍隐藏。若需要不让任何直接 native tool 绕开 profile，可显式请求 `toolIsolation: "strict"`：默认只保留 profile-owned `bash` 和 Gateway-local 的 structured output/user-dialog 工具。profile 额外声明 `supportsStrictExecuteCode: true` 时，strict 也可保留同一 runner 下的 Python；`createBubblewrapSandboxProfile({ enableStrictExecuteCode: true })` 是对应 host opt-in。这个 strict Python 得到不含 socket 或 helper function 的 `pilotdeck_tools` 模块，Gateway 同样以空 allowlist 拒绝 raw RPC request，因此不能绕回 native filesystem/network/MCP/process tool。PilotDeck core 提供 `createBubblewrapSandboxProfile()`：在安装了 `bwrap` 的 Linux host 上，它为 Bash/Python 建立空 root、最小只读 runtime、私有 `/tmp`、namespace、清空环境和 project workspace mount。profile 不存在、runner 无效或 cwd 超出 workspace 均会失败；SDK 不能传递 executable、mount、环境或 credential。strict tool surface 不会把 provider、Gateway 进程或既有基础设施移入 Bubblewrap，因此仍不宣称完整 container sandbox。

```ts
const run = query({
  prompt: "先问我要运行哪个测试命令",
  options: {
    gatewayUrl,
    authToken,
    supportedDialogKinds: ["input"],
    onUserDialog: ({ dialogKind, payload }) =>
      dialogKind === "input"
        ? { behavior: "answered", value: "pnpm test" }
        : { behavior: "cancelled" },
  },
});
```

```ts
const run = query({
  prompt: "先问我要运行哪个测试命令",
  options: {
    gatewayUrl,
    authToken,
    supportedDialogKinds: ["input"],
    userDialogMode: "manual",
  },
});

for await (const event of run) {
  if (event.type !== "user_dialog.requested") continue;
  await run.respondUserDialog(String(event.requestId), {
    behavior: "answered",
    value: "pnpm test",
  });
}
run.close();
```

`getContextUsage({ detail: "summary" | "full" })` 会返回 Gateway 原生 TokenBudgetSnapshot（使用量、上下文窗口、输出预留、估算来源、校准信息和 warning/blocking 状态）。`full` 还会给出 Gateway-owned local-tokenizer 的 additive `system`、`tools`、`messages`、`MCP`、`memory` 分类；provider 的精确总量不会被伪装为精确分类。旧 Gateway 或 `summary` 会显式返回 `breakdownAvailable: false`。

`maxBudgetUsd` 是单个 submitted turn 的 Gateway-owned USD ceiling。若需要跨 turn 控制，使用 experimental `taskBudget: { total, scope }`：省略 `scope` 时为一个 SDK session 计账，`scope: "project"` 时同一 Gateway project 的所有 SDK session 共享一个 durable ceiling，并在 Gateway 重启后恢复。project budget 的第一个成功配置会固定 `total`；后续 session 必须传入同一 total，冲突值会在 native session/model 创建前返回 `SDK_PROJECT_TASK_BUDGET_TOTAL_CONFLICT`。SDK 只传 ceiling，绝不会上传或从流式事件累加 spent cost。可运行示例见 `examples/task-budget.mjs`。

通过 `createPilotDeckClient()` 还可以使用 `client.cron` 的 `create/list/update/delete/stop/runNow` 资源方法。它们是对 PilotDeck 原生 `cron_*` Gateway 协议的类型化包装，属于 PilotDeck 专有的产品调度能力。它们不实现、也不声称实现 Claude Query 的 `stopTask()` 或 `backgroundTasks()`：Claude 方法控制的是活动 Bash/subagent task，而 PilotDeck cron 控制的是持久化的定时任务及其运行实例，两者的身份、所有权和生命周期不同。

`systemPrompt: string`、`toolAliases`、`additionalDirectories` 和 `tools: string[]` 会作为序列化 session config 在 turn 开始前由 Gateway 交给既有 AgentRuntimeConfig、PermissionContext 和 ToolRegistry。配置变化仅关闭缓存 session 并让下一个创建动作使用新配置，不改变 AgentLoop、ToolRuntime 或 permission 默认策略。`tools` 必须使用 PilotDeck 工具名；传入 `tools: []` 会显式创建无工具 session，不回退到原生默认工具集。Claude 的 `{ type: "preset", preset: "claude_code" }` 没有同名工具集，显式返回 `unsupported_capability`。

`plugins` 支持 `{ type: "local", path }` 的 absolute Gateway-local plugin directory。Gateway 在 session 构造时加载其 manifest，并以只读 session view 投影 command、skill、hook、output style 和 plugin MCP contribution；这些贡献不修改项目 PluginRuntime，也不会出现在其他 session。路径由 Gateway host 解析，远程 SDK 调用者必须传 Gateway 可见路径；Claude 的 `pluginDelivery: "argv"` 没有等价 Gateway process，显式返回 `unsupported_capability`。可运行示例见 `examples/plugins.mjs`。

`agents` 支持 session-scoped 的 `description`、`prompt`、`tools`、`disallowedTools`、`maxTurns`、`effort`（`low`/`medium`/`high`）、`permissionMode`、Gateway-resolved `model`、`mcpServers`、`skills`、`memory`、`initialPrompt` 和 `criticalSystemReminder_EXPERIMENTAL`，映射到既有 `SubagentDefinition`。每次 child fork 都单独启动其 `McpRuntime`，工具只进入 child registry，并在 fork 结束时关闭；`skills` 只能缩小父 session 的技能域，且同时限制 prompt 投影与 `read_skill`；`memory: "disabled"` 只停用该 child 的 memory retrieval/capture；`initialPrompt` 仅在 child directive 之前注入用户消息，`criticalSystemReminder_EXPERIMENTAL` 仅追加给 child system prompt，二者不会影响 parent session。`background: true` 启动 Gateway-owned non-blocking task；`observer: "<agent-name>"` 在被观察 child 完成后启动无工具、read-only sidechain，接收限长摘要和可选 `observerMessage`，但报告不进入 parent context 或 `backgroundTasks()`/`stopTask()`。二者都是 experimental；Claude experimental callback 面仍返回 `unsupported_capability`。

`thinking` 和已弃用兼容方法 `setMaxThinkingTokens()` 会写入 Gateway 的 session-level thinking override，并在下一个 turn 重建 session runtime；它不会修改 AgentLoop 的默认推理策略。PilotDeck 暂无 thinking summary 生成器，因此 `display: "summarized"` 显式返回 `unsupported_capability`，`display: "omitted"` 由 SDK 隐藏原始 thinking delta。

`rewindFiles()` 仅在 `enableFileCheckpointing: true` 时可用，并要求当前 turn 已结束；dry-run 返回既有 diff 统计，实际 rewind 由 Gateway 调用原生恢复逻辑。file snapshot 与 post-edit fingerprint 持久化在 transcript 中，Gateway 重启后会惰性恢复索引；外部修改返回 `conflicts` 并拒绝覆盖，缺失 backup 不改动 workspace，恢复使用同目录临时文件和原子 rename。

`seedReadState(path, mtime)` 对应 Claude 的“已从 context 移除的 Read 仍可允许后续 Edit”控制。它仅能在 query 的 turn 已结束后调用，并由 Gateway 在同一 session 的原生 AgentLoop 中验证路径和当前 mtime；mtime 一致时写入既有 `readFileState` 与 write snapshot，mtime 不一致时静默跳过，后续 Edit 仍要求重新 Read。它不绕过工作区路径、安全检查或写入 freshness 约束。

`startup()` 会预先完成 Gateway 握手，并返回带 `query(prompt)` 的单次预热句柄；首个 query 复用该连接。

`SessionStore`、`InMemorySessionStore`、Node 专用 `FileSessionStore`、`foldSessionSummary()` 和 `importSessionToStore()` 已按 Claude SDK 的 project/session/subpath key 模型提供。内存实现支持 UUID 去重、mtime 排序、增量 summary 和 subagent subpath。

在 `query()` 中传入 `sessionStore` 会把已消费的公开事件以 `sdk_event` 记录镜像到 store；支持 `sessionStoreFlush: "eager" | "batched"`。该镜像是可选的观察/恢复材料，不取代 Gateway 的权威 transcript，也不会在镜像失败时改变 turn 结果。

`FileSessionStore({ rootDir })` 面向需要跨 SDK 进程保留该镜像的 Node.js 调用方。它用 schema version 1 JSON snapshot、同目录原子替换、UUID 去重和进程内串行写入保存每个 project/session/subpath；`exportSession()` 与 `importSession(snapshot, { mode: "reject" | "append" | "replace" })` 提供显式导入及冲突处理。它绝不会把镜像写回 Gateway、恢复 active turn，或覆盖 Gateway transcript/session。

`mcpServers` 支持 session-scoped 的 `stdio` 与 `streamable_http` server；`setMcpServers()`、`reconnectMcpServer()` 和 `toggleMcpServer()` 只管理 SDK-owned server，不会覆盖 plugin/config-owned MCP。Claude 的旧式 `http` MCP transport 没有 PilotDeck 语义等价项，调用时会返回 `unsupported_capability`。

`createSdkMcpServer()` 还支持 MCP `instructions` 和 server-level `timeout`：前者通过标准 MCP initialize 能力传给 Gateway，后者同时写入 `streamable_http` 配置并在 SDK handler 侧以 abort signal 强制结束超时调用。超时不是重试，也不会改变 Gateway 的 turn/permission 所有权。

Claude 的 `alwaysLoad` 提示可传给 SDK-hosted MCP server 或单个 `tool()`。默认和 `true` 保持原生 eager MCP schema；`alwaysLoad: false` 会把该 MCP 工具从首个模型请求的 schema 移除。对于任意 canonical native、plugin 或 MCP 工具名，也可设置 `options.deferredTools: [{ name, searchHint? }]`。两种来源会由 Gateway 合并成同一个 session-local `search_tools` 目录；模型按工具名称、描述或 `searchHint` 命中后，对应 schema 才会加入下一次 AgentLoop request。工具 handler、MCP transport、permission 和 scheduler 仍走原生路径。空数组、重复名和保留的 `search_tools` 名称会在 SDK/Gateway 边界拒绝；host policy、session sandbox 及 `allowedTools`/`disallowedTools` 已排除的目标不会进入目录。若当前 turn 显式排除了 `search_tools`，目标仍保持隐藏，不会回退为 eager schema。直接调用尚未搜索的名称会返回 `tool_not_found`，不会绕过 deferred boundary。

`options.hooks` 已支持 PilotDeck 原生 lifecycle 事件（包括 `PreToolUse`、`PostToolUse`、`UserPromptSubmit`、session、stop、compact、subagent、permission、elicitation 和 SDK opt-in 的 post-write `FileChanged`）。SDK 在调用者 Node.js 进程启动带随机 bearer token 的 HTTP callback endpoint，并将**仅含 URL、headers、event/matcher 的序列化配置**发送给 Gateway；Gateway 将其合并到现有 `HookRuntime`，因此事件时机、matcher、effect 解释和最终 turn/session 状态仍由原生 runtime 拥有。`FileChanged` 使用隔离的 SDK Hook runtime，只在 SDK 显式配置该事件且 `write_file`、`edit_file` 或 `edit_notebook` 成功后派发，不能回滚已完成写入，也不激活项目 Hook。回调输入投影为 Claude 风格的 snake_case（如 `hook_event_name`、`session_id`、`tool_name`）；嵌套 `tool_input` 保持工具自身 schema。远程 Gateway 必须能访问 endpoint：通过 `hookServer.publicUrl` 提供可达地址，否则 loopback endpoint 会显式返回 `unsupported_capability`。SDK 尚不支持 Claude 独有且没有原生发射点的 hook event（如 `MessageDisplay`、`PostModelSwitch`），也不公开 HookRuntime 内部 executor。

Hook callback 可返回 `{ async: true, asyncTimeout?: number }`，并从第三个参数取得该次调用唯一的 `asyncHookId`。随后通过同一 `Query.submitAsyncHookResult(asyncHookId, { hookSpecificOutput: { additionalContext } })` 把补充上下文交给 Gateway。它是 experimental 的 context-only 能力：Gateway 按 session/run 管理 deadline、turn-end cleanup、幂等和结果状态；只接受 `additionalContext`，不允许迟到结果回写 input、block/allow 工具、改变 permission 或 system message。重复、过期和未知 id 分别返回 `duplicate`、`expired`、`unknown`。

```ts
const run = query({
  prompt: "部署前检查",
  options: {
    gatewayUrl,
    authToken,
    hooks: {
      PreToolUse: [{
        matcher: "sandbox_bash",
        hooks: [async (_input, _toolUseId, { signal }) => {
          if (signal.aborted) return { continue: false, reason: "调用已取消" };
          return { decision: "block", reason: "SDK policy 禁止 shell" };
        }],
      }],
    },
  },
});
```

`outputFormat: { type: "json_schema", schema }` 会被交给已有的 `structured_output` 工具和 Agent runtime 的终止条件；它使用 PilotDeck 的 JSON-schema 子集，并不承诺 Anthropic/OpenAI 的 provider-specific JSON mode。普通 query 的默认输出行为保持不变。

仍属于明确的 alpha/未实现能力：Claude 独有 hook event、会回溯改变 native lifecycle effect 的 deferred hook result、`AgentDefinition` 的完整 callback 面、完整的 Claude settings control，以及完整 usage/account façade。`reloadOutputStyles()` 已通过 Gateway 重新加载 project style registry，修改在下一次 session runtime 构造时生效；没有该 capability 的旧 Gateway 与未支持的 settings key 会返回 `unsupported_capability`，不会静默改变运行语义。`rewindFiles()` 的 durable checkpoint 会在 Gateway 重启后从 transcript 惰性恢复；外部文件修改返回 `conflicts` 并拒绝覆盖，缺失 backup 不会改动 workspace。

`Query.applyFlagSettings()` 是一个显式受限的 Claude-like 适配：当前只接受 `effortLevel: "low" | "medium" | "high" | null` 与 `permissions.defaultMode: "default" | "plan" | "bypassPermissions" | null`。它们按 session 作用域更新下一个 turn 使用的 thinking / permission override，并在配置变化后淘汰缓存 runtime；活动 turn 中调用会返回冲突错误。该方法不是通用 settings 文件写入器，也不实现 Claude 的完整 flag-layer merge、持久化或其他 settings key。

`Query.updateSettings("localSettings", settings)` 是另一条、**Gateway 宿主拥有**的持久化路径：它允许更新 `$PILOT_HOME/pilotdeck.yaml` 中非密钥的 `agent.maxContextTokens`、`agent.maxOutputTokens`、`agent.thinking`、`agent.subagents.default`/`.timeoutMs`、`extension.includeHookEvents`、`extension.builtinPluginsEnabled` 以及 `tools.webSearch.enabled`；`null` 清除相应覆盖。web-search 的 provider、endpoint 与 API key 不可经该 API 改写，内置插件 map 也不会接受任意插件路径。Gateway 先在临时 `PILOT_HOME` 校验完整 YAML，再原子替换文件并通过原生 `PilotConfigStore` 重载。因此它可在首个 turn 前调用，不会因为初始化 query 而抢先提交消息。其余 YAML 字段、密钥、模型/provider 和 Claude settings source 都显式拒绝；配置生效时机仍遵循原生 config reload 的 change class，而非 SDK 自行解释。

`options.settings` 与 `options.settingSources` 提供另一条**非持久、仅当前 session**的 Gateway-owned overlay。`settingSources` 接受 `managed`、`user`、`project`、`local`，Gateway 固定按 `managed < user < project < local` 解析，调用者传入数组的顺序不影响 precedence。后三者分别读取 Gateway 自身 `$PILOT_HOME/pilotdeck.yaml`、`$PROJECT_ROOT/.pilotdeck/pilotdeck.yaml`、`$PROJECT_ROOT/.pilotdeck/pilotdeck.local.yaml`；`managed` 则只读取 embedding host 在 `createLocalGateway({ organizationPolicy: { settings: { managedSessionSettings } } })` 中提供的 non-secret overlay，SDK 只能选择、不能上传、读取或修改该内容。四种 source 都只提取 `agent.model`、`agent.fallbackModel`、context/output token limit、`agent.thinking` 和 subagent default/timeout/depth；显式 `options.settings` 最后覆盖。embedding host 还可配置同一 allowlist 的 `sessionDefaults`/`sessionDefaultSources`，或以 `enforcedSessionSettings` 在 source、SDK overlay、`options.model`/`.fallbackModel` 与 session thinking update 后强制覆盖；该层只作用于 SDK-marked session，直接 Gateway 调用不受影响。模型/provider 凭据、插件、路径、工具和 permission grant 仍不会进入该 overlay，也不会写回任一文件或影响其他 session。

`options.managedSettings` 是 **不持久化、只能收紧** 的 session policy：除 `permissions.deny`、`permissions.ask`、`permissions.defaultMode: "plan"` 与 `permissions.canPrompt: false` 外，还接受 `tools.allow`/`.deny` 的 exact-name、`prefix*` 或 `*` selector，以及 `models.allow`/`.deny` 的 `*`、`provider/*` 或 `provider/model` selector，均为 deny 优先。Gateway 将 permission deny/ask 编译成 `source: "policy"` 的原生 PermissionRule，并在 session remembered allow 之前执行；`canPrompt: false` 会使 native `PermissionContext` 拒绝交互式 permission prompt，且不能被普通 session override 重新开启。tool selector 在 native、plugin、SDK MCP、deferred search 和动态子代理 MCP 都已合入 registry 后才收紧模型可见面，不能注册工具、改变 handler 或绕过 host organization policy/sandbox。model selector 会在 session config、显式 turn/session model、fallback、动态子代理和 Router fallback 的解析路径拒绝未允许模型；项目默认模型越界不会阻断一条显式允许的 `options.model`，Router 会在真实 provider request 前完成最终校验。因此它不能授权工具、选择或配置未允许模型、改写 Gateway 配置、指定 settings source 或携带凭据。完整 Claude managed settings/source cascade 仍会返回 `unsupported_capability`。

顶层 `resolveSettings({ gatewayUrl, authToken })` 读取 Gateway 当前的、已脱敏 `PilotConfigStore` snapshot。返回结果包含 `config`、`sources`、`diagnostics`、schema/version 和 content hash，便于诊断实际生效的配置；它始终以 Gateway 宿主为准，不读取 SDK 调用者本机的 `$PILOT_HOME`，也不返回 provider 凭据。

构建与测试：

```bash
pnpm --dir packages/sdk build
pnpm --dir packages/sdk test
```

可直接复制的安装后示例位于 `examples/`：`basic-run.mjs`、`streaming.mjs`、`permission.mjs`、`resume-fork.mjs`、`abort.mjs`、`mcp-tool.mjs`、`plugins.mjs`、`structured-output.mjs` 和 `task-budget.mjs`。它们会随 `pnpm pack` 纳入 tarball；示例只依赖 `@pilotdeck/sdk` 公共 exports，不导入仓库内部模块。
