import test from "node:test";
import assert from "node:assert/strict";
import { AgentLoop } from "../../src/agent/index.js";
import type { AgentEvent, AgentRuntimeConfig, AgentRuntimeDependencies } from "../../src/agent/index.js";
import type { CanonicalModelEvent, CanonicalModelRequest } from "../../src/model/index.js";
import type { AgentContextPrepareInput } from "../../src/context/index.js";
import type { RouterDecision } from "../../src/router/index.js";

test("empty length responses increase output and retry before surfacing assistant message", async () => {
  const requests: CanonicalModelRequest[] = [];
  let executeCount = 0;

  const dependencies: AgentRuntimeDependencies = {
    router: {
      async decide(): Promise<RouterDecision> {
        return {
          provider: "google",
          model: "gemini-test",
          scenarioType: "default",
          isSubagent: false,
          orchestrating: false,
          resolvedFrom: "scenario",
          mutations: {},
        };
      },
      async *execute(_decision: RouterDecision, request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
        requests.push(request);
        executeCount += 1;
        yield { type: "message_start", role: "assistant" };
        if (executeCount <= 2) {
          yield { type: "usage", usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 } };
          yield { type: "message_end", finishReason: "length" };
          return;
        }
        yield { type: "text_delta", text: "ok" };
        yield { type: "usage", usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } };
        yield { type: "message_end", finishReason: "stop" };
      },
      stream(): AsyncIterable<CanonicalModelEvent> {
        throw new Error("not used");
      },
    },
    tools: {
      scheduler: { executeAll: async () => [] },
      registry: { list: () => [], toCanonicalSchemas: () => [] },
    },
    now: () => new Date("2026-07-08T00:00:00.000Z"),
  } as unknown as AgentRuntimeDependencies;

  const config: AgentRuntimeConfig = {
    provider: "google",
    model: "gemini-test",
    cwd: "/tmp/pilotdeck-test",
    maxOutputTokens: 16,
    permissionMode: "default",
    permissionContext: {
      mode: "default",
      cwd: "/tmp/pilotdeck-test",
      additionalWorkingDirectories: [],
      rules: { allow: [], deny: [], ask: [] },
      canPrompt: false,
      bypassAvailable: false,
    },
  };

  const loop = new AgentLoop(config, dependencies);
  const events: AgentEvent[] = [];
  const result = await (async () => {
    const iterator = loop.run({
      sessionId: "session-1",
      turnId: "turn-1",
      messages: [{ role: "user", content: [{ type: "text", text: "say ok" }] }],
    });
    while (true) {
      const next = await iterator.next();
      if (next.done) return next.value;
      events.push(next.value);
    }
  })();

  const assistantMessages = events.filter((event) => event.type === "assistant_message");
  assert.equal(result.result.type, "success");
  assert.equal(requests.length, 3);
  assert.equal(requests[0]?.maxOutputTokens, 16);
  assert.equal(requests[1]?.maxOutputTokens, 4096);
  assert.equal(requests[2]?.maxOutputTokens, 8192);
  assert.equal(events.some((event) => event.type === "turn_continued" && event.reason === "model_error"), true);
  assert.equal(assistantMessages.length, 1);
  assert.deepEqual(assistantMessages[0]?.message.content, [{ type: "text", text: "ok" }]);
});

test("provider output caps are scoped per routed provider and model", async () => {
  const requests: CanonicalModelRequest[] = [];
  let executeCount = 0;

  const dependencies: AgentRuntimeDependencies = {
    router: {
      async decide(): Promise<RouterDecision> {
        return {
          provider: executeCount === 0 ? "provider-a" : "provider-b",
          model: executeCount === 0 ? "model-a" : "model-b",
          scenarioType: "default",
          isSubagent: false,
          orchestrating: false,
          resolvedFrom: "scenario",
          mutations: {},
        };
      },
      async *execute(decision: RouterDecision, request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
        requests.push(request);
        executeCount += 1;
        yield { type: "message_start", role: "assistant" };
        if (decision.provider === "provider-a") {
          yield {
            type: "error",
            error: {
              provider: "provider-a",
              protocol: "openai",
              code: "invalid_request",
              message: "max_tokens must be at most 32768",
              retryable: false,
              maxOutputTokens: 32_768,
            },
          };
          return;
        }
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_end", finishReason: "stop" };
      },
      stream(): AsyncIterable<CanonicalModelEvent> {
        throw new Error("not used");
      },
    },
    tools: {
      scheduler: { executeAll: async () => [] },
      registry: { list: () => [], toCanonicalSchemas: () => [] },
    },
    context: {
      prepareForModel: async (input: AgentContextPrepareInput) => ({
        messages: input.messages,
        systemPromptParts: [],
        tools: input.tools,
        diagnostics: [],
        boundaries: [],
      }),
      recoverFromModelError: async () => ({ type: "adjust_output_and_retry", maxOutputTokens: 32_768, reason: "provider-output-cap" }),
    },
  } as unknown as AgentRuntimeDependencies;

  const loop = new AgentLoop(baseConfig(), dependencies);
  const events: AgentEvent[] = [];
  const result = await collectLoop(loop, events);

  assert.equal(result.result.type, "success");
  assert.equal(requests[0]?.provider, "provider-a");
  assert.equal(requests[0]?.maxOutputTokens, 65_536);
  assert.equal(requests[1]?.provider, "provider-b");
  assert.equal(requests[1]?.maxOutputTokens, 65_536);
});

test("provider output caps are hard bounds below configured and catalog caps", async () => {
  const requests: CanonicalModelRequest[] = [];
  let executeCount = 0;

  const dependencies: AgentRuntimeDependencies = {
    router: {
      async decide(): Promise<RouterDecision> {
        return {
          provider: "provider-a",
          model: "model-a",
          scenarioType: "default",
          isSubagent: false,
          orchestrating: false,
          resolvedFrom: "scenario",
          mutations: {},
        };
      },
      async *execute(_decision: RouterDecision, request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
        requests.push(request);
        executeCount += 1;
        yield { type: "message_start", role: "assistant" };
        if (executeCount === 1) {
          yield {
            type: "error",
            error: {
              provider: "provider-a",
              protocol: "openai",
              code: "invalid_request",
              message: "max_tokens must be at most 32768",
              retryable: false,
              maxOutputTokens: 32_768,
            },
          };
          return;
        }
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_end", finishReason: "stop" };
      },
      stream(): AsyncIterable<CanonicalModelEvent> {
        throw new Error("not used");
      },
    },
    tools: {
      scheduler: { executeAll: async () => [] },
      registry: { list: () => [], toCanonicalSchemas: () => [] },
    },
    context: {
      prepareForModel: async (input: AgentContextPrepareInput) => ({
        messages: input.messages,
        systemPromptParts: [],
        tools: input.tools,
        diagnostics: [],
        boundaries: [],
      }),
      recoverFromModelError: async () => ({ type: "adjust_output_and_retry", maxOutputTokens: 32_768, reason: "provider-output-cap" }),
    },
    getModelTokenLimits: () => ({ maxContextTokens: 1_000_000, maxOutputTokens: 65_536 }),
  } as unknown as AgentRuntimeDependencies;

  const loop = new AgentLoop(baseConfig(), dependencies);
  const result = await collectLoop(loop, []);

  assert.equal(result.result.type, "success");
  assert.equal(requests[0]?.maxOutputTokens, 65_536);
  assert.equal(requests[1]?.maxOutputTokens, 32_768);
});

test("available output recovery does not become a session hard cap", async () => {
  const requests: CanonicalModelRequest[] = [];
  let executeCount = 0;

  const dependencies: AgentRuntimeDependencies = {
    router: {
      async decide(): Promise<RouterDecision> {
        return {
          provider: "provider-a",
          model: "model-a",
          scenarioType: "default",
          isSubagent: false,
          orchestrating: false,
          resolvedFrom: "scenario",
          mutations: {},
        };
      },
      async *execute(_decision: RouterDecision, request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
        requests.push(request);
        executeCount += 1;
        yield { type: "message_start", role: "assistant" };
        if (executeCount === 1) {
          yield {
            type: "error",
            error: {
              provider: "provider-a",
              protocol: "openai",
              code: "context_overflow",
              message: "available_tokens: 8192",
              retryable: false,
              availableOutputTokens: 8_192,
              recoverableViaCompact: true,
            },
          };
          return;
        }
        if (executeCount === 2) {
          yield { type: "message_end", finishReason: "length" };
          return;
        }
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_end", finishReason: "stop" };
      },
      stream(): AsyncIterable<CanonicalModelEvent> {
        throw new Error("not used");
      },
    },
    tools: {
      scheduler: { executeAll: async () => [] },
      registry: { list: () => [], toCanonicalSchemas: () => [] },
    },
    context: {
      prepareForModel: async (input: AgentContextPrepareInput) => ({
        messages: input.messages,
        systemPromptParts: [],
        tools: input.tools,
        diagnostics: [],
        boundaries: [],
      }),
      recoverFromModelError: async () => ({
        type: "adjust_output_and_retry",
        maxOutputTokens: 8_192,
        reason: "provider-output-cap",
        scope: "attempt",
      }),
    },
    getModelTokenLimits: () => ({ maxContextTokens: 1_000_000, maxOutputTokens: 65_536 }),
  } as unknown as AgentRuntimeDependencies;

  const loop = new AgentLoop(baseConfig(), dependencies);
  const result = await collectLoop(loop, []);

  assert.equal(result.result.type, "success");
  assert.equal(requests[0]?.maxOutputTokens, 65_536);
  assert.equal(requests[1]?.maxOutputTokens, 8_192);
  assert.equal(requests[2]?.maxOutputTokens, 65_536);
});

test("empty length output jump is clamped by model output cap", async () => {
  const requests: CanonicalModelRequest[] = [];
  let executeCount = 0;
  const dependencies: AgentRuntimeDependencies = {
    router: {
      async decide(): Promise<RouterDecision> {
        return {
          provider: "google",
          model: "small-output-model",
          scenarioType: "default",
          isSubagent: false,
          orchestrating: false,
          resolvedFrom: "scenario",
          mutations: {},
        };
      },
      async *execute(_decision: RouterDecision, request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
        requests.push(request);
        executeCount += 1;
        yield { type: "message_start", role: "assistant" };
        if (executeCount === 1) {
          yield { type: "message_end", finishReason: "length" };
          return;
        }
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_end", finishReason: "stop" };
      },
      stream(): AsyncIterable<CanonicalModelEvent> {
        throw new Error("not used");
      },
    },
    tools: {
      scheduler: { executeAll: async () => [] },
      registry: { list: () => [], toCanonicalSchemas: () => [] },
    },
    getModelTokenLimits: () => ({ maxContextTokens: 65_536, maxOutputTokens: 2_048 }),
  } as unknown as AgentRuntimeDependencies;

  const config = { ...baseConfig(), model: "small-output-model", maxOutputTokens: 16 };
  const loop = new AgentLoop(config, dependencies);
  const result = await collectLoop(loop, []);

  assert.equal(result.result.type, "success");
  assert.equal(requests[0]?.maxOutputTokens, 16);
  assert.equal(requests[1]?.maxOutputTokens, 2_048);
});

test("routed requests clamp configured output to routed model cap", async () => {
  const requests: CanonicalModelRequest[] = [];
  const dependencies: AgentRuntimeDependencies = {
    router: {
      async decide(): Promise<RouterDecision> {
        return {
          provider: "small-provider",
          model: "small-model",
          scenarioType: "default",
          isSubagent: false,
          orchestrating: false,
          resolvedFrom: "scenario",
          mutations: {},
        };
      },
      async *execute(_decision: RouterDecision, request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
        requests.push(request);
        yield { type: "message_start", role: "assistant" };
        yield { type: "text_delta", text: "ok" };
        yield { type: "message_end", finishReason: "stop" };
      },
      stream(): AsyncIterable<CanonicalModelEvent> {
        throw new Error("not used");
      },
    },
    tools: {
      scheduler: { executeAll: async () => [] },
      registry: { list: () => [], toCanonicalSchemas: () => [] },
    },
    getModelTokenLimits: () => ({ maxContextTokens: 32_768, maxOutputTokens: 8_192 }),
  } as unknown as AgentRuntimeDependencies;

  const loop = new AgentLoop(baseConfig(), dependencies);
  const result = await collectLoop(loop, []);

  assert.equal(result.result.type, "success");
  assert.equal(requests[0]?.provider, "small-provider");
  assert.equal(requests[0]?.model, "small-model");
  assert.equal(requests[0]?.maxOutputTokens, 8_192);
});

test("pre-routing compaction reserves the current model output cap by default", async () => {
  let reservedOutputTokens: number | undefined;
  const dependencies: AgentRuntimeDependencies = {
    router: {
      async decide(): Promise<RouterDecision> {
        return {
          provider: "google",
          model: "gemini-test",
          scenarioType: "default",
          isSubagent: false,
          orchestrating: false,
          resolvedFrom: "scenario",
          mutations: {},
        };
      },
      async *execute(_decision: RouterDecision, request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
        yield { type: "message_start", role: "assistant" };
        yield { type: "text_delta", text: `reserved=${request.maxOutputTokens}` };
        yield { type: "message_end", finishReason: "stop" };
      },
      stream(): AsyncIterable<CanonicalModelEvent> {
        throw new Error("not used");
      },
    },
    tools: {
      scheduler: { executeAll: async () => [] },
      registry: { list: () => [], toCanonicalSchemas: () => [] },
    },
    context: {
      prepareForModel: async (input: AgentContextPrepareInput) => ({
        messages: input.messages,
        systemPromptParts: [],
        tools: input.tools,
        diagnostics: [],
        boundaries: [],
      }),
      tryAutoCompact: async (input: { reservedOutputTokens?: number }) => {
        reservedOutputTokens = input.reservedOutputTokens;
        return {
          type: "skipped" as const,
          snapshot: {
            tokens: 1,
            maxContextTokens: 1_000_000,
            warningRatio: 0.8,
            blockingRatio: 0.95,
            state: "ok" as const,
            ratio: 0,
          },
        };
      },
    },
    getModelTokenLimits: () => ({ maxContextTokens: 1_000_000, maxOutputTokens: 65_536 }),
  } as unknown as AgentRuntimeDependencies;

  const config = { ...baseConfig(), maxOutputTokens: undefined };
  const loop = new AgentLoop(config, dependencies);
  const result = await collectLoop(loop, []);

  assert.equal(result.result.type, "success");
  assert.equal(reservedOutputTokens, 65_536);
});

function baseConfig(): AgentRuntimeConfig {
  return {
    provider: "google",
    model: "gemini-test",
    cwd: "/tmp/pilotdeck-test",
    maxOutputTokens: 65_536,
    permissionMode: "default",
    permissionContext: {
      mode: "default",
      cwd: "/tmp/pilotdeck-test",
      additionalWorkingDirectories: [],
      rules: { allow: [], deny: [], ask: [] },
      canPrompt: false,
      bypassAvailable: false,
    },
  };
}

async function collectLoop(loop: AgentLoop, events: AgentEvent[]) {
  const iterator = loop.run({
    sessionId: "session-1",
    turnId: "turn-1",
    messages: [{ role: "user", content: [{ type: "text", text: "say ok" }] }],
  });
  while (true) {
    const next = await iterator.next();
    if (next.done) return next.value;
    events.push(next.value);
  }
}
