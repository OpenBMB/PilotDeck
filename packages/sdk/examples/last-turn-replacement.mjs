import { createPilotDeckClient } from "@pilotdeck/sdk";

const projectKey = process.env.PILOTDECK_PROJECT_KEY;
const client = createPilotDeckClient({
  gatewayUrl: process.env.PILOTDECK_SDK_GATEWAY_URL,
  authToken: process.env.PILOTDECK_SDK_AUTH_TOKEN,
  projectKey,
});

try {
  const session = await client.sessions.create({ projectKey });
  const original = client.runs.start({
    sessionId: session.id,
    input: { type: "text", text: "这是需要更正的原始请求。" },
  });
  await original.result();

  const messages = await client.sessions.messages(session.id, { projectKey });
  const expectedTurnId = [...messages]
    .reverse()
    .map((message) => message.entryId ?? message.id)
    .find((entryId) => typeof entryId === "string" && entryId.length > 0);
  if (typeof expectedTurnId !== "string") {
    throw new Error("Gateway did not return a replaceable transcript entry id.");
  }

  const replacement = await client.sessions.prepareLastTurnReplacement(session.id, {
    projectKey,
    expectedTurnId,
  });

  // Calling rollback() here, before start(), restores the original tail.
  const corrected = replacement.start({
    type: "text",
    text: "这是修正后的请求。",
  });
  console.log(await corrected.result());
} finally {
  await client.close();
}
