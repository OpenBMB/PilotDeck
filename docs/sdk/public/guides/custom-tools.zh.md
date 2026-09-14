# 添加自定义工具

业务工具通常不需要修改 PilotDeck Core。定义工具后，通过 SDK-hosted MCP 或 Embedded registry 接入，Gateway 仍负责 ToolRegistry、PermissionRuntime 和执行生命周期。

```ts
import { createSdkMcpServer, query, tool } from "@pilotdeck/sdk";

const gatewayUrl = process.env.PILOTDECK_GATEWAY_URL!;
const authToken = process.env.PILOTDECK_GATEWAY_TOKEN!;
// 业务应用提供实际实现；这里仅声明示例所需的函数契约。
declare function findTicket(id: string, signal: AbortSignal): Promise<string>;

const tickets = createSdkMcpServer({
  name: "tickets",
  tools: [tool(
    "find_ticket",
    "查询工单状态",
    { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    async ({ id }, { signal }) => ({
      content: [{ type: "text", text: await findTicket(id, signal) }],
    }),
    { annotations: { readOnly: true } },
  )],
});

try {
  const run = query({
    prompt: "查询 T-123",
    options: { gatewayUrl, authToken, mcpServers: { tickets } },
  });
  console.log(await run.result());
} finally {
  await tickets.close();
}
```

工具 schema 应窄化且稳定，长任务响应 `AbortSignal`，错误返回结构化失败。`alwaysLoad: false` 和 `deferredTools` 可延迟大型工具集合；`allowedTools`/`disallowedTools` 只能收紧可见范围。

调用链为：SDK handler -> MCP/Embedded adapter -> Gateway -> ToolRegistry -> PermissionRuntime -> ToolRuntime -> AgentLoop。SDK 工具默认是当前 session-scoped，不会自动成为 CLI/Web/Desktop 的全局工具。

相关：[TypeScript Reference](../reference/typescript.zh.md) · [Errors](../reference/errors.zh.md) · [Examples](../examples/README.zh.md)
