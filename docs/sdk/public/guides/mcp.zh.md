# MCP

`createSdkMcpServer()` 在 SDK 进程启动 Streamable HTTP endpoint，Gateway 通过标准 MCP runtime 发现和调用工具：

```ts
const server = createSdkMcpServer({ name: "tickets", tools: [ticketTool] });
try {
  const run = query({ prompt: "查询 T-1", options: { mcpServers: { tickets: server } } });
  console.log(await run.result());
} finally { await server.close(); }
```

远程 Gateway 必须能访问 endpoint；跨机器时配置 `publicUrl`。不能把 JavaScript function 放进 WebSocket frame。服务器和 handler 的关闭应放在 `finally` 中，`close()` 必须幂等。

SDK 也能通过 `setMcpServers()`、`toggleMcpServer()`、`reconnectMcpServer()` 和 `mcpServerStatus()` 管理 session 内 MCP。未知 transport 或不支持的字段必须返回 `unsupported_capability`，不能静默改用另一种 transport。
