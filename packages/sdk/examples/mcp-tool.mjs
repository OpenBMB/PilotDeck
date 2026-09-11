import { createPilotDeckMcpServer, query, tool } from "@pilotdeck/sdk";

const server = createPilotDeckMcpServer({
  name: "example-tools",
  tools: [tool(
    "lookup_status",
    "Return a status string for an id.",
    { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    async ({ id }) => ({ content: [{ type: "text", text: `status:${id}` }] }),
  )],
});

try {
  const run = query({
    prompt: "查询 PDX-123 的状态。",
    options: {
      gatewayUrl: process.env.PILOTDECK_SDK_GATEWAY_URL,
      authToken: process.env.PILOTDECK_SDK_AUTH_TOKEN,
      mcpServers: { "example-tools": server },
    },
  });
  for await (const event of run) {
    if (event.type === "tool.completed") console.error("tool completed", event.toolName);
  }
  console.log(JSON.stringify(await run.result(), null, 2));
  run.close();
} finally {
  await server.close();
}
