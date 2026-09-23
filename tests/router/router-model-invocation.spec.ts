import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalModelRequest, ModelRuntime } from "../../src/model/index.js";
import type { InvocationLogContext } from "../../src/storage/legalDataStorage.js";
import {
  createRouterRuntime,
  type RouterModelInvocationPort,
} from "../../src/router/index.js";
import type { RouterConfig } from "../../src/router/config/schema.js";

const config: RouterConfig = {
  enabled: true,
  scenarios: { default: { id: "provider/model", provider: "provider", model: "model" } },
  transientRetry: { enabled: false, maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
  zeroUsageRetry: { enabled: false, maxAttempts: 1 },
  stats: { enabled: false },
};

const fallbackRuntime = {
  async *stream() {},
  async complete() { throw new Error("not used"); },
  getCapabilities() {
    return {
      supportsToolUse: true, supportsStreaming: true, supportsParallelToolCalls: false,
      supportsThinking: false, supportsJsonSchema: false, supportsSystemPrompt: true,
      supportsPromptCache: false, maxContextTokens: 8192, maxOutputTokens: 1024,
    };
  },
  getMultimodal() { return { input: ["text"] }; },
  getProviderProtocol() { return "openai"; },
  getProviderBaseUrl() { return "https://fallback.invalid"; },
} as unknown as ModelRuntime;

test("router delegates model execution and capability lookup to injected invocation port", async () => {
  const calls: string[] = [];
  let disposed = false;
  const invocation: RouterModelInvocationPort = {
    async *stream(request) {
      calls.push("stream:" + request.provider);
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "ok" };
      yield { type: "message_end", finishReason: "stop" };
    },
    getCapabilities(provider, model) {
      calls.push("capabilities:" + provider + "/" + model);
      return fallbackRuntime.getCapabilities(provider, model);
    },
    getMultimodal(provider, model) {
      calls.push("multimodal:" + provider + "/" + model);
      return fallbackRuntime.getMultimodal(provider, model);
    },
    getProviderProtocol(provider) {
      calls.push("protocol:" + provider);
      return "openai";
    },
    getProviderBaseUrl(provider) {
      calls.push("base-url:" + provider);
      return "https://injected.invalid";
    },
    dispose() { disposed = true; },
  };
  const router = createRouterRuntime(config, { modelRuntime: fallbackRuntime, modelInvoker: invocation });
  const events = [];
  for await (const event of router.execute({
    provider: "provider", model: "model", scenarioType: "default", isSubagent: false,
    orchestrating: false, resolvedFrom: "scenario", mutations: {},
  }, {
    provider: "provider", model: "model",
    maxOutputTokens: 256,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  }, { sessionId: "model-invocation", turnId: "turn-1" })) {
    events.push(event.type);
  }
  assert.deepEqual(events, ["message_start", "text_delta", "message_end"]);
  assert.equal(calls.some((call) => call.startsWith("stream:")), true);
  assert.equal(calls.some((call) => call.startsWith("capabilities:")), true);
  await router.shutdown();
  assert.equal(disposed, true);
});

test("router forwards invocation audit provenance to the model runtime", async () => {
  let invocationContext: InvocationLogContext | undefined;
  const sink = {
    stage() {},
    async append() {},
  };
  const invocation: RouterModelInvocationPort = {
    async *stream(_request, options) {
      invocationContext = options?.invocation?.context;
      yield { type: "message_start", role: "assistant" };
      yield { type: "message_end", finishReason: "stop" };
    },
    getCapabilities(provider, model) {
      return fallbackRuntime.getCapabilities(provider, model);
    },
    getMultimodal(provider, model) {
      return fallbackRuntime.getMultimodal(provider, model);
    },
    getProviderProtocol() { return "openai"; },
    getProviderBaseUrl() { return "https://injected.invalid"; },
  };
  const router = createRouterRuntime(config, { modelRuntime: fallbackRuntime, modelInvoker: invocation });

  for await (const _event of router.execute({
    provider: "provider", model: "model", scenarioType: "default", isSubagent: true,
    orchestrating: false, resolvedFrom: "scenario", mutations: {},
  }, {
    provider: "provider", model: "model",
    maxOutputTokens: 256,
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  }, {
    workspaceId: "workspace-1",
    sessionId: "session-1",
    turnId: "turn-1",
    runId: "run-1",
    caller: "subagent",
    subSessionId: "sub-session-1",
    parentToolCallId: "tool-call-1",
    invocationLogSink: sink,
  })) {
    // Consume the stream so the invocation reaches the model boundary.
  }

  assert.ok(invocationContext);
  const { logicalCallId, ...stableContext } = invocationContext;
  assert.deepEqual(stableContext, {
    workspaceId: "workspace-1",
    sessionId: "session-1",
    turnId: "turn-1",
    runId: "run-1",
    caller: "subagent",
    subSessionId: "sub-session-1",
    parentToolCallId: "tool-call-1",
  });
  assert.equal(typeof logicalCallId, "string");
  await router.shutdown();
});
