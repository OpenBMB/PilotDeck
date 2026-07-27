import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import type { CanonicalModelRequest, ModelRuntime } from "../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import { DEFAULT_MULTIMODAL_CONSTRAINTS } from "../../src/model/protocol/multimodal.js";
import { readObservationEvents } from "../../src/observability/index.js";
import { createAgentProjectSessionStorage } from "../../src/session/index.js";

test("local Gateway records a bounded handoff through boundary to progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-progress-handoff-gateway-"));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "home");
  const pluginRoot = join(projectRoot, ".pilotdeck", "plugins", "handoff-qa");
  const requests: CanonicalModelRequest[] = [];
  const modelMetrics = { compactions: 0 };
  await mkdir(join(pluginRoot, "hooks"), { recursive: true });
  await mkdir(pilotHome, { recursive: true });
  await writeFile(join(pilotHome, "pilotdeck.yaml"), TEST_CONFIG);
  await writeFile(join(pluginRoot, "plugin.json"), JSON.stringify({
    name: "handoff-qa",
    version: "1.0.0",
    hooks: "hooks/hooks.json",
  }));
  await writeFile(join(pluginRoot, "hooks", "hooks.json"), JSON.stringify({
    PreModelRequest: [{ hooks: [{ type: "command", command: "node hook.mjs" }] }],
    PostToolUse: [{ matcher: "bash", hooks: [{ type: "command", command: "node hook.mjs" }] }],
  }));
  await writeFile(join(pluginRoot, "hook.mjs"), HOOK_SCRIPT);

  const runtime = createLocalGateway({
    projectRoot,
    fallbackProjectRoot: projectRoot,
    pilotHome,
    env: { ...process.env, PILOT_HOME: pilotHome, PILOTDECK_BUILD_SHA: "test-build" },
    __testModelFactory: () => handoffModelRuntime(requests, modelMetrics),
  });
  try {
    const gatewayEvents = [];
    for await (const event of runtime.gateway.submitTurn({
      sessionKey: "handoff-session",
      channelKey: "test",
      projectKey: projectRoot,
      message: "Complete the bounded handoff fixture.",
      canPrompt: false,
      timeoutMs: 60_000,
    })) {
      gatewayEvents.push(event);
    }

    assert.equal(requests.length, 5);
    const gatewayDecisions = gatewayEvents
      .flatMap((event) => event.type === "agent_status" && event.event === "progress_lease_evaluated"
        ? [[event.detail?.decision, event.detail?.handoffOrdinal]]
        : []);
    assert.deepEqual(gatewayDecisions, [
      ["baseline", 0],
      ["renewed", 0],
      ["handoff_grace", 1],
      ["handoff_grace", 2],
      ["renewed", 2],
    ]);
    assert.equal(modelMetrics.compactions, 0);
    assert.deepEqual(
      gatewayEvents.flatMap((event) => event.type === "agent_status"
          && event.event === "progress_boundary_deferred"
        ? [event.detail?.scopes]
        : []),
      [["handoff-qa"], ["handoff-qa"]],
    );
    assert.equal(
      gatewayEvents.some((event) => event.type === "turn_completed" && event.finishReason === "completed"),
      true,
    );

    const storage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome,
      sessionId: "handoff-session",
    });
    const observationPath = join(storage.observabilityDir, "observations.jsonl");
    const observations = await readObservationEvents(observationPath);
    const raw = await readFile(observationPath, "utf8");
    const decisions = observations
      .filter((event) => event.type === "harness.decision" && event.payload.component === "progress-lease")
      .map((event) => [
        event.payload.decision,
        (event.payload.observed as { handoffOrdinal?: number } | undefined)?.handoffOrdinal,
      ]);
    const decisionSequence = observations
      .filter((event) => event.type === "harness.decision"
        && ["progress-boundary", "progress-lease"].includes(String(event.payload.component)))
      .map((event) => [event.payload.component, event.payload.decision]);
    const integrity = JSON.parse(await readFile(join(storage.observabilityDir, "integrity.json"), "utf8"));

    assert.deepEqual(decisions, gatewayDecisions);
    assert.deepEqual(decisionSequence, [
      ["progress-lease", "baseline"],
      ["progress-lease", "renewed"],
      ["progress-lease", "handoff_grace"],
      ["progress-boundary", "deferred"],
      ["progress-lease", "handoff_grace"],
      ["progress-boundary", "deferred"],
      ["progress-lease", "renewed"],
    ]);
    assert.equal(integrity.status, "complete");
    assert.equal(integrity.checks.modelRequestsPaired, true);
    assert.equal(integrity.checks.toolCallsPaired, true);
    assert.equal(integrity.checks.turnsPaired, true);
    assert.equal(integrity.recorder.droppedEvents, 0);
    assert.doesNotMatch(raw, /test-key/u);
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

function handoffModelRuntime(
  requests: CanonicalModelRequest[],
  metrics: { compactions: number },
): ModelRuntime {
  return {
    async *stream(request) {
      if (isCompactionRequest(request)) {
        yield { type: "message_start", role: "assistant" };
        yield {
          type: "text_delta",
          text: "## Goal\nContinue the bounded handoff.\n\n## Constraints\nPreserve the state-bound checkpoint.\n\n## Progress\nApply-ready state reached.\n\n## Key Decisions\nUse the deterministic handoff.\n\n## Next Steps\nContinue with the next bounded page.\n\n## Critical Context\nNo private content.",
        };
        yield { type: "message_end", finishReason: "stop" };
        return;
      }
      requests.push(request);
      yield { type: "message_start", role: "assistant" };
      if (requests.length < 5) {
        const toolCall = {
          id: `handoff-${requests.length}`,
          name: "bash",
          input: { command: "pwd" },
        };
        yield { type: "tool_call_start", id: toolCall.id, name: toolCall.name };
        yield { type: "tool_call_end", toolCall };
        yield { type: "message_end", finishReason: "tool_call" };
        return;
      }
      yield { type: "text_delta", text: "Bounded handoff fixture complete." };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } };
      yield { type: "message_end", finishReason: "stop" };
    },
    async complete(request) {
      if (isCompactionRequest(request)) metrics.compactions += 1;
      return {
        role: "assistant",
        content: [{ type: "text", text: "Bounded context summary." }],
        finishReason: "stop",
      };
    },
    getCapabilities: () => ({ ...DEFAULT_MODEL_CAPABILITIES, maxContextTokens: 1_048_576 }),
    getMultimodal: () => DEFAULT_MULTIMODAL_CONSTRAINTS,
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: () => "https://example.invalid",
  };
}

function isCompactionRequest(request: CanonicalModelRequest): boolean {
  return request.messages.some((message) => message.content.some((block) =>
    block.type === "text" && block.text.includes("Summarize the conversation so far")
  ));
}

const TEST_CONFIG = `schemaVersion: 1
agent:
  model: test/test-model
  progressLease:
    enabled: true
    mode: evaluation
    maxStagnantObservations: 2
    maxInitialStagnantObservations: 8
model:
  providers:
    test:
      protocol: openai
      url: https://example.invalid
      apiKey: test-key
      models:
        test-model:
          capabilities:
            maxContextTokens: 1048576
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
  campaignId: handoff-qa
  variant: candidate
  queueCapacity: 4096
`;

const HOOK_SCRIPT = `import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
let body = "";
for await (const chunk of process.stdin) body += chunk;
const input = JSON.parse(body);
const counterPath = join(input.cwd, ".pilotdeck", "handoff-qa-counter");
let count = 0;
try { count = Number(await readFile(counterPath, "utf8")) || 0; } catch {}
const reports = [
  { progressOrdinal: 7, handoffOrdinal: 0, stateHash: "prior" },
  { progressOrdinal: 8, handoffOrdinal: 0, stateHash: "first-matrix" },
  { progressOrdinal: 8, handoffOrdinal: 1, stateHash: "apply-ready" },
  { progressOrdinal: 8, handoffOrdinal: 2, stateHash: "next-page" },
  { progressOrdinal: 9, handoffOrdinal: 2, stateHash: "finalized" }
];
if (input.hookEventName === "PostToolUse") {
  const report = reports[Math.min(count, reports.length - 1)];
  console.log(JSON.stringify({ hookSpecificOutput: {
    hookEventName: input.hookEventName,
    convergencePreview: {
      schemaVersion: 1,
      scope: "handoff-qa",
      phase: "coverage",
      blockingCode: "missing_rows",
      remainingCount: 4,
      ...report
    }
  } }));
} else {
  count += 1;
  await mkdir(dirname(counterPath), { recursive: true });
  await writeFile(counterPath, String(count));
  const report = reports[Math.min(count - 1, reports.length - 1)];
  console.log(JSON.stringify({ hookSpecificOutput: {
    hookEventName: input.hookEventName,
    modelRequestPatch: { metadata: { pilotdeckConvergence: {
      schemaVersion: 1,
      scope: "handoff-qa",
      phase: "coverage",
      blockingCode: "missing_rows",
      remainingCount: 4,
      ...report
    } } }
  } }));
}
`;
