import assert from "node:assert/strict";
import test from "node:test";

import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalModelResponse,
  ModelRuntime,
} from "../../src/model/index.js";
import { createRouterRuntime } from "../../src/router/index.js";
import type { RouterConfig } from "../../src/router/config/schema.js";

const SUCCESS_EVENTS: CanonicalModelEvent[] = [
  { type: "message_start", role: "assistant" },
  { type: "text_delta", text: "ok" },
  { type: "usage", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
  { type: "message_end", finishReason: "stop" },
];

const BASE_REQUEST: CanonicalModelRequest = {
  provider: "ignored",
  model: "ignored",
  messages: [{ role: "user", content: [{ type: "text", text: "build a complex system" }] }],
  tools: [
    { name: "bash", description: "run", inputSchema: { type: "object" } },
    { name: "agent", description: "delegate", inputSchema: { type: "object" } },
    { name: "read_file", description: "read", inputSchema: { type: "object" } },
    { name: "web_search", description: "search", inputSchema: { type: "object" } },
  ],
  systemPrompt: "You are PilotDeck.\nDo the work.\nUse memory_search if needed.\nBe precise.",
};

test("auto-orchestrate injects its selected skill prompt", async () => {
  const model = scriptedModel(1);
  const router = createRouterRuntime(orchestrationConfig({ skillExtensionId: "orchestrate" }), {
    modelRuntime: model,
    judgeRuntime: judge("COMPLEX"),
    loadSkillPrompt: async () => "Delegate independent work to sub-agents.",
  });

  await drain(router.stream(BASE_REQUEST, context("s1", "t1")));

  assert.match(textOf(model.received[0]?.messages[0]), /Delegate independent work/);
});

test("auto-orchestrate applies the allowed tool set", async () => {
  const model = scriptedModel(1);
  const router = createRouterRuntime(orchestrationConfig({
    allowedTools: ["agent", "read_file"],
    blockedTools: undefined,
  }), { modelRuntime: model, judgeRuntime: judge("COMPLEX") });

  await drain(router.stream(BASE_REQUEST, context("s1", "t1")));

  assert.deepEqual(model.received[0]?.tools?.map(tool => tool.name), ["agent", "read_file"]);
});

test("auto-orchestrate applies an explicitly empty allowlist", async () => {
  const model = scriptedModel(1);
  const router = createRouterRuntime(orchestrationConfig({
    allowedTools: [],
    blockedTools: ["bash"],
  }), { modelRuntime: model, judgeRuntime: judge("COMPLEX") });

  await drain(router.stream(BASE_REQUEST, context("s1", "t1")));

  assert.deepEqual(model.received[0]?.tools, []);
});

test("auto-orchestrate does not fall back when no allowlisted tool matches", async () => {
  const model = scriptedModel(1);
  const router = createRouterRuntime(orchestrationConfig({
    allowedTools: ["missing_tool"],
    blockedTools: undefined,
  }), { modelRuntime: model, judgeRuntime: judge("COMPLEX") });

  await drain(router.stream(BASE_REQUEST, context("s1", "t1")));

  assert.deepEqual(model.received[0]?.tools, []);
});

test("auto-orchestrate never wraps a subagent request again", async () => {
  const model = scriptedModel(1);
  const router = createRouterRuntime(orchestrationConfig({ allowedTools: ["agent"] }), {
    modelRuntime: model,
    judgeRuntime: judge("COMPLEX"),
  });

  await drain(router.stream(BASE_REQUEST, { ...context("s1", "t1"), isMainAgent: false }));

  assert.equal(model.received[0]?.tools?.length, BASE_REQUEST.tools?.length);
});

test("auto-orchestrate slims the system prompt but preserves memory guidance", async () => {
  const model = scriptedModel(1);
  const router = createRouterRuntime(orchestrationConfig({ slimSystemPrompt: true }), {
    modelRuntime: model,
    judgeRuntime: judge("COMPLEX"),
  });

  await drain(router.stream(BASE_REQUEST, context("s1", "t1")));

  const prompt = model.received[0]?.systemPrompt ?? "";
  assert.match(prompt, /orchestration agent/i);
  assert.match(prompt, /memory_search/);
  assert.doesNotMatch(prompt, /Do the work/);
});

test("token saver reuses the sticky model within a session", async () => {
  const model = scriptedModel(2);
  const router = createRouterRuntime(tokenSaverConfig(), {
    modelRuntime: model,
    judgeRuntime: judgeSequence(["COMPLEX"]),
  });

  await drain(router.stream(BASE_REQUEST, context("s1", "t1")));
  await drain(router.stream(multiTurnRequest(), context("s1", "t2")));

  assert.deepEqual(model.received.map(request => request.model), ["expensive", "expensive"]);
});

test("token saver subagent skip policy does not invoke the judge", async () => {
  const model = scriptedModel(1);
  let judgeCalls = 0;
  const config = tokenSaverConfig();
  config.tokenSaver = { ...config.tokenSaver!, subagent: { policy: "skip" } };
  const runtime = judge("COMPLEX", () => { judgeCalls += 1; });
  const router = createRouterRuntime(config, { modelRuntime: model, judgeRuntime: runtime });

  await drain(router.stream(BASE_REQUEST, { ...context("s1", "t1"), isMainAgent: false }));

  assert.equal(judgeCalls, 0);
});

test("token saver keeps independent sticky state for different sessions", async () => {
  const model = scriptedModel(2);
  const router = createRouterRuntime(tokenSaverConfig(), {
    modelRuntime: model,
    judgeRuntime: judgeSequence(["COMPLEX", "SIMPLE"]),
  });

  await drain(router.stream(BASE_REQUEST, context("session-a", "t1")));
  await drain(router.stream(BASE_REQUEST, context("session-b", "t1")));

  assert.deepEqual(model.received.map(request => request.model), ["expensive", "cheap"]);
});

test("token saver judge policy classifies a subagent independently", async () => {
  const model = scriptedModel(2);
  const config = tokenSaverConfig();
  config.tokenSaver = { ...config.tokenSaver!, subagent: { policy: "judge" } };
  const router = createRouterRuntime(config, {
    modelRuntime: model,
    judgeRuntime: judgeSequence(["COMPLEX", "SIMPLE"]),
  });

  await drain(router.stream(BASE_REQUEST, context("s1", "t1")));
  await drain(router.stream(BASE_REQUEST, { ...context("s1", "t2"), isMainAgent: false }));

  assert.deepEqual(model.received.map(request => request.model), ["expensive", "cheap"]);
});

test("invalidateSticky clears routing but preserves orchestration state", async () => {
  const model = scriptedModel(1);
  const router = createRouterRuntime(orchestrationConfig({
    slimSystemPrompt: true,
    allowedTools: ["agent"],
  }), { modelRuntime: model, judgeRuntime: judge("COMPLEX") });
  await drain(router.stream(BASE_REQUEST, context("s1", "t1")));

  const invalidated = router.invalidateSticky("s1");

  assert.equal(invalidated.previousTier, "COMPLEX");
  assert.equal(invalidated.orchestrating, true);
});

test("invalidateSticky reports an empty state for an unknown session", () => {
  const router = createRouterRuntime(tokenSaverConfig(), {
    modelRuntime: scriptedModel(0),
    judgeRuntime: judge("SIMPLE"),
  });

  assert.deepEqual(router.invalidateSticky("missing"), {
    previousTier: undefined,
    previousProvider: undefined,
    previousModel: undefined,
    orchestrating: false,
  });
});

test("invalidateSticky forces the next multi-turn request through the judge", async () => {
  const model = scriptedModel(2);
  const router = createRouterRuntime(tokenSaverConfig(), {
    modelRuntime: model,
    judgeRuntime: judgeSequence(["SIMPLE", "COMPLEX"]),
  });
  await drain(router.stream(BASE_REQUEST, context("s1", "t1")));

  router.invalidateSticky("s1");
  await drain(router.stream(multiTurnRequest(), context("s1", "t2")));

  assert.deepEqual(model.received.map(request => request.model), ["cheap", "expensive"]);
});

test("token saver includes previousTier in the judge request", async () => {
  let captured: CanonicalModelRequest | undefined;
  const runtime = judge("COMPLEX", (_count, request) => { captured = request; });
  const router = createRouterRuntime(tokenSaverConfig(), {
    modelRuntime: scriptedModel(1),
    judgeRuntime: runtime,
  });

  await drain(router.stream(BASE_REQUEST, { ...context("s1", "t1"), previousTier: "SIMPLE" }));

  assert.match(textOf(captured?.messages[0]), /previous turn was classified as: \*\*SIMPLE\*\*/i);
});

function orchestrationConfig(overrides: Partial<NonNullable<RouterConfig["autoOrchestrate"]>>): RouterConfig {
  const config = tokenSaverConfig();
  return {
    ...config,
    autoOrchestrate: {
      enabled: true,
      triggerTiers: ["COMPLEX"],
      slimSystemPrompt: false,
      blockedTools: [],
      ...overrides,
    },
  };
}

function tokenSaverConfig(): RouterConfig {
  return {
    scenarios: { default: { id: "p/default", provider: "p", model: "default" } },
    zeroUsageRetry: { enabled: false, maxAttempts: 0 },
    tokenSaver: {
      enabled: true,
      judge: { id: "p/judge", provider: "p", model: "judge" },
      defaultTier: "SIMPLE",
      tiers: {
        SIMPLE: { model: { id: "p/cheap", provider: "p", model: "cheap" } },
        COMPLEX: { model: { id: "p/expensive", provider: "p", model: "expensive" } },
      },
      judgeTimeoutMs: 5_000,
    },
  };
}

function scriptedModel(count: number): ModelRuntime & { received: CanonicalModelRequest[] } {
  const received: CanonicalModelRequest[] = [];
  return {
    received,
    async *stream(request: CanonicalModelRequest) {
      received.push(request);
      if (received.length > count) throw new Error("unexpected model request");
      for (const event of SUCCESS_EVENTS) yield event;
    },
    async complete(): Promise<CanonicalModelResponse> { throw new Error("complete is not used"); },
    getCapabilities: modelCapabilities,
    getMultimodal: () => ({ input: ["text" as const] }),
    getProviderProtocol: () => undefined,
    getProviderBaseUrl: () => undefined,
  };
}

function judge(
  tier: string,
  observe?: (count: number, request: CanonicalModelRequest) => void,
): ModelRuntime {
  let count = 0;
  return {
    async *stream() { throw new Error("stream is not used"); },
    async complete(request): Promise<CanonicalModelResponse> {
      count += 1;
      observe?.(count, request);
      return { role: "assistant", content: [{ type: "text", text: `<tier>${tier}</tier>` }], finishReason: "stop" };
    },
    getCapabilities: modelCapabilities,
    getMultimodal: () => ({ input: ["text" as const] }),
    getProviderProtocol: () => undefined,
    getProviderBaseUrl: () => undefined,
  };
}

function judgeSequence(tiers: string[]): ModelRuntime {
  let index = 0;
  return {
    async *stream() { throw new Error("stream is not used"); },
    async complete(): Promise<CanonicalModelResponse> {
      const tier = tiers[index++] ?? tiers.at(-1) ?? "SIMPLE";
      return { role: "assistant", content: [{ type: "text", text: `<tier>${tier}</tier>` }], finishReason: "stop" };
    },
    getCapabilities: modelCapabilities,
    getMultimodal: () => ({ input: ["text" as const] }),
    getProviderProtocol: () => undefined,
    getProviderBaseUrl: () => undefined,
  };
}

function modelCapabilities() {
  return {
    supportsToolUse: true,
    supportsStreaming: true,
    supportsParallelToolCalls: true,
    supportsThinking: false,
    supportsJsonSchema: true,
    supportsSystemPrompt: true,
    supportsPromptCache: false,
    maxContextTokens: 100_000,
    maxOutputTokens: 4_000,
  };
}

function context(sessionId: string, turnId: string) {
  return { sessionId, turnId, isMainAgent: true };
}

function multiTurnRequest(): CanonicalModelRequest {
  return {
    ...BASE_REQUEST,
    messages: [
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      { role: "user", content: [{ type: "text", text: "refactor everything" }] },
    ],
  };
}

function textOf(message: CanonicalModelRequest["messages"][number] | undefined): string {
  return message?.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n") ?? "";
}

async function drain(stream: AsyncIterable<CanonicalModelEvent>): Promise<void> {
  for await (const _event of stream) void _event;
}
