import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
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
router:
  enabled: true
  tokenSaver:
    enabled: false
  stats:
    enabled: true
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

class UsageModel implements ModelRuntime {
  async *stream(_request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "usage tracked" };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "usage tracked" }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

test("createLocalGateway exposes Router-owned model usage after a real SDK turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-model-usage-e2e-"));
  const projectRoot = join(root, "project");
  const pilotHome = projectRoot;
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(pilotHome, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const local = createLocalGateway({
    projectRoot,
    pilotHome,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => new UsageModel(),
  });
  const sessionKey = "sdk:model-usage-e2e";

  try {
    for await (const _event of local.gateway.submitTurn({
      sessionKey,
      channelKey: "test",
      workspaceCwd: projectRoot,
      message: "track this request",
      mode: "bypassPermissions",
    })) {
      // Consume the actual AgentLoop/Gateway turn before reading its owner.
    }

    const snapshot = await local.gateway.modelUsageSnapshot?.({ sessionKey });
    assert.ok(snapshot, "createLocalGateway must advertise model_usage_snapshot");
    assert.equal(snapshot.scope, "session");
    assert.equal(snapshot.sessionId, sessionKey);
    assert.equal(snapshot.models.length, 1);
    assert.equal(snapshot.models[0]?.provider, "test");
    assert.equal(snapshot.models[0]?.model, "test");
    assert.ok((snapshot.models[0]?.totalRequests ?? 0) >= 1);
    assert.ok((snapshot.models[0]?.inputTokens ?? 0) > 0);
    assert.equal(snapshot.models[0]?.roles.main?.totalRequests, snapshot.models[0]?.totalRequests);
    const modelCostSources = snapshot.models[0]?.costSources ?? {};
    assert.ok((modelCostSources.fallback_estimate ?? 0) >= 1);
    assert.equal(
      Object.values(modelCostSources).reduce((total, count) => total + (count ?? 0), 0),
      snapshot.models[0]?.totalRequests,
      "every persisted request must have a visible cost provenance",
    );

    const usage = await local.gateway.usageSnapshot?.({ sessionKey });
    assert.ok(usage, "createLocalGateway must advertise usage_snapshot");
    assert.equal(
      Object.values(usage.aggregate.costSources).reduce((total, count) => total + (count ?? 0), 0),
      usage.aggregate.totalRequests,
      "Gateway aggregate must account for every request's cost provenance",
    );
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
