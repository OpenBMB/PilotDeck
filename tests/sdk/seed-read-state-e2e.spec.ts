import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
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

class SeedReadStateModel implements ModelRuntime {
  private requests = 0;

  async *stream(_request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.requests += 1;
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    if (this.requests === 1) {
      yield { type: "tool_call_start", id: "write-after-seed", name: "write_file" };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "write-after-seed",
          name: "write_file",
          input: { file_path: "fixture.txt", content: "after\n" },
        },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    yield { type: "text_delta", text: "done" };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "done" }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

test("createLocalGateway seed_read_state preserves native write freshness semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-seed-e2e-"));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "pilot-home");
  const filePath = join(projectRoot, "fixture.txt");
  await Promise.all([mkdir(projectRoot, { recursive: true }), mkdir(pilotHome, { recursive: true })]);
  await Promise.all([
    writeFile(join(pilotHome, "pilotdeck.yaml"), TEST_CONFIG, "utf8"),
    writeFile(filePath, "before\n", "utf8"),
  ]);
  const model = new SeedReadStateModel();
  const local = createLocalGateway({
    projectRoot,
    pilotHome,
    fallbackProjectRoot: pilotHome,
    permissionMode: "default",
    __testModelFactory: () => model,
  });
  const gateway = local.gateway;
  const sessionKey = "sdk:seed-e2e";

  try {
    const observedMtime = Math.floor((await stat(filePath)).mtimeMs);
    assert.deepEqual(await gateway.seedReadState?.({
      sessionKey,
      channelKey: "test",
      workspaceCwd: projectRoot,
      path: "fixture.txt",
      mtime: observedMtime,
    }), { applied: true });

    const events = [];
    for await (const event of gateway.submitTurn({
      sessionKey,
      channelKey: "test",
      workspaceCwd: projectRoot,
      message: "write the file",
      mode: "bypassPermissions",
    })) events.push(event);
    assert.equal(events.some((event) => event.type === "turn_completed"), true, JSON.stringify(events));
    assert.equal(await (await import("node:fs/promises")).readFile(filePath, "utf8"), "after\n");

    await writeFile(filePath, "changed\n", "utf8");
    await utimes(filePath, new Date(observedMtime + 2_000), new Date(observedMtime + 2_000));
    assert.deepEqual(await gateway.seedReadState?.({
      sessionKey,
      channelKey: "test",
      workspaceCwd: projectRoot,
      path: "fixture.txt",
      mtime: observedMtime,
    }), { applied: false });
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
