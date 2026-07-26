import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import type {
  CanonicalMessage,
  CanonicalModelRequest,
  ModelRuntime,
} from "../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import { DEFAULT_MULTIMODAL_CONSTRAINTS } from "../../src/model/protocol/multimodal.js";
import { readObservationEvents } from "../../src/observability/index.js";
import { createAgentProjectSessionStorage } from "../../src/session/index.js";

test("local Gateway records a complete O1 trajectory when a bounded child times out", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-subagent-budget-gateway-"));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "home");
  const builtinSkillsRoot = join(root, "builtin-skills");
  const requests: CanonicalModelRequest[] = [];
  await mkdir(projectRoot, { recursive: true });
  await mkdir(pilotHome, { recursive: true });
  await mkdir(join(builtinSkillsRoot, "fixture"), { recursive: true });
  await writeFile(join(builtinSkillsRoot, "fixture", "SKILL.md"), "# Fixture\n");
  await writeFile(join(pilotHome, "pilotdeck.yaml"), TEST_CONFIG);

  const runtime = createLocalGateway({
    projectRoot,
    fallbackProjectRoot: projectRoot,
    pilotHome,
    builtinSkillsRoot,
    env: { ...process.env, PILOT_HOME: pilotHome, PILOTDECK_BUILD_SHA: "test-build" },
    __testModelFactory: () => timeoutModelRuntime(requests),
  });
  try {
    const gatewayEvents = [];
    for await (const event of runtime.gateway.submitTurn({
      sessionKey: "subagent-budget-session",
      channelKey: "test",
      projectKey: projectRoot,
      message: "Delegate once, then finish from the bounded result.",
      canPrompt: false,
      timeoutMs: 60_000,
    })) {
      gatewayEvents.push(event);
    }

    const childRequest = requests.find(isBudgetedChildRequest);
    assert.ok(
      childRequest,
      `expected one model request containing the injected subagent budget; observed ${requests.length} requests`,
    );
    assert.match(messageText(childRequest.messages), /Hard wall-clock budget: 1 seconds\./u);
    assert.equal(
      gatewayEvents.some((event) => event.type === "turn_completed" && event.finishReason === "completed"),
      true,
    );

    const storage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome,
      sessionId: "subagent-budget-session",
    });
    const observationPath = join(storage.observabilityDir, "observations.jsonl");
    const observations = await readObservationEvents(observationPath);
    const raw = await readFile(observationPath, "utf8");
    const integrity = JSON.parse(await readFile(join(storage.observabilityDir, "integrity.json"), "utf8"));

    assert.equal(integrity.status, "complete");
    assert.equal(integrity.checks.modelRequestsPaired, true);
    assert.equal(integrity.checks.toolCallsPaired, true);
    assert.equal(integrity.checks.turnsPaired, true);
    assert.equal(integrity.recorder.droppedEvents, 0);
    assert.equal(observations.some((event) => event.type === "subagent.started"), true);
    assert.equal(
      observations.some((event) => event.type === "subagent.failed" && event.payload.success === false),
      true,
    );
    assert.equal(
      observations.some((event) => event.type === "tool.call.completed" && event.payload.toolName === "agent"),
      true,
    );
    assert.doesNotMatch(raw, /subagent-execution-budget/u);
    assert.doesNotMatch(raw, /test-key/u);
  } finally {
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

function timeoutModelRuntime(requests: CanonicalModelRequest[]): ModelRuntime {
  let parentRequests = 0;
  return {
    async *stream(request, options) {
      requests.push(request);
      if (isBudgetedChildRequest(request)) {
        await waitForAbort(options?.signal);
        throw options?.signal?.reason ?? new Error("expected subagent timeout");
      }

      parentRequests += 1;
      yield { type: "message_start", role: "assistant" };
      if (parentRequests === 1) {
        const toolCall = {
          id: "bounded-child",
          name: "agent",
          input: {
            description: "bounded lookup",
            prompt: "Investigate the unavailable source and return explicit gaps.",
            subagent_type: "general-purpose",
          },
        };
        yield { type: "tool_call_start", id: toolCall.id, name: toolCall.name };
        yield { type: "tool_call_end", toolCall };
        yield { type: "message_end", finishReason: "tool_call" };
        return;
      }
      yield { type: "text_delta", text: "Parent completed after the bounded child timeout." };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 } };
      yield { type: "message_end", finishReason: "stop" };
    },
    async complete() {
      return {
        role: "assistant",
        content: [{ type: "text", text: '{"title":"Bounded QA"}' }],
        finishReason: "stop",
      };
    },
    getCapabilities: () => ({
      ...DEFAULT_MODEL_CAPABILITIES,
      maxContextTokens: 1_048_576,
    }),
    getMultimodal: () => DEFAULT_MULTIMODAL_CONSTRAINTS,
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: () => "https://example.invalid",
  };
}

async function waitForAbort(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) throw new Error("expected abort signal");
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function messageText(messages: readonly CanonicalMessage[]): string {
  return messages.flatMap((message) => message.content)
    .map((block) => block.type === "text" ? block.text : "")
    .filter(Boolean)
    .join("\n");
}

function isBudgetedChildRequest(request: CanonicalModelRequest): boolean {
  return messageText(request.messages).includes("<subagent-execution-budget>");
}

const TEST_CONFIG = `schemaVersion: 1
agent:
  model: test/test-model
  subagents:
    timeoutMs: 1000
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
  campaignId: subagent-budget-qa
  variant: candidate
  queueCapacity: 4096
`;
