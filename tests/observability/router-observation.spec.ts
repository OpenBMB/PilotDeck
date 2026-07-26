import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CanonicalModelError,
  CanonicalModelRequest,
  ModelRuntime,
} from "../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import { DEFAULT_MULTIMODAL_CONSTRAINTS } from "../../src/model/protocol/multimodal.js";
import {
  JsonlObservationRecorder,
  readObservationEvents,
} from "../../src/observability/index.js";
import { createRouterRuntime } from "../../src/router/RouterRuntime.js";
import type { RouterDecision } from "../../src/router/protocol/decision.js";

test("router observation closes every fallback and retry attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-router-observation-"));
  const recorder = new JsonlObservationRecorder({ directory: root });
  const calls = new Map<string, number>();
  const router = createRouterRuntime({
    enabled: true,
    scenarios: { default: modelRef("primary", "model-a") },
    fallback: { default: [modelRef("backup", "model-b")] },
    zeroUsageRetry: { enabled: false, maxAttempts: 1 },
    transientRetry: { enabled: true, maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
  }, { modelRuntime: fallbackThenRetryRuntime(calls) });

  try {
    const events = [];
    for await (const event of router.execute(
      decision("primary", "model-a"),
      request("primary", "model-a"),
      {
        sessionId: "parent-session",
        turnId: "turn-1",
        observation: recorder,
      },
    )) {
      events.push(event);
    }
    await recorder.finalize();

    assert.equal(events.at(-1)?.type, "message_end");
    assert.equal(calls.get("primary/model-a"), 1);
    assert.equal(calls.get("backup/model-b"), 2);
    const observations = await readObservationEvents(recorder.paths.observations);
    const sentIds = payloadIds(observations, "model.request.sent", "requestId");
    const failedIds = payloadIds(observations, "model.request.failed", "requestId");
    const receivedIds = payloadIds(observations, "model.response.received", "requestId");

    assert.equal(sentIds.length, 3);
    assert.equal(new Set(sentIds).size, 3);
    assert.deepEqual(new Set([...failedIds, ...receivedIds]), new Set(sentIds));
    assert.equal(failedIds.length, 2);
    assert.equal(receivedIds.length, 1);
    assert.equal(observations.filter((event) => event.type === "model.fallback.selected").length, 1);
    assert.equal(observations.filter((event) => event.type === "model.retry.scheduled").length, 1);
    assert.equal(
      JSON.parse(await readFile(recorder.paths.integrity, "utf8")).status,
      "complete",
    );
  } finally {
    await router.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("router request identity separates sessions sharing a turn id", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-router-identity-"));
  const recorder = new JsonlObservationRecorder({ directory: root });
  const router = createRouterRuntime({
    enabled: false,
    scenarios: { default: modelRef("primary", "model-a") },
  }, { modelRuntime: successRuntime() });

  try {
    for (const sessionId of ["parent-session", "subagent-session"]) {
      for await (const _event of router.execute(
        decision("primary", "model-a"),
        request("primary", "model-a"),
        { sessionId, turnId: "shared-turn", observation: recorder },
      )) {
        // Drain both independent model attempts.
      }
    }
    await recorder.finalize();
    const observations = await readObservationEvents(recorder.paths.observations);
    const sentIds = payloadIds(observations, "model.request.sent", "requestId");

    assert.equal(sentIds.length, 2);
    assert.equal(new Set(sentIds).size, 2);
    assert.equal(sentIds.every((id) => /^[a-f0-9]{16}:shared-turn:model:1$/u.test(id)), true);
  } finally {
    await router.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

function modelRef(provider: string, model: string) {
  return { id: `${provider}/${model}`, provider, model };
}

function decision(provider: string, model: string): RouterDecision {
  return {
    provider,
    model,
    scenarioType: "default",
    isSubagent: false,
    orchestrating: false,
    resolvedFrom: "scenario",
    mutations: {},
  };
}

function request(provider: string, model: string): CanonicalModelRequest {
  return {
    provider,
    model,
    messages: [{ role: "user", content: [{ type: "text", text: "observe attempts" }] }],
    stream: true,
  };
}

function fallbackThenRetryRuntime(calls: Map<string, number>): ModelRuntime {
  return runtime(async function* stream(modelRequest) {
    const key = `${modelRequest.provider}/${modelRequest.model}`;
    const count = (calls.get(key) ?? 0) + 1;
    calls.set(key, count);
    if (modelRequest.provider === "primary") {
      yield { type: "error", error: modelError(modelRequest, "billing", false) };
      return;
    }
    if (count === 1) {
      yield { type: "error", error: modelError(modelRequest, "rate_limit", true) };
      return;
    }
    yield { type: "usage", usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 } };
    yield { type: "message_end", finishReason: "stop" };
  });
}

function successRuntime(): ModelRuntime {
  return runtime(async function* stream() {
    yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    yield { type: "message_end", finishReason: "stop" };
  });
}

function runtime(stream: ModelRuntime["stream"]): ModelRuntime {
  return {
    stream,
    async complete() {
      return { role: "assistant", content: [{ type: "text", text: "ok" }], finishReason: "stop" };
    },
    getCapabilities: () => DEFAULT_MODEL_CAPABILITIES,
    getMultimodal: () => DEFAULT_MULTIMODAL_CONSTRAINTS,
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: () => "https://example.invalid",
  };
}

function modelError(
  modelRequest: CanonicalModelRequest,
  code: string,
  retryable: boolean,
): CanonicalModelError {
  return {
    provider: modelRequest.provider,
    model: modelRequest.model,
    protocol: "openai",
    code,
    message: code,
    retryable,
  };
}

function payloadIds(
  events: Awaited<ReturnType<typeof readObservationEvents>>,
  type: string,
  field: string,
): string[] {
  return events
    .filter((event) => event.type === type)
    .map((event) => event.payload[field])
    .filter((value): value is string => typeof value === "string");
}
