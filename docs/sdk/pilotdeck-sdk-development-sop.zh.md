# PilotDeck SDK 开发与接入 SOP

文档属性：执行约束与交付标准
适用对象：PilotDeck SDK 维护者、Gateway 维护者、需要接入 PilotDeck 的应用工程师
适用基线：`Kaguya-19/refactor/core_agent_loop_0831` 提交 `20b88268dc8fd8d600facf7fc68af907769cc36d`

## 1. 目的

本 SOP 规定 PilotDeck SDK 从需求确认、公共接口设计、Gateway 协议接入、实现、测试到发布的标准流程。它的**唯一目标产物**是一个可安装的、**Claude Code SDK-like** 的 PilotDeck SDK：调用者应能用接近 `query()`、`Options`、`Query`、session helper、`tool()`/MCP、hooks 和 typed messages 的方式使用 PilotDeck。

本 SOP 是 SDK **实现与交付流程**，不是只产出调研、接口设计或协议草案的文档流程。执行本 SOP 后，必须在仓库中交付一个可构建、可打包、可被外部 TypeScript 项目从公共入口导入，并能连接真实 PilotDeck Gateway 完成 agent turn 的 SDK 包。仅完成下列任一项都不算 SOP 完成：

- 只提交 API 对照表、roadmap、类型声明或示例；
- 只新增 Gateway request/response，而没有公共 SDK façade；
- 只封装原始 WebSocket frame，要求调用者理解内部 Gateway 协议；
- 只在仓库源码环境可运行，`pnpm pack` 后无法被独立项目安装使用；
- 方法存在但返回固定值、伪造成功，或把不支持的请求静默忽略。

必须区分仓库内部模块 API 和 `@pilotdeck/sdk` 公共 API。`src/agent`、`src/gateway`、`src/tool` 等内部导出不得因为能被源码引用，就被当作 SDK 公共契约；只有独立 SDK package 的 public `exports` 才是对外接口。

架构基线采用 **Gateway Client SDK**，以现有 Gateway request/response/event 协议为服务端边界。SDK 可以在内部把 Claude-like API 映射到 Gateway，但不得把 `AgentLoop`、`TurnRunner`、`ToolRuntime` 等内部类直接暴露给外部调用者。

“Claude Code SDK-like”表示**调用体验和能力分组对齐**，不表示复制 Claude 的 provider 登录、CLI 二进制、transcript 格式、计费模型或内部实现，也不承诺与 Claude SDK 字节级兼容。

### 1.1 强制交付物

每次以“新增或修改 PilotDeck SDK 能力”为目标执行本 SOP，PR 至少必须包含：

1. 受影响的 `packages/sdk` public type、façade、transport 或协议适配；
2. 对应的 Gateway capability/wire schema（如需要），并说明默认路径不变；
3. SDK 单元测试、fake Gateway 契约测试，及受影响能力的真实 Gateway 黑盒测试；
4. 涉及协议或 runtime 构造边界时，附原生 AgentLoop parity 结果；
5. 最小可运行示例或更新现有 `packages/sdk/examples/`；
6. 更新 [PilotDeck SDK 实现 Roadmap](pilotdeck-sdk-implementation-roadmap.zh.md) 中对应能力条目的状态和交付范围；如公共语义或证据发生变化，同时更新逐函数映射、能力差距矩阵或 changelog，并记录 `unsupported_capability` 行为。

在上述交付物和第 13 节发布门槛全部满足前，新能力只能标记为 alpha/experimental；不得因某个方法名存在就宣称该能力已达到 Claude 语义等价或稳定发布。

## 2. SDK 的职责边界

SDK 对外提供稳定、类型安全的控制面和事件面：

- 连接、认证、能力协商、协议版本检查、超时和断线处理；
- session 创建、查询、恢复、fork、关闭和 transcript 读取；
- turn/run 提交、流式事件消费、steer、cancel、abort 和最终结果获取；
- permission 与 elicitation 请求的接收和响应；
- 模型、命令、项目、文件、skills 和 MCP 等 Gateway 能力的类型化访问；
- 统一的事件、错误、usage、structured output、artifact 和 Gateway 权威 checkpoint 操作的结果表达；SDK 客户端不得补造恢复语义；
- 向后兼容、弃用提示和可诊断日志。

以下职责保留在 PilotDeck 宿主、Gateway 或 Agent Runtime，不下沉到 SDK：

- Agent Loop、模型调用、工具调度和 compaction 的具体实现；
- session、turn、run、operation、transcript 和 checkpoint 的最终状态所有权；
- 权限策略、组织策略和 allow/deny 的最终裁决；
- 工具副作用、sandbox、Bash 进程和文件系统隔离；
- 模型凭证、供应商登录、项目存储和服务端密钥；
- cron、always-on、channel 等产品编排逻辑（SDK 可以提供类型化资源客户端，但不拥有其调度、持久化或运行语义）；
- Gateway 服务端路由、重试和持久化实现。

SDK 不得通过本地缓存伪造服务端成功，也不得维护第二套 session 或 run 状态机。

### SDK-only 修改边界（硬约束）

SDK 开发任务原则上只允许新增或修改 SDK 包、SDK 专属测试、示例和文档。以下原生模块实现为冻结区，不得因 SDK 需求修改其语义、默认值、调度顺序或副作用行为：

- `src/agent/loop/`、`src/agent/turn/`、`src/agent/session/` 的 AgentLoop、TurnRunner、AgentSession 实现；
- `src/tool/` 的 ToolRuntime、ToolRegistry、scheduler、内置工具和结果投影；
- `src/context/` 的 PromptAssembler、token budget、compaction、recovery 和 memory runtime；
- `src/permission/` 的权限 matcher、规则计算和最终 allow/deny 语义；
- `src/session/` 的 transcript、projection、checkpoint、file history 和持久化实现；
- `src/mcp/` 的 MCP transport、runtime 和工具执行生命周期；
- `src/extension/` 的 Hooks、Skills、Plugins 执行逻辑；
- Gateway 服务端的 session/run 路由、状态机和最终结果聚合逻辑。

如果某个 Claude Code SDK-like 选项无法仅以现有 wire schema 表达，允许增加**受限的协议适配注入**。这不是修改原生语义的授权，且必须同时满足：

1. 输入只能来自显式、版本化的 SDK/Gateway envelope；未携带该字段时，既有原生调用走完全相同的默认路径；
2. 注入只在 session/runtime 构造边界翻译为已有模块可理解的可选配置，不能改变 AgentLoop、ToolRuntime、PermissionRuntime、ContextRuntime 或 storage 的默认策略、状态机和副作用次数；
3. 若必须在原生模块类型中增加可选配置字段，该字段默认 `undefined`，并且要证明默认输入的 prompt、工具顺序、权限结果、终态和 transcript 关键事件不变；
4. 改动必须在 PR 中标为“协议适配例外”，列出入口、默认行为、SDK 特有行为和 runtime parity 证据；不能借此处理无关 Runtime bug 或重构内部流程。

例如，Gateway 在创建 session 前把 SDK 的序列化 system-prompt addendum 翻译为已有 runtime config 的可选字段，是受限适配；重排 prompt assembler、改变工具 scheduler 或调整 permission 默认 allow/deny 则不是。

允许修改原生模块的**协议层**，但仅限为 SDK 提供稳定、可验证的 wire contract。协议层例外通常限于以下路径或其等价的新协议目录：

- `src/gateway/protocol/**`；
- `src/agent/modules/protocol.ts`、`src/agent/modules/**` 中只描述 wire schema/validator 的文件；
- `docs/pilotdeck-module-protocol-*.schema.json` 等机器可校验 schema；
- SDK 包自己的 `protocol/`、codec 和 compatibility test。

协议层例外默认不包括 AgentLoop、ToolRuntime、ContextRuntime、PermissionRuntime 或 Session storage 的执行实现；上一段的受限协议适配是唯一例外。协议层改动仅限于：

- Gateway/module protocol 的 schema、version、capability、request/response/event envelope；
- 新增 SDK 所需的只读查询、显式控制消息或兼容字段；
- 协议编解码、版本协商和错误映射所需的 parser/validator；
- 对应的协议契约测试和兼容性测试。

协议改动不得改变原生模块的 Agent Loop 语义行为。若实现 durable checkpoint、output style 或预算终止确实需要修改 Gateway/session/extension 实现，应拆成独立的 Gateway/Runtime 任务；SDK PR 只接入已评审的协议能力。只有协议适配、schema/validator 和对应测试可以并入 SDK PR。

因此，“允许修改原生模块协议”不等于“允许在 SDK PR 内修改模块实现”：

- SDK PR：允许修改 `src/gateway/protocol/**`、协议 codec、capability、validator 和 SDK adapter；
- Gateway/Runtime PR：负责 checkpoint 持久化、output style 生命周期、费用预算等服务端实现；
- 两类 PR 可以串联交付，但必须分别通过协议契约测试和原生语义回归，不得用 SDK PR 掩盖 runtime 行为变化。

以下做法一律禁止：

1. 为了适配 SDK，改变工具执行顺序、并发策略、重试、compaction、permission 默认值或终态判定；
2. 在 SDK PR 中顺手修复原生模块 bug，除非另有独立任务链接且经过语义回归评审；
3. 让 SDK 的类型设计反向驱动原生模块增加第二套 session、run 或 transcript 状态；
4. 用客户端转换掩盖服务端语义变化，或把原生模块已有行为重命名为“协议兼容”；
5. 以“协议字段需要”为理由修改原生模块的默认策略、执行顺序或状态机。

## 3. Claude Code SDK-like 公共契约

具体能力的状态、交付范围、开发排期和版本归属不写入 SOP；开发前必须查阅 Roadmap 的对应条目。需要确认 Claude 语义差异和源码依据时，再查阅能力差距矩阵。

SDK 公共契约必须围绕以下四个抽象设计，而不是只提供原始 Gateway client：

| Claude Code SDK 抽象 | PilotDeck SDK 对外抽象 | 内部实现边界 |
|---|---|---|
| `query({ prompt, options })` | `query({ prompt, options })` | 转换为 session 创建/恢复 + Gateway submit stream |
| `Options` | `PilotDeckOptions` | 只包含 SDK 可控制的配置；宿主 policy 不下沉 |
| `Query extends AsyncGenerator<SDKMessage>` | `PilotDeckQuery extends AsyncGenerator<PilotDeckMessage>` | 事件 mapper、control request、final/result coordinator |
| `tool()` / `createSdkMcpServer()` | `tool()` / `createPilotDeckMcpServer()` | SDK 进程将 handler 暴露为标准 MCP server；Gateway 仍通过 MCP/ToolRegistry 执行、校验和审批 |
| `listSessions()` 等 helper | `listSessions()`、`getSessionMessages()` 等 helper | 映射到 Gateway/session resource |
| `Options.hooks` / `canUseTool` | hooks、permission、elicitation callbacks | 只转发决定，最终状态由 Gateway/runtime 持有 |

### 3.1 顶层入口

实现 Claude Code SDK-like 能力时，公共入口应按以下 façade 形式设计：

```ts
query(params: {
  prompt: string | AsyncIterable<PilotDeckUserMessage>;
  options?: PilotDeckOptions;
}): PilotDeckQuery;

startup(params?: {
  options?: PilotDeckOptions;
  initializeTimeoutMs?: number;
}): Promise<PilotDeckWarmQuery>;

tool<Schema>(
  name: string,
  description: string,
  inputSchema: Schema,
  handler: PilotDeckToolHandler,
  extras?: PilotDeckToolExtras,
): PilotDeckToolDefinition;

createPilotDeckMcpServer(options: PilotDeckMcpServerOptions): PilotDeckMcpServer;

listSessions(options?: ListSessionsOptions): Promise<PilotDeckSessionInfo[]>;
getSessionMessages(sessionId: string, options?: GetSessionMessagesOptions): Promise<PilotDeckMessage[]>;
getSessionInfo(sessionId: string, options?: GetSessionInfoOptions): Promise<PilotDeckSessionInfo | undefined>;
renameSession(sessionId: string, title: string, options?: SessionMutationOptions): Promise<void>;
forkSession(sessionId: string, options?: ForkSessionOptions): Promise<PilotDeckSessionInfo>;
```

实际名称可以按 PilotDeck 语义调整，但必须提供一层面向 Claude SDK 用户的 façade；能力不能只存在于内部 `client.sessions`/`client.runs` 对象、Gateway method 或 wire frame 中。

### 3.2 `PilotDeckOptions`

`PilotDeckOptions` 应按 Claude `Options` 的用户心智模型分组，但只对外承诺 PilotDeck 能兑现的字段：

```ts
type PilotDeckOptions = {
  cwd?: string;
  model?: string;
  maxTurns?: number;
  permissionMode?: PilotDeckPermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  canUseTool?: CanUseTool;
  mcpServers?: Record<string, PilotDeckMcpServerConfig>;
  agents?: Record<string, PilotDeckAgentDefinition>;
  hooks?: PilotDeckHooks;
  outputFormat?: PilotDeckOutputFormat;
  includePartialMessages?: boolean;
  includeHookEvents?: boolean;
  abortController?: AbortController;
  continue?: boolean;
  resume?: string;
  forkSession?: boolean;
  persistSession?: boolean;
};
```

具体字段的支持级别、交付状态、开发排期和版本归属由 Roadmap 维护；逐函数映射和能力差距矩阵记录语义差异与源码证据。SOP 只规定字段不得静默忽略。

字段要求：

- 每个字段必须注明对应的 Gateway capability 和 ownership；
- PilotDeck 尚未支持的 Claude 字段不得静默接受；应在初始化或校验阶段返回 `PilotDeckError`（`code: "unsupported_capability"`）；
- Claude account/login、Claude CLI 或 provider 专属 sandbox 字段等不应伪装成等价字段；
- `getContextUsage({ detail: "full" })` 只能返回宿主实际拥有的 TokenBudgetSnapshot 字段；分类存在时必须标明其来源和估算精度，分类不存在时必须显式返回 `breakdownAvailable: false`，不得由 provider 总量或 SDK 客户端拆造 system/tools/messages/MCP/memory 类别；
- `allowedTools`、`disallowedTools` 和 `canUseTool` 只能影响 SDK 请求表达，不能绕过服务端 permission policy；
- `tools: []` 表示显式无工具 session；不得把空数组当作未设置并回退到宿主默认工具集；
- `resume`、`continue`、`forkSession` 的互斥和优先级必须与文档固定。
- 对涉及 checkpoint、settings、output style 或其他持久化状态的 API，必须以 Gateway 的权威能力和结果为准，不能在 SDK 客户端自行补造恢复语义。

### 3.3 `PilotDeckQuery`

`PilotDeckQuery` 应保持 Claude `Query` 的基本使用习惯：既可 `for await` 消费消息，又能控制当前会话。

```ts
interface PilotDeckQuery extends AsyncGenerator<PilotDeckMessage, void> {
  result(): Promise<PilotDeckResult>;
  interrupt(): Promise<PilotDeckInterruptReceipt | undefined>;
  steer(input: PilotDeckInput): Promise<PilotDeckSteerReceipt>;
  cancelSteer(itemId?: string): Promise<PilotDeckCancelSteerReceipt>;
  abort(reason?: string): Promise<void>;
  setPermissionMode(mode: PilotDeckPermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;
  supportedCommands(): Promise<PilotDeckCommand[]>;
  supportedModels(): Promise<PilotDeckModel[]>;
  mcpServerStatus(): Promise<PilotDeckMcpStatus[]>;
  getContextUsage(options?: { detail?: "summary" | "full" }): Promise<PilotDeckContextUsage>;
  readFile(path: string, options?: ReadFileOptions): Promise<PilotDeckFileRead | null>;
  reloadPlugins(): Promise<PilotDeckReloadResult>;
  reloadSkills(): Promise<PilotDeckReloadResult>;
  reloadOutputStyles(): Promise<PilotDeckReloadResult>;
  rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<PilotDeckRewindResult>;
  setMcpServers(servers: Record<string, PilotDeckMcpServerConfig>): Promise<PilotDeckMcpSetResult>;
  close(): void;
}
```

不能只实现方法名。每个 control method 都必须定义：支持的 transport、request id、超时、幂等性、服务端 capability 和失败错误。

### 3.4 消息和结果

SDK 应提供类似 Claude `SDKMessage` 的判别联合，但使用 PilotDeck 自己的公共 schema：

```ts
type PilotDeckMessage =
  | PilotDeckSystemMessage
  | PilotDeckAssistantMessage
  | PilotDeckUserMessage
  | PilotDeckToolProgressMessage
  | PilotDeckPermissionMessage
  | PilotDeckHookMessage
  | PilotDeckSubagentMessage
  | PilotDeckResultMessage;
```

必须保留 PilotDeck 的真实语义：`completed`、`failed`、`aborted`、`result_unknown` 不得映射成 Claude 的成功字符串；usage、permission denials、artifacts 和 stop reason 需要在 PilotDeck result message 中明确表达。

公共 API 以 `Client + Session + Run + Event + Decision` 为核心：

```ts
const client = createPilotDeckClient({
  gatewayUrl: "wss://pilotdeck.example.com",
  authToken: process.env.PILOTDECK_TOKEN,
});

const session = await client.sessions.create({
  projectKey: "project-123",
});

const run = client.runs.start({
  sessionId: session.id,
  input: { type: "text", text: "定位并修复测试失败" },
  options: {
    maxTurns: 10,
    canUseTool: async () => ({ behavior: "deny", message: "此示例不批准工具调用" }),
  },
});

for await (const event of run.events()) {
  renderEvent(event);
}

const result = await run.result();
await client.close();
```

建议的顶层资源：

```text
PilotDeckClient
  sessions
  runs
  projects
  files
  models
  commands
  skills
  mcp
  config
```

公共 API 不直接返回 `WsEventFrame`、内部 `AgentEvent` 或 JSONL 行。SDK 负责把 wire frame 投影为稳定的 `PilotDeckEvent` 和 `PilotDeckResult`。

## 4. 开发流程总览

每项 SDK 开发按以下顺序执行：

1. 明确使用场景、调用者和非目标；
2. 确认能力属于 SDK、Gateway 还是 Agent Runtime；
3. 冻结协议版本、状态所有权和错误语义；
4. 先定义公共类型和兼容策略；
5. 实现 transport 与资源 façade；
6. 增加契约测试、状态机测试和最小接入示例；
7. 验证断线、取消、审批、重复消息和未知结果；
8. 更新文档、变更记录和迁移说明；
9. 完成发布门槛后再发布版本。

## 5. 第一步：提交 SDK 需求说明

开始编码前，需求说明必须回答：

1. 调用者是谁：Web 服务、桌面应用、CLI、自动化任务还是第三方平台？
2. 使用本地 Gateway 还是远程 Gateway？
3. 需要哪些能力：session、run streaming、permission、MCP、files、skills 或 checkpoint？
4. 调用者是否需要处理用户交互？需要时提供 `canUseTool`/`onElicitation` callback；无法交互时不提供 callback，并配置明确的服务端 permission rules。
5. session、run 和 permission 的最终状态由哪个服务保存？
6. 断线后需要继续观察原 run，还是允许创建新 run？
7. 是否会产生文件、命令或网络副作用？审批由谁处理？
8. 需要支持哪些 Node.js、浏览器和 TypeScript 版本？
9. 哪些 API 必须稳定，哪些允许标记为 experimental？

产物：一页 `sdk-feature-scope.md` 或等价设计任务，包含调用示例、ownership 表、非目标和验收条件。

## 6. 第二步：判断功能归属

| 需求 | 正确归属 | SDK 应做什么 |
|---|---|---|
| 发起 turn、接收流事件 | Gateway + SDK | SDK 提供 `runs.start()` 和 async iterable |
| 修改 Agent Loop 继续/终止规则 | Agent Runtime | SDK 只透传配置和结果，不实现规则 |
| 查询、resume、fork session | Gateway/session data plane | SDK 提供类型化资源方法 |
| 权限审批 UI | 应用 + Gateway permission bus | SDK 暴露请求对象和 decision 方法 |
| 工具执行、并发和 sandbox | ToolRuntime/宿主 | SDK 展示工具事件，不自行执行远端内置工具 |
| 注册本地自定义工具 | Embedded adapter 或 MCP | 只有明确模式时提供独立 API，不混入远程 run |
| 模型目录和模型切换 | Gateway/model runtime | SDK 调用 Gateway，不复制模型配置源 |
| transcript 存储 | 宿主 session storage | SDK 查询和分页，不把本地缓存当权威数据 |
| cron、always-on、channel | PilotDeck 产品层 | 可提供资源客户端，但不得混入 Agent Loop 核心类型 |

如果一项功能需要改变 `AgentLoop`、permission policy 或 transcript 持久化，应拆成服务端任务和 SDK 任务分别评审。若只需要增加协议字段或控制消息，可以在 SDK 任务中修改协议，但必须证明语义行为不变。

## 7. 第三步：冻结协议与所有权

实现前记录以下协议事实：

- Gateway protocol version 和 capability 列表；
- request id、session id、turn id、run id、operation id 的生成方和作用域；
- event `seq` 的单调性、重复消息和 gap 处理方式；
- `final` frame、业务终态和 transport close 的关系；
- cancel、abort、timeout、disconnect 和 result unknown 的区别；
- permission 与 elicitation 的 request id、deadline 和响应幂等性；
- session resume/fork 是否包含 transcript、文件状态和模型选择；
- 未知字段、未知事件和新 capability 的兼容规则。

协议修改单必须额外记录：

- 修改的 schema/协议文件和新增字段；
- 是否改变 protocol version 或仅增加 optional capability；
- 原生模块行为不变的证明方式；
- SDK 与旧 Gateway、旧 SDK 与新 Gateway 的兼容范围；
- 失败回滚方式。

核心 ownership 规则：

| 状态 | 权威所有者 | SDK 行为 |
|---|---|---|
| session | Gateway/session storage | 保存引用，不生成第二套持久状态 |
| turn/run | Gateway/AgentSession | 投影事件并缓存只读快照 |
| operation | Gateway/module host | 透传 identity，不自行改写终态 |
| transcript | session storage | 通过 API 查询，不直接解析服务端内部文件 |
| permission | Gateway/permission runtime | 转发人工决定，超时后 fail closed |
| checkpoint/file history | session/file storage | 提供显式操作和结果，不猜测恢复是否成功 |
| usage | model/router/AgentTurnResult | 原样表达统计范围，不自行推导费用 |

协议不明确时先修订 Gateway schema/SOP，不在 SDK 中依赖字符串猜测或隐式默认值。

## 8. 第四步：设计公共 API

### 8.1 命名和结构

- 使用稳定资源名：`sessions`、`runs`、`projects`、`files`；
- 使用动作动词：`create`、`get`、`list`、`resume`、`fork`、`abort`；
- 公共字段使用 `camelCase`，wire 字段转换集中在 adapter；
- 不把 `src/` 内部路径或类名写入用户代码；
- experimental API 必须放在明确命名空间或标记中。

### 8.2 Run 接口

一个 `RunHandle` 至少应提供：

```ts
interface RunHandle {
  readonly id: string;
  readonly sessionId: string;

  events(options?: { signal?: AbortSignal }): AsyncIterable<PilotDeckEvent>;
  result(options?: { signal?: AbortSignal }): Promise<PilotDeckResult>;
  steer(input: PilotDeckInput): Promise<void>;
  cancelSteer(): Promise<void>;
  abort(reason?: string): Promise<void>;
}
```

要求：

- `events()` 结束不自动等同于业务成功；
- `result()` 只在收到可验证终态后返回；
- transport 中断且无法确认服务端结果时返回 `result_unknown` 类错误；
- 多次调用 `result()` 返回同一个不可变结果；
- `RunHandle.events({ signal })` 和 `result({ signal })` 只取消调用者的本地等待，不会中止 Gateway run；需要中止 run 时必须显式调用 `run.abort(reason)`。

### 8.3 Session 接口

```ts
interface SessionsResource {
  create(input: CreateSessionInput): Promise<Session>;
  get(sessionId: string): Promise<Session>;
  list(input?: ListSessionsInput): Promise<Page<SessionSummary>>;
  resume(sessionId: string): Promise<Session>;
  fork(sessionId: string, input?: ForkSessionInput): Promise<Session>;
  messages(sessionId: string, input?: ListMessagesInput): Promise<Page<SessionMessage>>;
  close(sessionId: string): Promise<void>;
}
```

`resume` 是恢复已有服务端 session，不应隐式创建新 session；`fork` 必须说明 transcript、文件历史、project 和模型状态的复制范围。

### 8.4 事件联合

`PilotDeckEvent` 应是带判别字段的联合类型，至少覆盖：

- `session.started`、`session.ended`；
- `turn.started`、`turn.completed`、`turn.failed`；
- `model.delta`、`assistant.message`；
- `tool.started`、`tool.progress`、`tool.completed`、`tool.failed`；
- `permission.requested`、`permission.resolved`；
- `elicitation.requested`、`elicitation.resolved`；
- `compaction.started`、`compaction.completed`；
- `subagent.started`、`subagent.completed`、`subagent.failed`；
- `usage.updated`、`warning`、`retry.progress`。

每个事件应包含稳定的公共 envelope：

```ts
interface PilotDeckEventBase {
  type: string;
  sessionId: string;
  runId: string;
  sequence: number;
  timestamp?: string;
}
```

不得把每一个内部 `AgentEvent` 自动提升为公共事件。新增公共事件需要兼容性评审。

### 8.5 结果和错误

结果使用判别联合，避免以 `undefined` 表示失败：

```ts
type PilotDeckResult =
  | { status: "completed"; output: unknown; usage?: Usage; artifacts?: Artifact[] }
  | { status: "failed"; error: PilotDeckRunError; usage?: Usage }
  | { status: "aborted"; reason?: string; usage?: Usage }
  | { status: "result_unknown"; recovery?: RecoveryHint };
```

错误至少分为：

- `authentication_error`；
- `protocol_version_error`；
- `validation_error`；
- `permission_denied`；
- `not_found`；
- `conflict`；
- `timeout`；
- `transport_error`；
- `server_error`；
- `result_unknown`。

错误对象保留 `code`、`message`、`requestId`、可选 `details`、`retryable` 和原始 cause。禁止把 permission denial、abort、timeout 或无法确认结果归一化为成功。

## 9. 第五步：实现 Gateway Client

建议的包内分层：

```text
packages/sdk/
  src/
    client.ts
    compat.ts
    transport.ts
    session-store.ts
    hook-server.ts
    mcp-server.ts
    errors.ts
    types.ts
    index.ts
  test/                 # Node test 契约/黑盒测试
```

实现可先采用单文件 transport/client façade；只有当代码规模确实需要拆分时，才按上述逻辑边界拆目录，不要为了匹配示意树而进行无关重构。

实现要求：

1. Transport 只负责连接和 frame 收发，不包含业务状态判断；
2. Protocol 层校验 envelope、版本、request id、sequence 和终态；
3. Resource 层提供人类可理解的方法；
4. Event mapper 负责 wire/internal → public 类型转换；
5. Run coordinator 负责关联 request、event stream 和 final response；
6. permission/elicitation response 必须幂等，并绑定原 request id；
7. 未知事件默认可跳过并保留诊断，不因新增非关键事件让旧客户端崩溃；
8. 未知终态、身份不匹配和 sequence 冲突必须显式报错。

SDK 应复用 `RemoteGateway`/Gateway WebSocket 的 wire 语义，但公共 SDK 类型必须独立定义，不能直接 re-export 所有 Gateway 内部类型。

## 10. 第六步：处理连接、重连和并发

### 10.1 连接生命周期

客户端至少具有以下状态：

```text
idle -> connecting -> ready -> reconnecting -> closing -> closed
                      \-> failed
```

要求：

- `connect()` 幂等；
- `close()` 可重复调用；
- close 后不接受新请求；
- handshake 完成前不发送业务请求；
- protocol/capability 不兼容时快速失败；
- auth failure 默认不无限重连。

### 10.2 请求并发

- 每个请求使用唯一 request id；
- response 必须匹配原请求；
- run event 还需校验 session/run identity；
- 重复 final 视为协议错误或幂等重复，不重复 resolve；
- sequence gap 不得静默忽略；
- 调用者取消本地等待时，不自动假定服务端 operation 已取消。

### 10.3 断线恢复

断线后只能做协议明确支持的恢复：

1. 重连并重新 handshake；
2. 查询 session 或 active turn 状态；
3. 按服务端 cursor/sequence 恢复事件；
4. 无法证明最终状态时返回 `result_unknown`；
5. 不自动重放可能有副作用的 submit 请求，除非服务端支持 idempotency key。

## 11. 第七步：权限和人类交互

应用可通过 `query()`/`runs.start()` 的 `canUseTool` 回调或事件消费模式处理审批，但同一请求只能有一个最终响应：

```ts
const run = client.runs.start({
  sessionId: session.id,
  input: { type: "text", text: "检查并修复问题" },
  options: {
    canUseTool: async (toolName, input, context) => {
      if (toolName === "read_file") return { behavior: "allow", reason: "只读检查" };
      return { behavior: "deny", message: "需要用户确认后才能执行此工具" };
    },
  },
});
```

要求：

- 无处理器、处理器抛错或超时均不得默认 allow；
- decision 绑定 session、run、tool call 和 permission request id；
- `allow once`、session grant 和持久 rule 必须区分；
- SDK 只提交人类决定，不在本地覆盖服务端 policy；
- headless 调用者不得提供 `canUseTool` callback，并必须配置明确的服务端 permission rules；
- elicitation 与 permission 使用不同类型，不能共用模糊的 boolean 回答。

## 12. 第八步：Tools、MCP 与 Embedded 模式

Claude Code SDK-like SDK 的工具职责是：

- 选择或限制服务端可用工具；
- 注册、查询和管理 MCP server 配置；
- 消费 tool call/progress/result 事件；
- 响应 permission 和 elicitation。

不要让远程 SDK 在调用者进程中偷偷执行 PilotDeck 内置工具。

`tool()` 与 `createPilotDeckMcpServer()` 是 SDK 的**行为 API**，不是只保存 schema 的描述对象。SDK 应在调用者 Node.js 进程中启动或接入一个标准 MCP server，让 Gateway 通过 `streamable_http`（或明确支持的等价 transport）发现并调用 handler。这样 handler 的执行位置、连接生命周期和错误边界可见，同时仍由原生 MCP → ToolRegistry → PermissionRuntime 路径保持工具语义。

如果需要自定义本地工具，优先使用 SDK 生成的 MCP server 或显式 MCP 配置：

```ts
const ticketSystem = createPilotDeckMcpServer({
  name: "ticket-system",
  tools: [tool("find_ticket", "查询工单", ticketSchema, findTicket)],
});

const run = client.runs.start({
  sessionId: session.id,
  input: { type: "text", text: "查询 PDX-123" },
  options: { mcpServers: { tickets: ticketSystem } },
});
```

不得把 JavaScript function 放入 WebSocket frame，也不得把 descriptor 当作“已注册工具”而不启动可达的 MCP endpoint。若 Gateway 不可访问 SDK 进程的 endpoint，初始化必须以 `unsupported_capability` 或明确连接错误失败；不得伪造 tool call 成功。

只有在明确建设 Embedded SDK 时，才提供 `tools.register()`。Embedded 模式应使用独立入口，例如 `@pilotdeck/sdk/embedded`，并明确：

- 工具运行在哪个进程；
- permission 和 sandbox 由谁实现；
- transcript 和 checkpoint 保存位置；
- 与 Gateway 模式是否共享公共 event/result 类型；
- 哪些 API 仅适用于 Node.js。

## 13. 第九步：测试门槛

### 13.1 类型和单元测试

至少覆盖：

- public exports 和 TypeScript 类型推断；
- wire frame encode/decode；
- event 与 result 映射；
- error code 映射；
- unknown optional event 兼容；
- invalid identity、非法 sequence 和重复 final；
- permission/elicitation decision 幂等；
- `AbortSignal` 和 timeout 行为。

### 13.2 Transport 契约测试

使用可控的 fake Gateway 覆盖：

- handshake 成功、版本不兼容和 auth failure；
- request/response 并发和乱序 response；
- event stream 正常完成；
- WebSocket 中断、重连和恢复；
- disconnect 后结果可查询和结果未知两种路径；
- heartbeat、服务端 notification 和未知 frame；
- close 时仍有 pending request。

### 13.3 真实 Gateway 集成测试

基础 Gateway 集成测试至少保留以下场景：

1. 创建 session 并完成纯文本 turn；
2. 触发只读工具并收到完整 tool lifecycle；
3. 触发写工具，人工 allow；
4. 人工 deny，结果不被误判为成功；
5. steer 和 cancel steer；
6. abort 运行中的 turn；
7. resume 和 fork session；
8. 查询 transcript、usage 和 artifacts；
9. MCP tool 调用；
10. 客户端断线后恢复或明确返回 `result_unknown`。

每个新增能力还必须增加自身的成功、失败、取消/超时、重连/恢复和状态清理场景。涉及权限时验证不会扩大其他工具权限；涉及持久化时验证进程重启、损坏数据和并发冲突；涉及 reload 时验证当前 turn 与下一 turn 的生效边界。

### 13.4 兼容性测试

至少测试：

- 当前 SDK 对当前 Gateway；
- 当前 SDK 对上一受支持 Gateway；
- 上一 SDK 对当前 Gateway；
- 新增可选字段和事件时旧客户端仍可运行；
- 移除或改变字段时能在版本协商阶段明确失败。

### 13.5 SDK 边界与原生语义回归（必测）

每个 SDK PR 必须证明：协议适配发生了变化，但原生模块的语义行为没有变化。验收至少包括以下五层：

1. **静态边界检查**
   - `git diff --name-only` 默认只允许包含 SDK 包、协议 schema/parser、SDK 测试、示例和文档；
   - 若修改 `src/agent/`、`src/tool/`、`src/context/`、`src/permission/`、`src/session/`、`src/mcp/`、`src/extension/` 的实现文件，PR 默认阻断；只有符合本节“受限协议适配注入”四项条件、并附默认路径 parity 证据的可选配置翻译才可例外通过；
   - 协议文件的修改必须在 PR 描述中列出字段、版本和兼容影响。

2. **SDK 单元和类型测试**
   - 运行 SDK package 的 typecheck、unit tests 和 public export 检查；
   - 覆盖 encode/decode、event mapper、result/error mapper、AbortSignal、timeout、重复 final 和非法 identity；
   - 不得通过修改原生模块测试快照来“放宽”断言。

3. **协议契约测试**
   - 用 fake Gateway 验证 hello、capability、request/response、stream、permission、elicitation 和 final；
   - 注入版本不兼容、sequence gap、重复 event、乱序 response、未知可选字段和未知事件；
   - 断言旧协议客户端与新协议服务端的允许范围。

4. **原生语义回归测试**
   - 在协议改动前后，用同一组固定输入和同一组 fake model/tool/provider，分别运行 AgentLoop contract suite；
   - 对比工具调用顺序、permission 决策、turn stop reason、错误码、消息配对、compaction 边界和 transcript 关键事件；
   - 允许新增协议 envelope 或 metadata，不允许核心事件顺序、终态分类和副作用次数发生变化；
   - 对于允许的非语义差异，必须写入差异白名单并由 Runtime owner 审批。

语义回归的最小比较集必须固定为同一组 prompt、fake model、tool provider、permission decision 和 workspace fixture。比较结果至少包含：

- 工具调用名称、参数和顺序；
- 工具实际执行次数及副作用计数；
- permission allow/deny/ask 结果；
- turn stop reason、错误码和 result status；
- assistant/tool 消息配对和关键事件顺序；
- compaction/recovery 边界；
- transcript、usage 和 checkpoint 的关键字段。

允许变化的内容只能是协议 envelope、sequence、request id、capability 或诊断 metadata；这些变化必须在差异白名单中列出。只要核心事件顺序、终态分类、权限结果或副作用次数变化，即使所有 SDK 测试通过，也判定 SDK PR 不合格。

### 13.6 Claude Code SDK-like API 验收矩阵

每个对外能力在验收单中必须逐项填写以下矩阵。验证目标是“Claude-like 调用体验 + PilotDeck 原生语义保持”，不是 Claude SDK 的实现或二进制兼容：

| Claude-like 能力 | 必须验证的 PilotDeck SDK 行为 | 失败判定 |
|---|---|---|
| `query()` | 字符串 prompt、流式 user message、`for await` 消息消费和唯一 final | 需要调用者直接操作 Gateway frame 或内部 AgentLoop |
| `Options` | cwd、model、maxTurns、permission、MCP、agents、hooks、outputFormat 等受支持字段生效 | 未支持字段被静默接受，或改变宿主 policy |
| `Query.interrupt()` / `close()` | 中断、关闭和 transport disconnect 有可区分结果 | abort 被报告为 completed，或 close 后仍有幽灵事件 |
| `Query` 动态控制 | model、permission mode、MCP、reload、context/usage 等方法按 capability 工作 | 方法无 capability 检查或失败语义不明 |
| `tool()` | schema 校验、tool call、tool result、permission 和错误回填完整 | handler 仅是描述对象、未进入 MCP/ToolRegistry，或绕过 ToolRuntime 的权限与调度 |
| `createSdkMcpServer()` | SDK 进程的 MCP server 可注册、发现、调用、关闭并返回 typed result | MCP 工具未进入 Agent Loop、endpoint 对 Gateway 不可达却未报错，或生命周期无法关闭 |
| session helpers | list/info/messages/rename/fork/resume 的参数和结果稳定 | close 被误当 delete，或 fork 范围不明确 |
| hooks | 原生已发射的 Pre/Post tool、session、stop、compact、subagent 等事件可观察且顺序稳定；block/context/permission effects 仍由 HookRuntime 解释 | callback function 被序列化进 Gateway、endpoint 不可达却未报错、或改变既有 HookRuntime 的事件顺序/终态语义 |
| permissions | `canUseTool` 风格回调支持 allow/deny/ask、超时和幂等 | permission denial、超时或重复响应被当作成功 |
| result/usage/errors | completed/failed/aborted/result_unknown、usage、artifacts、错误码可区分 | transport close 或未知结果被归一化为成功 |
| 新增扩展能力 | 按需求单和 Roadmap 条目验证成功、失败、恢复、ownership 和生效边界 | 只改 SDK 客户端却没有 Gateway ownership，或把尚未验收的能力标成稳定支持 |

验收单必须同时附：

1. Claude-like 最小示例代码；
2. 对应 Gateway capability；
3. public type/export 列表；
4. fake Gateway 测试结果；
5. 真实 Gateway 黑盒结果；
6. 原生语义回归对比结果；
7. 不支持字段或差异的明确说明。

#### 13.6.1 真实 Gateway 黑盒验收
   - 使用打包后的 SDK（不能从 `src/` 导入）连接测试 Gateway；
   - 完成纯文本 turn、只读工具、写工具 allow/deny、steer、abort、resume、fork、MCP 和断线恢复；
   - 断言 SDK 观察到的结果与 Gateway 原生测试记录一致；
   - 任何 permission denial、abort、timeout 或 `result_unknown` 被报告为 completed，均判定验收失败。

### 13.7 SOP 完成判定（Definition of Done）

对于新能力，只有同时满足以下条件，才能标记为“完成”；对于纯文档或内部重构 PR，只需满足受影响的条目并在 PR 中说明豁免原因：

- `pnpm pack` 生成的包可以安装到仓库外的空白 TypeScript fixture；fixture 只能从包名和公开 subpath 导入，不能使用仓库内部相对路径（纯协议/文档 PR 可豁免）；
- fixture 能完成 `query()` 流式消费并取得唯一、可验证的 final result；若 PR 不涉及 run/query，则提供受影响公共 API 的最小 fixture；
- `Query` 的 session 恢复、fork、interrupt、permission callback 和至少一种自定义工具接入路径可以通过公共 API 使用；
- SDK 支持的 `Options` 真实影响对应 Gateway 请求或控制面；不支持的字段在启动阶段抛出 `unsupported_capability`；
- fake Gateway 契约测试覆盖握手、认证失败、版本不匹配、乱序响应、sequence gap、重复终态、断线和取消；
- 真实 Gateway 黑盒测试覆盖第 13.3 节场景，并从打包后的 SDK 执行；仅协议 schema/validator PR 可用等价的 Gateway contract test 替代；
- runtime parity 测试证明工具调用顺序、权限结果、终态、compaction/recovery 边界、transcript 关键字段和副作用次数未改变；
- `git diff --name-only` 未包含冻结的原生模块实现，或每个受限协议适配例外均有 capability、兼容性、默认路径语义不变和 SDK 特有行为的证据；
- README、API reference、逐函数映射和差异矩阵与实际 public exports 一致，不把内部实现存在描述为 SDK 已支持。

任一门槛未通过时，验收结论必须列出未完成项和对应错误，不得以“接口已定义”“协议已预留”或“单元测试通过”替代 SDK 完成交付。

当前仓库的基础验收命令如下。项目要求 Node.js `>=22.13.0 <23`；不得在不满足 engine 的 Node 版本下把 warning 当作完整验收通过。

~~~bash
pnpm --dir packages/sdk typecheck
pnpm --dir packages/sdk test
pnpm --dir packages/sdk pack --pack-destination /tmp/pilotdeck-sdk-pack
~~~

Gateway 控制面、打包安装和现有 SDK E2E 使用仓库测试入口：

~~~bash
pnpm build
node --test --test-force-exit --test-timeout 60000 \
  dist/tests/gateway/sdk-controls.spec.js \
  dist/tests/sdk/package-install.spec.js \
  dist/tests/sdk/agents-e2e.spec.js \
  dist/tests/sdk/seed-read-state-e2e.spec.js
~~~

涉及 AgentLoop、TurnRunner、ToolRuntime、PermissionRuntime、ContextRuntime 或 session/checkpoint 构造边界时，再运行 parity harness：

~~~bash
python3 tools/agent-loop-parity/run.py
~~~

文档和变更范围检查：

~~~bash
git diff --check
git diff --name-only
rg -n '\]\(([^)#]+)\)' docs/sdk
~~~

不要默认运行整个仓库 `pnpm test`；只有共享运行时行为、构建产物或广泛 Gateway 路径被影响时才运行全套。环境无法运行真实 Gateway 或 parity 时，不得宣称通过，应报告未执行项和原因。

## 14. 第十步：文档与示例

每个稳定 API 必须提供：

- 一段最小可运行示例；
- 参数、返回值和错误说明；
- 是否会产生副作用；
- session/run/permission 的 ownership；
- 取消和超时语义；
- Node.js、浏览器和运行环境限制；
- 首次引入版本及弃用版本；
- 对应 Gateway capability 或协议版本。

SDK 示例统一位于 `packages/sdk/examples/`：

```text
examples/
  basic-run.mjs
  streaming.mjs
  permission.mjs
  resume-fork.mjs
  abort.mjs
  mcp-tool.mjs
  plugins.mjs
  structured-output.mjs
```

示例不得依赖仓库内部相对路径或未导出的源码类。

## 15. 第十一步：版本和兼容策略

建议采用语义化版本：

- patch：bug fix、文档、内部重构、可选事件支持；
- minor：新增向后兼容的资源方法、事件或选项；
- major：删除/重命名 API、改变默认行为、改变结果或错误语义。

兼容原则：

- 公共 TypeScript 类型、运行时行为和 wire compatibility 分别评估；
- 新字段优先 optional；
- 未知事件默认忽略并记录诊断；
- 未知终态不能忽略；
- deprecated API 至少保留一个约定的发布周期；
- SDK 版本不等于 Gateway protocol version，两者分别维护；
- 每个 SDK 版本声明支持的 Gateway protocol 范围。

建议初期在 `0.x` 中标记 API 稳定级别：`stable`、`experimental`、`internal`。只有 `stable` 进入根 package exports。

## 16. 第十二步：发布流程

发布前依次完成：

1. 确认所有 public exports 都有文档；
2. 运行 typecheck、unit、contract 和 Gateway integration tests；
3. 使用打包产物运行 examples，不从源码目录导入；
4. 检查 package `files`、`exports`、types 和 source map；
5. 检查安装后不会依赖 monorepo 私有路径；
6. 更新 changelog、兼容矩阵和迁移说明；
7. 发布 prerelease 并由至少一个真实调用方验证；
8. 通过验证后发布稳定版本；
9. 保留上一版本的回滚方法。

建议的 npm exports：

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./embedded": {
      "types": "./dist/embedded.d.ts",
      "import": "./dist/embedded.js"
    }
  }
}
```

`./embedded` 仅在实现并验证本地运行模式后发布；第一阶段可以只发布根 Gateway Client 入口。

## 17. 人类应用接入 SOP

第三方或产品应用按以下步骤接入：

### 17.1 准备

1. 获取 Gateway URL、认证方式和支持的 protocol version；
2. 确认 project id 与工作目录由谁创建；
3. 决定 permission 和 elicitation 由 UI、后台策略还是人工队列处理；
4. 明确应用是否允许写文件、执行命令和访问网络；
5. 确认断线后的用户体验和恢复策略。

### 17.2 建立连接

```ts
const client = createPilotDeckClient({
  gatewayUrl: process.env.PILOTDECK_GATEWAY_URL!,
  authToken: process.env.PILOTDECK_TOKEN!,
  timeoutMs: 30_000,
});

await client.connect();
```

认证 token 不写入日志、浏览器 bundle 或 transcript。

### 17.3 创建或恢复 session

```ts
const session = existingSessionId
  ? await client.sessions.resume(existingSessionId)
  : await client.sessions.create({ projectKey });
```

应用持久化 PilotDeck `session.id`，不要用 UI tab id、用户 id 或本地随机 id 替代。

### 17.4 注册审批处理器

```ts
const canUseTool = async (toolName, input, context) => {
  const decision = await renderPermissionDialog({ toolName, input, context });
  return decision === "allow"
    ? { behavior: "allow" }
    : { behavior: "deny", message: "用户拒绝" };
};
```

没有审批 UI 的后台服务不得提供 `canUseTool`，并必须配置明确的服务端 permission rules。

### 17.5 提交并消费 run

```ts
const run = client.runs.start({
  sessionId: session.id,
  input: { type: "text", text: userText },
  options: { canUseTool },
});

for await (const event of run.events()) {
  renderEvent(event);
}

const result = await run.result();
```

UI 应根据 event type 更新状态，不通过解析 assistant 文本猜测工具、权限或完成状态。

### 17.6 处理终态

```ts
switch (result.status) {
  case "completed":
    showResult(result.output);
    break;
  case "failed":
    showError(result.error);
    break;
  case "aborted":
    showCancelled(result.reason);
    break;
  case "result_unknown":
    offerStatusRefresh(result.recovery);
    break;
}
```

`result_unknown` 后不得自动再次提交相同写操作。应先查询 session/run 状态或让用户确认。

### 17.7 关闭

```ts
await client.close();
```

应用关闭前决定是否 abort 活跃 run。断开客户端连接不等于终止服务端 run。

## 18. Code Review 检查表

SDK PR 必须逐项检查：

- [ ] 需求属于 SDK 层，没有复制 Agent Runtime 或 Gateway 状态机；
- [ ] 修改范围只包含 SDK、协议适配、测试、示例和文档；
- [ ] 未修改原生模块语义实现；如使用受限协议适配例外，已提供默认路径语义不变证明、SDK 特有行为说明和兼容矩阵；
- [ ] 公共 API 不暴露内部源码路径或 wire frame；
- [ ] session/run/operation/permission ownership 已写明；
- [ ] event、result 和 error 使用判别联合；
- [ ] cancel、abort、timeout、disconnect、result unknown 已区分；
- [ ] permission/elicitation 在异常路径 fail closed；
- [ ] 重连不会自动重放有副作用请求；
- [ ] 新字段和事件有向后兼容策略；
- [ ] public exports、示例和文档同步更新；
- [ ] focused unit/contract/integration tests 已通过；
- [ ] SDK 边界检查、原生语义回归和打包产物黑盒测试已通过；
- [ ] 未把内部实现存在误写成已发布稳定 SDK 能力。

## 19. 规划文档引用

本 SOP 只规定 SDK 的开发边界、交付流程和验收标准，不列当前已实现能力或 P0/P1/P2 待实现项。能力现状、待实现范围、优先级与版本承诺由 Roadmap 独立维护；其他文档只用于补充语义和证据。开发和验收时按以下文档确定范围：

- [PilotDeck SDK 实现 Roadmap](pilotdeck-sdk-implementation-roadmap.zh.md)：能力现状、优先级、里程碑和版本承诺；
- [SDK 能力差距矩阵](sdk-capability-gap-matrix.zh.md)：等价性、差异影响和源码证据，不定义优先级；
- [Claude Agent SDK 与 PilotDeck 逐函数对应](claude-agent-sdk-pilotdeck-function-map.zh.md)：公共函数、类型和语义入口的逐项对应。

新能力立项时必须引用 Roadmap 条目；能力完成后必须更新 Roadmap 和相应矩阵，不得只修改 SOP。

## 20. 完成定义

一项 SDK 功能只有同时满足以下条件才算完成：

- 有明确的人类调用场景和 ownership；
- 有稳定公共类型，不要求调用者引用 `src/`；
- 正常、失败、取消、超时、断线路径都有定义；
- Gateway capability 和最低协议版本已记录；
- 类型、契约和真实 Gateway 测试通过；
- 最小示例可从安装后的包运行；
- 文档、changelog 和兼容矩阵已更新；
- 不会把未知结果、权限拒绝或 transport close 误报为成功。

## 相关文档

- [审计说明与结论](README.zh.md)
- [PilotDeck SDK 实现 Roadmap](pilotdeck-sdk-implementation-roadmap.zh.md)
- [Claude Agent SDK 与 PilotDeck 语义映射](claude-agent-sdk-pilotdeck-mapping.zh.md)
- [PilotDeck 当前可复用表面](pilotdeck-sdk-current-surface.zh.md)
- [SDK 能力差距矩阵](sdk-capability-gap-matrix.zh.md)
- [AgentLoop 模块接入开发 SOP](../agent-loop-development-sop.zh.md)
- [Module Communication SOP](../pilotdeck-module-communication-sop.zh.md)
