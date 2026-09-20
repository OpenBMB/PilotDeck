import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "/Users/a1/Desktop/claw/openbmb/PilotDeck/node_modules/yaml/dist/index.js";
import { createLocalGateway } from "/Users/a1/Desktop/claw/openbmb/PilotDeck-delivery-deploy/dist/src/cli/createLocalGateway.js";
import { getPilotProjectChatDir } from "/Users/a1/Desktop/claw/openbmb/PilotDeck-delivery-deploy/dist/src/pilot/paths.js";
import { readTranscript } from "/Users/a1/Desktop/claw/openbmb/PilotDeck-delivery-deploy/dist/src/session/index.js";

const root = await mkdtemp(join(tmpdir(), "pilotdeck-gateway-compact-preflight-"));
const projectRoot = join(root, "project");
await mkdir(projectRoot, { recursive: true });
const server = createServer(async (request, response) => {
  if (request.method !== "POST") { response.writeHead(404).end(); return; }
  let body = "";
  for await (const chunk of request) body += chunk;
  const input = JSON.parse(body);
  const isSummary = input.messages?.some((message) => JSON.stringify(message).includes("one complete replacement summary"));
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: isSummary ? "Deterministic durable summary." : "Deterministic reply." }, finish_reason: "stop" }] })}\n\n`);
  response.end("data: [DONE]\n\n");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;
try {
  await writeFile(join(projectRoot, "pilotdeck.yaml"), YAML.stringify({
    schemaVersion: 1,
    agent: { model: "preflight/default", maxContextTokens: 65536, maxOutputTokens: 256 },
    model: { providers: { preflight: { protocol: "openai", url: `http://127.0.0.1:${port}/v1`, apiKey: "preflight", models: { default: {} } } } },
    modules: {
      agentLoop: { enabled: true, provider: "pilotdeck" },
      modelProvider: { enabled: true, provider: "pilotdeck" },
      tools: { enabled: true, provider: "pilotdeck" },
    },
  }), "utf8");
  const local = createLocalGateway({ projectRoot, pilotHome: projectRoot, fallbackProjectRoot: projectRoot, permissionMode: "bypassPermissions" });
  try {
    const sessionKey = "gateway-compact-preflight";
    for (const message of ["first durable history", "second durable history", "third durable history"]) {
      const events = [];
      for await (const event of local.gateway.submitTurn({ sessionKey, channelKey: "preflight", workspaceCwd: projectRoot, message: `${message} ${"context ".repeat(20)}`, mode: "bypassPermissions" })) events.push(event);
      assert.equal(events.some((event) => event.type === "error"), false, JSON.stringify(events));
    }
    const compactEvents = [];
    for await (const event of local.gateway.submitTurn({ sessionKey, channelKey: "preflight", workspaceCwd: projectRoot, message: "/compact", mode: "bypassPermissions" })) compactEvents.push(event);
    const status = compactEvents.find((event) => event.type === "agent_status" && event.event === "manual_compaction");
    assert.equal(status?.detail?.outcome, "compacted", JSON.stringify(compactEvents));
    const turnId = status.detail.turnId;
    const transcriptPath = join(getPilotProjectChatDir(projectRoot, projectRoot), `${sessionKey}.jsonl`);
    const transcript = await readTranscript(transcriptPath);
    const sameTurn = transcript.entries.filter((entry) => entry.turnId === turnId);
    assert.ok(sameTurn.some((entry) => entry.type === "compaction_completed" && entry.status === "compacted"));
    assert.ok(sameTurn.some((entry) => entry.type === "control_boundary" && entry.boundary.kind === "compact" && entry.boundary.subtype === "compact_boundary" && entry.boundary.compactMetadata.summaryGenerated === true));
    const oldTurn = transcript.entries.filter((entry) => entry.turnId !== turnId);
    assert.equal(oldTurn.some((entry) => entry.type === "compaction_completed" && entry.status === "compacted"), false);
    console.log(JSON.stringify({ status: "PASS", gatewayEvent: status, transcriptPath, sameTurnEntryTypes: sameTurn.map((entry) => entry.type) }));
  } finally {
    await local.dispose();
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
