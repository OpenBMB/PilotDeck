import assert from "node:assert/strict";
import { GatewayWsClient, startGatewayServer } from "../dist/src/gateway/index.js";
import { ModelProviderRegistry, normalizeProviderBaseUrl } from "../dist/src/model/index.js";
import { stat } from "node:fs/promises";

await stat(new URL("../dist/src/cli/pilotdeck.js", import.meta.url));
assert.equal(normalizeProviderBaseUrl("https://provider.example/v1/"), "https://provider.example/v1");
assert.equal(ModelProviderRegistry.get("openai").protocol, "openai");

const gateway = {
  async describeServer() {
    return { mode: "in_process", protocolVersion: "artifact" };
  },
  async *submitTurn(input) {
    yield { type: "turn_started", runId: input.runId ?? "artifact-run" };
    yield { type: "assistant_text_delta", text: "artifact smoke", runId: input.runId ?? "artifact-run" };
    yield { type: "turn_completed", usage: {}, finishReason: "completed", runId: input.runId ?? "artifact-run" };
  },
  async abortTurn() {},
};

const server = await startGatewayServer({ gateway, host: "127.0.0.1", port: 0, token: "artifact-token" });
const client = new GatewayWsClient({ url: server.wsUrl, token: server.token, clientName: "test" });
try {
  const hello = await client.connect();
  assert.equal(hello.serverInfo.mode, "in_process");
  const events = [];
  for await (const event of client.stream("submit_turn", {
    sessionKey: "artifact-session",
    channelKey: "test",
    message: "smoke",
    runId: "artifact-run",
  })) events.push(event);
  assert.deepEqual(events.map(event => event.type), ["turn_started", "assistant_text_delta", "turn_completed"]);
  console.log("artifact smoke passed");
} finally {
  client.close();
  await server.close();
}
