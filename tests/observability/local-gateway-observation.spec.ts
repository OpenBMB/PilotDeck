import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import type { CanonicalMessage, CanonicalModelRequest, ModelRuntime } from "../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import { DEFAULT_MULTIMODAL_CONSTRAINTS } from "../../src/model/protocol/multimodal.js";
import { observationHash, readObservationEvents } from "../../src/observability/index.js";
import { createAgentProjectSessionStorage } from "../../src/session/index.js";

test("local gateway writes a complete shadow bundle linked to the final request", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-observation-gateway-"));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "home");
  const pluginRoot = join(projectRoot, ".pilotdeck", "plugins", "observation-qa");
  const requests: CanonicalModelRequest[] = [];
  await mkdir(join(pluginRoot, "hooks"), { recursive: true });
  await mkdir(pilotHome, { recursive: true });
  await writeFile(join(pilotHome, "pilotdeck.yaml"), TEST_CONFIG);
  await writeFile(join(pluginRoot, "plugin.json"), JSON.stringify({
    name: "observation-qa",
    version: "1.0.0",
    hooks: "hooks/hooks.json",
  }));
  await writeFile(join(pluginRoot, "hooks", "hooks.json"), JSON.stringify({
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "node hook.mjs" }] }],
    PreModelRequest: [{ hooks: [{ type: "command", command: "node hook.mjs" }] }],
  }));
  await writeFile(join(pluginRoot, "hook.mjs"), HOOK_SCRIPT);

  const runtime = createLocalGateway({
    projectRoot,
    fallbackProjectRoot: projectRoot,
    pilotHome,
    env: { ...process.env, PILOT_HOME: pilotHome, PILOTDECK_BUILD_SHA: "test-build" },
    __testModelFactory: () => fakeModelRuntime(requests),
  });
  try {
    for await (const _event of runtime.gateway.submitTurn({
      sessionKey: "observation-session",
      channelKey: "test",
      projectKey: projectRoot,
      message: "Run the observation fixture.",
      canPrompt: false,
    })) {
      // Drain the real Gateway lifecycle.
    }

    assert.equal(requests.length, 1);
    assert.match(messageText(requests[0]!.messages), /bounded observation checkpoint/u);
    assert.match(requests[0]!.systemPrompt ?? "", /observation policy addendum/u);
    const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome, sessionId: "observation-session" });
    const bundleDir = storage.observabilityDir;
    const raw = await readFile(join(bundleDir, "observations.jsonl"), "utf8");
    const events = await readObservationEvents(join(bundleDir, "observations.jsonl"));
    const integrity = JSON.parse(await readFile(join(bundleDir, "integrity.json"), "utf8"));
    const trajectory = JSON.parse(await readFile(join(bundleDir, "trajectory.json"), "utf8"));

    assert.equal(integrity.status, "complete");
    assert.equal(integrity.checks.modelRequestsPaired, true);
    assert.equal(events.some((event) => event.type === "model.request.sent"), true);
    assert.equal(events.some((event) => event.type === "model.response.received"), true);
    const injectionEvents = events.filter((event) => event.type === "prompt.injection.applied");
    assert.equal(injectionEvents.length, 2);
    assert.equal(injectionEvents.some((event) => event.payload.contentHash === observationHash("bounded observation checkpoint")), true);
    assert.equal(injectionEvents.some((event) => event.payload.contentHash === observationHash("observation policy addendum")), true);
    assert.equal(trajectory.steps.every((step: { sourceEventId?: unknown }) => typeof step.sourceEventId === "string"), true);
    assert.doesNotMatch(raw, /bounded observation checkpoint/u);
    assert.doesNotMatch(raw, /observation policy addendum/u);
    assert.doesNotMatch(raw, /test-key/u);
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("enabling O1 does not change Agent-visible model input", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-observation-equivalence-"));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "home");
  const pluginRoot = join(projectRoot, ".pilotdeck", "plugins", "observation-qa");
  await mkdir(join(pluginRoot, "hooks"), { recursive: true });
  await mkdir(pilotHome, { recursive: true });
  await writeFile(join(pluginRoot, "plugin.json"), JSON.stringify({
    name: "observation-qa",
    version: "1.0.0",
    hooks: "hooks/hooks.json",
  }));
  await writeFile(join(pluginRoot, "hooks", "hooks.json"), JSON.stringify({
    UserPromptSubmit: [{ hooks: [{ type: "command", command: "node hook.mjs" }] }],
    PreModelRequest: [{ hooks: [{ type: "command", command: "node hook.mjs" }] }],
  }));
  await writeFile(join(pluginRoot, "hook.mjs"), HOOK_SCRIPT);

  try {
    const disabled = await captureFinalRequest({
      projectRoot,
      pilotHome,
      config: TEST_CONFIG_WITHOUT_OBSERVATION,
      sessionId: "equivalence-disabled",
    });
    const enabled = await captureFinalRequest({
      projectRoot,
      pilotHome,
      config: TEST_CONFIG,
      sessionId: "equivalence-enabled",
    });

    assert.deepEqual(agentVisibleRequest(enabled), agentVisibleRequest(disabled));
    const enabledStorage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome,
      sessionId: "equivalence-enabled",
    });
    assert.equal(
      JSON.parse(await readFile(join(enabledStorage.observabilityDir, "integrity.json"), "utf8")).status,
      "complete",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function captureFinalRequest(input: {
  projectRoot: string;
  pilotHome: string;
  config: string;
  sessionId: string;
}): Promise<CanonicalModelRequest> {
  const requests: CanonicalModelRequest[] = [];
  await writeFile(join(input.pilotHome, "pilotdeck.yaml"), input.config);
  const runtime = createLocalGateway({
    projectRoot: input.projectRoot,
    fallbackProjectRoot: input.projectRoot,
    pilotHome: input.pilotHome,
    env: { ...process.env, PILOT_HOME: input.pilotHome, PILOTDECK_BUILD_SHA: "test-build" },
    __testModelFactory: () => fakeModelRuntime(requests),
  });
  try {
    for await (const _event of runtime.gateway.submitTurn({
      sessionKey: input.sessionId,
      channelKey: "test",
      projectKey: input.projectRoot,
      message: "Run the observation fixture.",
      canPrompt: false,
    })) {
      // Drain the real Gateway lifecycle.
    }
  } finally {
    runtime.dispose();
  }
  assert.equal(requests.length, 1);
  return requests[0]!;
}

function agentVisibleRequest(request: CanonicalModelRequest): Partial<CanonicalModelRequest> {
  return {
    provider: request.provider,
    model: request.model,
    messages: request.messages.map((message) => ({
      ...message,
      ...(message.metadata ? {
        metadata: Object.fromEntries(
          Object.entries(message.metadata).filter(([key]) => key !== "transientId"),
        ),
      } : {}),
    })),
    systemPrompt: request.systemPrompt,
    tools: request.tools,
    toolChoice: request.toolChoice,
    maxOutputTokens: request.maxOutputTokens,
    temperature: request.temperature,
    thinking: request.thinking,
    stream: request.stream,
    cacheBreakpoints: request.cacheBreakpoints,
  };
}

function fakeModelRuntime(requests: CanonicalModelRequest[]): ModelRuntime {
  return {
    async *stream(request) {
      requests.push(request);
      yield { type: "request_started", provider: request.provider, model: request.model };
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "Observation fixture complete." };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } };
      yield { type: "message_end", finishReason: "stop" };
    },
    async complete() {
      return { role: "assistant", content: [{ type: "text", text: "QA" }], finishReason: "stop" };
    },
    getCapabilities: () => DEFAULT_MODEL_CAPABILITIES,
    getMultimodal: () => DEFAULT_MULTIMODAL_CONSTRAINTS,
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: () => "https://example.invalid",
  };
}

function messageText(messages: readonly CanonicalMessage[]): string {
  return messages.flatMap((message) => message.content)
    .map((block) => block.type === "text" ? block.text : "")
    .filter(Boolean)
    .join("\n");
}

const TEST_CONFIG = `schemaVersion: 1
agent:
  model: test/test-model
model:
  providers:
    test:
      protocol: openai
      url: https://example.invalid
      apiKey: test-key
      models:
        test-model:
          capabilities:
            maxContextTokens: 32768
            maxOutputTokens: 8192
router:
  enabled: false
  scenarios:
    default: test/test-model
memory:
  enabled: false
observability:
  enabled: true
  profile: diagnostic
  campaignId: o1-calibration
  variant: candidate
  queueCapacity: 4096
`;

const TEST_CONFIG_WITHOUT_OBSERVATION = TEST_CONFIG.replace(/observability:\n(?:  .*\n)+$/u, "");

const HOOK_SCRIPT = `let body = "";
for await (const chunk of process.stdin) body += chunk;
const input = JSON.parse(body);
const output = { hookSpecificOutput: { hookEventName: input.hookEventName } };
if (input.hookEventName === "UserPromptSubmit" && input.internal !== true) {
  output.hookSpecificOutput.dynamicContext = [{
    id: "observation-checkpoint",
    content: "bounded observation checkpoint",
    priority: "critical"
  }];
}
if (input.hookEventName === "PreModelRequest") {
  output.systemMessage = "observation policy addendum";
}
console.log(JSON.stringify(output));
`;
