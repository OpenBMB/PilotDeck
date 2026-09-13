import {
  createPilotDeckClient,
  createSdkMcpServer,
  tool,
} from "@pilotdeck/sdk";

const projectKey = process.env.PILOTDECK_PROJECT_KEY;
const client = createPilotDeckClient({
  gatewayUrl: process.env.PILOTDECK_SDK_GATEWAY_URL,
  authToken: process.env.PILOTDECK_SDK_AUTH_TOKEN,
  projectKey,
});

const tickets = createSdkMcpServer({
  name: "ticket-tools",
  tools: [tool(
    "lookup_ticket",
    "Read a ticket by its key.",
    { key: "string" },
    async ({ key }) => ({ content: [{ type: "text", text: `Ticket ${key}` }] }),
  )],
});

try {
  const session = await client.sessions.create({ projectKey });
  await client.mcp.setServers({
    sessionId: session.id,
    servers: { tickets },
    strict: true,
  });

  console.log(await client.mcp.status({ sessionId: session.id }));
  await client.mcp.setPermissionModeOverride({
    sessionId: session.id,
    serverName: "tickets",
    mode: "auto",
  });

  // The hosted endpoint must remain alive while this session uses its tools.
  const run = client.runs.start({
    sessionId: session.id,
    input: { type: "text", text: "Use lookup_ticket for PDX-123." },
  });
  console.log(await run.result());
} finally {
  await tickets.close();
  await client.close();
}
