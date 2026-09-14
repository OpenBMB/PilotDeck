import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CanonicalModelEvent, CanonicalModelRequest, ModelRuntime } from "../src/model/index.js";
import { createRouterRuntime } from "../src/router/RouterRuntime.js";
import type { RouterConfig, RouterModelRef } from "../src/router/config/schema.js";
import type { RouterEvent } from "../src/router/protocol/events.js";

type Action = {
  kind: "success" | "failure" | "partial" | "tool_failure";
  code?: string;
  status?: number;
  latencyMs: number;
  estimatedCost: number;
};
type Scenario = {
  name: string;
  endpoints: Record<string, string>;
  actions: Record<string, Action[]>;
};

const ref = (provider: string): RouterModelRef => ({ id: `${provider}/model`, provider, model: "model" });
const request: CanonicalModelRequest = {
  provider: "a", model: "model", stream: true,
  messages: [{ role: "user", content: [{ type: "text", text: "fixed-seed=20260911" }] }],
};
const decision = {
  provider: "a", model: "model", scenarioType: "default" as const, isSubagent: false,
  orchestrating: false, resolvedFrom: "scenario" as const, mutations: {},
};
const fail = (code: string, status: number, latencyMs = 100): Action => ({
  kind: "failure", code, status, latencyMs, estimatedCost: 0.0005,
});
const ok = (latencyMs = 80): Action => ({ kind: "success", latencyMs, estimatedCost: 0.0007 });

const scenarios: Scenario[] = [
  {
    name: "healthy",
    endpoints: { a: "https://a.invalid/v1", b: "https://b.invalid/v1", c: "https://c.invalid/v1" },
    actions: { a: [ok()] },
  },
  {
    name: "first_failure_second_recovers",
    endpoints: { a: "https://a.invalid/v1", b: "https://b.invalid/v1", c: "https://c.invalid/v1" },
    actions: { a: [fail("server_error", 503)], b: [ok()] },
  },
  {
    name: "shared_failed_endpoint_then_healthy",
    endpoints: { a: "https://shared.invalid/v1", b: "https://shared.invalid/v1", c: "https://healthy.invalid/v1" },
    actions: { a: [fail("rate_limit_error", 429)], b: [fail("rate_limit_error", 429)], c: [ok()] },
  },
  {
    name: "persistent_shared_429",
    endpoints: { a: "https://shared.invalid/v1", b: "https://shared.invalid/v1", c: "https://shared.invalid/v1" },
    actions: { a: [fail("rate_limit_error", 429)], b: [fail("rate_limit_error", 429)], c: [fail("rate_limit_error", 429)] },
  },
  {
    name: "persistent_independent_5xx",
    endpoints: { a: "https://a.invalid/v1", b: "https://b.invalid/v1", c: "https://c.invalid/v1" },
    actions: { a: [fail("server_error", 503)], b: [fail("server_error", 503)], c: [fail("server_error", 503)] },
  },
  {
    name: "partial_stream_failure",
    endpoints: { a: "https://a.invalid/v1", b: "https://b.invalid/v1", c: "https://c.invalid/v1" },
    actions: { a: [{ ...fail("server_error", 503), kind: "partial" }], b: [ok()] },
  },
  {
    name: "tool_call_then_failure",
    endpoints: { a: "https://a.invalid/v1", b: "https://b.invalid/v1", c: "https://c.invalid/v1" },
    actions: { a: [{ ...fail("server_error", 503), kind: "tool_failure" }], b: [ok()] },
  },
];

async function runScenario(scenario: Scenario, halo: boolean) {
  let clock = 0;
  const calls: Array<{ provider: string; domain: string; action: Action }> = [];
  const routerEvents: RouterEvent[] = [];
  const actionQueues = Object.fromEntries(
    Object.entries(scenario.actions).map(([provider, actions]) => [provider, actions.map((action) => ({ ...action }))]),
  );
  const runtime: ModelRuntime = {
    async *stream(req) {
      const action = actionQueues[req.provider]?.shift() ?? ok();
      clock += action.latencyMs;
      calls.push({ provider: req.provider, domain: scenario.endpoints[req.provider], action });
      yield { type: "request_started", provider: req.provider, model: req.model };
      if (action.kind === "partial") yield { type: "text_delta", text: "partial" };
      if (action.kind === "tool_failure") yield { type: "tool_call_end", toolCall: { id: "call-1", name: "side_effect", input: {} } };
      if (action.kind !== "success") {
        yield {
          type: "error",
          error: {
            provider: req.provider, protocol: "openai", code: action.code ?? "server_error",
            status: action.status, message: action.code ?? "server_error", retryable: true, retryAfterMs: 2_000,
          },
        };
        return;
      }
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "ok" };
      yield { type: "message_end", finishReason: "stop" };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } };
    },
    async complete() { throw new Error("not used"); },
    getCapabilities: () => ({
      supportsToolUse: true, supportsStreaming: true, supportsParallelToolCalls: false,
      supportsThinking: true, supportsJsonSchema: true, supportsSystemPrompt: true,
      supportsPromptCache: false, maxContextTokens: 100_000, maxOutputTokens: 4_096,
    }),
    getMultimodal: () => ({ input: ["text"] }),
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: (provider) => scenario.endpoints[provider],
  };
  const config: RouterConfig = {
    enabled: true,
    scenarios: { default: ref("a") },
    fallback: { default: [ref("b"), ref("c")], maxFallbacks: 3 },
    transientRetry: { enabled: false, maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    zeroUsageRetry: { enabled: false, maxAttempts: 1 },
    recovery: { enabled: halo, maxAttempts: 4, deadlineMs: 10_000 },
    stats: { enabled: false },
  };
  const router = createRouterRuntime(config, {
    modelRuntime: runtime,
    now: () => new Date(clock),
    events: { emit: (event) => routerEvents.push(event) },
  });
  const output: CanonicalModelEvent[] = [];
  for await (const event of router.execute(decision, request, { sessionId: `${scenario.name}-${halo}`, turnId: "1" })) output.push(event);
  await router.shutdown();
  const recovered = output.some((event) => event.type === "text_delta" && event.text === "ok");
  const firstFailureLatency = calls.find((call) => call.action.kind !== "success")?.action.latencyMs ?? 0;
  const invalidRetries = calls.slice(1).filter((call, index) => call.domain === calls[index]?.domain).length;
  return {
    scenario: scenario.name,
    policy: halo ? "halo" : "static",
    recovered,
    attempts: calls.length,
    invalidRetries,
    totalTimeMs: clock,
    recoveryTimeMs: recovered && firstFailureLatency ? clock - firstFailureLatency : undefined,
    estimatedRecoveryCost: Number(calls.reduce((sum, call) => sum + call.action.estimatedCost, 0).toFixed(6)),
    actualRecoveryCost: null,
    duplicateTextEvents: Math.max(0, output.filter((event) => event.type === "text_delta").length - 1),
    duplicateToolEvents: Math.max(0, output.filter((event) => event.type === "tool_call_end").length - 1),
    terminalErrors: output.filter((event) => event.type === "error").length,
    calls: calls.map(({ provider, domain, action }) => ({ provider, domain, kind: action.kind, code: action.code, latencyMs: action.latencyMs })),
    traces: routerEvents.filter((event) => event.type === "pilotdeck_router_attempt"),
  };
}

const results = [];
for (const scenario of scenarios) {
  results.push(await runScenario(scenario, false));
  results.push(await runScenario(scenario, true));
}
const outputDir = path.resolve(process.argv[2] ?? "artifacts/halo");
await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, "attempt-traces.jsonl"), results.map((result) => JSON.stringify(result)).join("\n") + "\n");
await writeFile(path.join(outputDir, "comparison.json"), JSON.stringify({
  seed: 20260911,
  generatedAt: new Date().toISOString(),
  scope: "deterministic injected service-failure distribution; not an online failure-rate estimate",
  budget: { maxDispatches: 4, deadlineMs: 10_000 },
  results,
}, null, 2) + "\n");
console.log(JSON.stringify(results.map(({ scenario, policy, recovered, attempts, invalidRetries, totalTimeMs }) => ({
  scenario, policy, recovered, attempts, invalidRetries, totalTimeMs,
})), null, 2));
console.log(`Wrote ${outputDir}`);
