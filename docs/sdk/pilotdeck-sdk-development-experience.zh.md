# PilotDeck SDK 开发经验与接入指南

本文面向希望把业务应用接入 PilotDeck 的开发者。重点是如何使用 `@pilotdeck/sdk` 开发业务能力，以及如何在不修改 PilotDeck Core 的前提下接入自定义工具、MCP、审批和会话控制。


## 1. 先理解架构边界

```text
业务应用
  -> @pilotdeck/sdk
    -> Gateway / WebSocket / MCP
      -> Native AgentLoop
        -> ToolRuntime / Permission / Session / Storage
```

### SDK 负责什么

- 连接、认证、hello 和 capability 协商；
- `query()`、`startup()`、session、run 和流式事件；
- resume、fork、transcript、checkpoint 等 Gateway 控制面；
- 将 permission、elicitation、hooks 和 dialog 请求交给应用处理；
- 自定义工具和 MCP server 的接入；
- 统一类型、错误、取消、超时和 `result_unknown` 表达；
- Remote Gateway 和 Embedded Gateway 的调用 façade。

### Gateway 负责什么

- session、turn、run 和 operation 的权威状态；
- 协议路由、事件投影、权限请求和持久化；
- host organization policy、模型配置和 provider policy；
- MCP connection、工具注册、重连和资源生命周期；
- 将 SDK 配置翻译为 Native runtime 可以理解的可选 session 配置。

### Native Core 负责什么

- AgentLoop、TurnRunner 和上下文组装；
- 模型调用、重试、fallback、usage 和 compaction；
- ToolRuntime、scheduler、工具副作用和结果投影；
- PermissionRuntime 的最终裁决；
- transcript、file history、checkpoint、artifact 和 subagent 状态。

SDK 不创建第二套 AgentLoop、session 状态机、权限系统或权威 transcript。SDK 中的本地缓存只能作为事件镜像或调用方 UI 状态，不能替代 Gateway 状态。

## 2. 选择接入方式

| 方式 | 工具 handler 运行位置 | 网络要求 | 权限和生命周期所有者 | 是否需要修改 Core |
| --- | --- | --- | --- | --- |
| Remote Gateway | SDK 调用方进程或外部 MCP server | SDK 能访问 Gateway；SDK-hosted MCP 还必须能被 Gateway 访问 | Gateway / Native Core | 业务工具通常不需要 |
| SDK-hosted MCP | SDK 调用方 Node.js 进程 | Gateway 必须能访问 Streamable HTTP endpoint；跨机器需 `publicUrl` | Gateway 管 MCP；Native 管执行和权限 | 不需要 |
| Embedded | SDK 与 Gateway 宿主同一进程 | 无需 TCP，可使用 embedded endpoint | 宿主 Gateway / Native Core | 不需要；只使用 `updateSubsystems()` 适配边界 |

简单任务使用 `query()`；需要多个 session、资源查询或动态控制时使用 `createPilotDeckClient()`；同进程应用且需要本地 handler 时使用 `@pilotdeck/sdk/embedded`。

## 3. 例子：不修改 Core 添加业务工具

### 3.1 Remote Gateway + SDK-hosted MCP

```ts
import { createSdkMcpServer, query, tool } from "@pilotdeck/sdk";

const tickets = createSdkMcpServer({
  name: "ticket-tools",
  tools: [
    tool(
      "lookup_ticket",
      "查询工单状态",
      {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      async ({ id }, { signal }) => ({
        content: [{ type: "text", text: await lookupTicket(id, signal) }],
      }),
      { annotations: { readOnly: true } },
    ),
  ],
});

const run = query({
  prompt: "查询工单 T-123 的状态",
  options: {
    gatewayUrl: process.env.PILOTDECK_GATEWAY_URL,
    authToken: process.env.PILOTDECK_GATEWAY_TOKEN,
    mcpServers: { tickets },
  },
});

try {
  for await (const event of run) {
    if (event.type === "tool.completed") {
      console.log("tool completed", event.toolName);
    }
  }
  console.log(await run.result());
} finally {
  run.close();
  await tickets.close();
}
```

实际执行链路是：

```text
SDK tool handler
  -> Streamable HTTP MCP endpoint
  -> Gateway MCP runtime
  -> ToolRegistry
  -> PermissionRuntime
  -> ToolRuntime / scheduler
  -> AgentLoop
```

JavaScript function 不会被序列化进 WebSocket frame。SDK 进程负责暴露 MCP endpoint，Gateway 负责发现并调用它；远程 Gateway 不可达时应让初始化失败，不要伪造工具成功。

### 3.2 例子：Embedded 本地工具

```ts
import { tool } from "@pilotdeck/sdk";
import { createEmbeddedPilotDeckHost } from "@pilotdeck/sdk/embedded";

const embedded = createEmbeddedPilotDeckHost({
  connection: { endpoint, token: "embedded-token" },
  gatewayHost: localGateway,
  localTools: [
    tool(
      "lookup_ticket",
      "查询工单状态",
      { type: "object", properties: { id: { type: "string" } } },
      async ({ id }) => ({
        content: [{ type: "text", text: await lookupTicket(id) }],
      }),
      { annotations: { readOnly: true } },
    ),
  ],
});

const run = embedded.client.query("查询 T-123");
console.log(await run.result());
await embedded.close();
// localGateway.dispose() 仍由宿主负责。
```

Embedded 工具通过 `updateSubsystems()` 附着到宿主 Gateway，仍由原生 ToolRegistry、PermissionRuntime、scheduler 和 AgentLoop 执行。`embedded.close()` 只解除 SDK attachment 并关闭 SDK endpoint，不销毁宿主 Gateway。

### 3.3 说明

- 新增业务 API、数据库、工单或内部服务工具，通常只需要 SDK/MCP 代码；
- SDK 工具默认只属于配置它的 session，不会自动变成 CLI、Web 或 Desktop 的全局内置工具；
- 希望全局可见时，应走 Plugin/config/native tool registry 评审，而不是偷偷修改 SDK 默认工具表；
- SDK 工具仍必须经过 Gateway 的权限、工具过滤、调度、超时和错误处理；
- 只有需要改变 AgentLoop 语义、全局工具注册或 OS 隔离时，才需要 Native/Gateway 改动。

## 4. Session、Run 和事件

### 推荐用法

- 单次任务：`query({ prompt, options })`；
- 预热连接：`startup({ options })`，再调用返回对象的 `query()`；
- 多轮控制：`createPilotDeckClient()`，使用 `client.sessions` 和 `client.runs`；
- 读取结果：先消费 `for await (const event of run)`，再调用幂等的 `run.result()`；
- 真正终止服务端任务：调用 `abort()` 或 `stopTask()`；
- 仅释放客户端 socket：调用 `close()`。

`close()` 不等于 abort，也不等于删除 session。transport 断开且 Gateway 没有可验证终态时，结果必须表达为 `result_unknown`，调用方应重新连接并查询状态，而不是自动重放可能有副作用的提交。

### 持久化边界

- `resume` 恢复 Gateway 已持久化的 session/transcript；
- `fork` 的 transcript、file history、sidechain 和 MCP 范围以 Gateway 返回的结果为准；
- checkpoint 可以恢复文件快照，但外部文件修改时应返回冲突并拒绝覆盖；
- transcript 可以恢复历史上下文，但不会恢复重启前的 active turn 或 tool promise；
- SDK `SessionStore` 是可选事件镜像，不是 Gateway transcript 的替代品。

## 5. 权限、人机交互和 settings

### 权限

`canUseTool` 只提交应用或人类的决定，最终裁决仍在 Gateway/PermissionRuntime：

- 没有 callback、callback 超时或 callback 抛错时必须 fail closed；
- 决定必须绑定 session、run、tool call 和 permission request id；
- deny、abort、timeout 和 transport failure 不能映射为 completed；
- `managedSettings` 只能收紧权限、工具和模型，不能授予权限；
- host organization policy 和 enforced settings 优先于 SDK session overlay。

### Dialog 和 elicitation

permission 是“是否允许工具执行”，dialog/elicitation 是“向用户收集输入”，二者不要共用一个模糊 boolean。`supportedDialogKinds` 只在 owning SDK session 注册对应工具；manual renderer 需要在断线或漏通知后通过 `list()` resync。Gateway 重启后的 dialog 只能生成 recovery record，并作为下一 turn 的 synthetic user context，不会恢复旧 tool promise。

### Settings

- `options.settings`：当前 session 的非持久 overlay；
- `settingSources`：选择 Gateway 可见的 managed/user/project/local source，优先级由 Gateway 固定；
- `managedSettings`：session-scoped restrictive policy；
- `updateSettings("localSettings", ...)`：Gateway host-owned 的受限持久化入口；
- `resolveSettings()`：读取 Gateway 的脱敏配置快照和来源；
- provider credentials、任意插件路径、组织策略和 enforced settings 不由远程 SDK 修改。

## 6. Hooks、Plugins、MCP 和 Subagents

- hooks callback 运行在 SDK 进程时，Gateway 必须能访问 callback endpoint；
- 当前 async hook 主要是 context-only 回传，不支持任意迟到的 block/allow 或 input rewrite；
- plugin 路径必须对 Gateway host 可见，plugin contribution 默认是 session view；
- dynamic `AgentDefinition` 的 tools、MCP、skills、memory、background 和 observer 都应保持 child/session scope；
- fork-local MCP 在 child 创建时快照并在 child 结束时关闭，不能污染 parent 或其他 session；
- Claude 专属 callback、CLI、账号、host sandbox 和不支持的 MCP transport 必须显式返回 `unsupported_capability`。


## 8. 如何应用 SDK 开发内容

SDK 修改不会自动注入正在运行的 PilotDeck。要让修改生效，必须让业务应用实际使用新 SDK，并在协议发生变化时部署匹配版本的 Gateway。

### 8.1 只有 SDK 代码变化

适用于修改 `query()` façade、类型、事件映射、MCP server、Embedded client 或业务工具 handler：

```text
修改 SDK
  -> 构建和测试
  -> 打包/发布 SDK
  -> 业务应用升级依赖
  -> 重启业务应用
  -> 新 query/session 使用新代码
```

开发阶段可以使用 workspace 构建；外部应用应验证打包产物：

```bash
pnpm --filter @pilotdeck/sdk build
pnpm --filter @pilotdeck/sdk pack
pnpm add /path/to/pilotdeck-sdk-*.tgz
```

应用只能从公共入口导入：

```ts
import { query, tool, createSdkMcpServer } from "@pilotdeck/sdk";
import { createEmbeddedPilotDeckHost } from "@pilotdeck/sdk/embedded";
```

不要从仓库 `src/` 相对路径导入，也不要依赖旧的 workspace symlink 或缓存包。修改 SDK handler 后要重启业务应用和 MCP server；已经运行的 turn 不会被动态替换。

### 8.2 新增 SDK 工具后的应用流程

Remote Gateway + SDK-hosted MCP 的应用流程是：

1. 使用新版本 SDK 启动 MCP server；
2. 将 server 放入 `query({ options: { mcpServers } })` 或 session 的 MCP 配置；
3. 确认 Gateway 能访问 endpoint，跨机器时配置可达的 `publicUrl`；
4. 创建新的 query 或 session runtime；
5. 用 prompt 触发工具并观察 tool lifecycle；
6. 重启应用后再次验证 handler 版本。

建议让工具返回可识别的版本标记：

```ts
content: [{ type: "text", text: "business-tools@1.2.0" }]
```

至少应观察到：

```text
tool.started: lookup_ticket_v2
tool.completed: lookup_ticket_v2
```

如果使用 Embedded，必须在创建 query 前通过 `localTools` 或 `registry.register()` 注册工具。注册只刷新后续创建的 runtime；正在执行的 turn 不应被动态替换。

### 8.3 SDK 与 Gateway 协议同时变化

如果 SDK 修改新增了 Gateway request、event、capability、session control 或 settings 字段，SDK 和 Gateway 必须一起部署：

```text
SDK 升级 + Gateway protocol/adapter 升级
```

推荐顺序：

1. 先部署兼容版本 Gateway；
2. 通过 `initializationResult()` 检查 server version 和 capabilities；
3. 再升级业务应用中的 SDK；
4. 对旧 Gateway 不支持的能力返回 `unsupported_capability`，不得静默忽略。

如果只是 SDK 本地事件映射或本地 API 变化，没有修改 Gateway 协议，则不需要升级 Gateway；重启业务应用即可。

### 8.4 Settings 的生效时机

不要只依据 SDK 方法返回成功判断配置已生效，应确认对应的 session/runtime 边界：

- `options.settings`：session 创建或下一 turn runtime 生效；
- `setModel()`、`setPermissionMode()`：影响后续 turn；
- `updateSettings("localSettings", ...)`：修改 Gateway host 的受限配置并触发原生 reload；
- `managedSettings`：只收紧当前 SDK session，不能覆盖 host policy；
- `reloadPlugins()`、`reloadSkills()`、`reloadOutputStyles()`：按 Gateway capability 和下一 runtime 边界生效。

可以通过以下接口确认实际生效的服务端信息：

```ts
const init = await run.initializationResult();
console.log(init.server, init.capabilities);

const settings = await resolveSettings({ gatewayUrl, authToken });
console.log(settings);
```

`resolveSettings()` 返回的是 Gateway host 的脱敏快照，不是 SDK 调用方本机的配置文件，也不包含 provider 凭据。

### 8.5 真实应用闭环

每次 SDK 修改至少完成一次以下闭环：

```text
新 SDK 包
  -> 业务应用启动
  -> 连接目标 Gateway
  -> hello/capability 成功
  -> 创建新 session/query
  -> 配置出现在 Gateway request
  -> 工具出现在 model schema
  -> tool.started
  -> tool.completed
  -> handler 版本标记或真实副作用
  -> 正确 final result
```

启动日志建议记录 SDK 版本、Gateway server version、project/session ID、capabilities 和 MCP server 名称。涉及持久化时还要重启 Gateway，分别检查 transcript、checkpoint、budget ledger 或 dialog recovery；不要把 active turn 恢复当作默认能力。

### 8.6 生效范围判断

| 修改类型 | 生效范围 | 是否影响其他 PilotDeck 功能 |
| --- | --- | --- |
| SDK façade、类型或本地 handler | 使用新 SDK 的业务应用/query | 不影响不使用该 SDK 的应用 |
| SDK-hosted MCP 工具 | 配置该 MCP 的 Gateway/session | 不会自动成为全局 Native 工具 |
| Embedded 工具注册 | 该 Embedded Gateway 宿主及后续 runtime | 不影响其他 Gateway |
| Gateway 协议/adapter | 使用匹配版本协议的 SDK/Gateway | 必须做兼容性和 Native parity |
| AgentLoop、ToolRuntime、PermissionRuntime 等 Core 修改 | 可能影响所有原生入口 | 属于 Core 变更，不是 SDK-only |

最可靠的判断标准不是“代码已经安装”，而是新 SDK 包经过正确 Gateway、session 和工具调用闭环，并能观察到预期的事件、handler 版本标记、状态和最终结果。

## 9. 常见误区和排障顺序

1. **MCP endpoint 不可达**：先从 Gateway host 检查 URL、端口、代理、TLS 和 bearer token，再检查工具 schema。
2. **把 `close()` 当 abort**：先确认调用的是 `abort()`；`close()` 只释放 SDK transport。
3. **断线后重复提交**：先重新 handshake、查询 run/session 状态；无法确认时保留 `result_unknown`，不要自动重放。
4. **工具没有出现**：检查 session scope、`allowedTools`/`disallowedTools`、managed policy、sandbox 和 deferred search。
5. **权限结果异常**：确认 host organization policy、managed deny/ask、remembered allow 和 callback decision 的优先级。
6. **重启后状态不一致**：分别检查 transcript、checkpoint、budget ledger 和 dialog journal；不要假设 active turn 会恢复。
7. **settings 没生效**：检查 source 是否被 host deny、字段是否在 allowlist、配置生效边界是否是“下一 turn”。
8. **测试全通过但行为不一致**：补做 Native baseline/current parity；SDK contract 测试不能替代原生语义回归。