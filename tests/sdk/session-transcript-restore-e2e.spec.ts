import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPilotDeckClient } from "../../packages/sdk/src/index.js";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import { startGatewayServer } from "../../src/gateway/index.js";
import type { ModelRuntime } from "../../src/model/ModelRuntime.js";
import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalModelResponse,
} from "../../src/model/protocol/canonical.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import type { MultimodalConstraints } from "../../src/model/protocol/multimodal.js";

const TEST_CONFIG = `
schemaVersion: 1
agent:
  model: test/test
  maxContextTokens: 65536
  maxOutputTokens: 8192
router:
  enabled: false
model:
  providers:
    test:
      protocol: openai
      url: http://127.0.0.1:1
      apiKey: test-only
      models:
        test:
          capabilities:
            supportsToolUse: true
            maxContextTokens: 32768
            maxOutputTokens: 8192
`;

class TranscriptModel implements ModelRuntime {
  readonly requests: CanonicalModelRequest[] = [];

  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.requests.push(request);
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "model response" };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "model response" }], finishReason: "stop" };
  }

  getCapabilities() {
    return DEFAULT_MODEL_CAPABILITIES;
  }

  getMultimodal(): MultimodalConstraints {
    return { input: ["text"] };
  }

  getProviderProtocol() {
    return "openai" as const;
  }

  getProviderBaseUrl() {
    return undefined;
  }
}

async function completeTurn(
  gateway: ReturnType<typeof createLocalGateway>["gateway"],
  sessionKey: string,
  projectRoot: string,
  message: string,
): Promise<void> {
  for await (const _event of gateway.submitTurn({
    sessionKey,
    channelKey: "test",
    workspaceCwd: projectRoot,
    message,
  })) {
    // Exhaust the stream so the completed transcript is durable before export.
  }
}

test("Gateway restores portable session history into a fresh durable session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-transcript-restore-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");

  const firstModel = new TranscriptModel();
  const first = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    __testModelFactory: () => firstModel,
  });

  let restoredSessionKey = "";
  try {
    await completeTurn(first.gateway, "sdk:archive-source", projectRoot, "original user question");
    const exportTranscript = first.gateway.exportSessionTranscript;
    const restoreTranscript = first.gateway.restoreSessionTranscript;
    assert.ok(exportTranscript);
    assert.ok(restoreTranscript);

    const archive = await exportTranscript.call(first.gateway, { sessionKey: "sdk:archive-source", projectKey: projectRoot });
    assert.deepEqual(archive.messages, [
      { role: "user", text: "original user question" },
      { role: "assistant", text: "model response" },
    ]);
    const server = await startGatewayServer({ gateway: first.gateway, port: 0, token: "sdk-transcript-restore-test" });
    try {
      const client = createPilotDeckClient({
        gatewayUrl: server.wsUrl,
        authToken: server.token,
        projectKey: projectRoot,
      });
      const sdkArchive = await client.sessions.exportTranscript("sdk:archive-source");
      assert.deepEqual(sdkArchive, archive);
      const restoredSession = await client.sessions.restoreTranscript({ ...sdkArchive, title: "Restored session" }, {
        channelKey: "test",
      });
      restoredSessionKey = restoredSession.sessionKey;
      await client.close();
    } finally {
      await server.close();
    }

    await assert.rejects(
      () => restoreTranscript.call(first.gateway, { sessionKey: restoredSessionKey, projectKey: projectRoot, archive }),
      /persistent transcript already exists/,
    );
  } finally {
    first.dispose();
  }

  const restartedModel = new TranscriptModel();
  const restarted = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    __testModelFactory: () => restartedModel,
  });
  try {
    await completeTurn(restarted.gateway, restoredSessionKey, projectRoot, "follow-up question");
    const restoredRequest = restartedModel.requests.find((request) =>
      request.messages.some((message) => message.content.some((block) =>
        block.type === "text" && block.text === "follow-up question")));
    assert.ok(restoredRequest, "the restored session must start a native model request");
    const text = restoredRequest.messages
      .flatMap((message) => message.content)
      .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
      .map((block) => block.text);
    assert.deepEqual(text.slice(-3), ["original user question", "model response", "follow-up question"]);

    const messages = await restarted.gateway.readSessionMessages({
      sessionKey: restoredSessionKey,
      projectKey: projectRoot,
    });
    assert.equal(messages.session.customTitle, "Restored session");
    assert.equal(messages.messages.some((message) => message.text === "original user question"), true);
    assert.equal(messages.messages.some((message) => message.text === "model response"), true);
  } finally {
    restarted.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
