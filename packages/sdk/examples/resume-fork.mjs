import { createPilotDeckClient } from "@pilotdeck/sdk";

const client = createPilotDeckClient({
  gatewayUrl: process.env.PILOTDECK_SDK_GATEWAY_URL,
  authToken: process.env.PILOTDECK_SDK_AUTH_TOKEN,
});

try {
  const session = await client.sessions.create({ projectKey: process.env.PILOTDECK_PROJECT_KEY });
  const first = client.runs.start({ sessionId: session.id, input: { type: "text", text: "记录：这是第一轮。" } });
  for await (const _event of first.events()) { /* consume */ }
  await first.result();

  const resumed = await client.sessions.resume(session.id);
  const fork = await client.sessions.fork(resumed.sessionId, { title: "SDK example fork" });
  console.log(JSON.stringify({ resumed: resumed.sessionId, fork }, null, 2));
} finally {
  await client.close();
}
