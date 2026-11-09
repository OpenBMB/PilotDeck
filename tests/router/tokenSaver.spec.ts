import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalModelRequest, ModelRuntime } from "../../src/model/index.js";
import { ModelProviderError } from "../../src/model/index.js";
import { classifyAndRoute } from "../../src/router/index.js";
import { DefaultContextRuntime } from "../../src/context/DefaultContextRuntime.js";
import { setImmediate as tick } from "node:timers/promises";

test("cancellation stops awaiting a judge that ignores its signal", async () => {
  const abort = new AbortController();
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  let signal: AbortSignal | undefined;
  const judgeRuntime = { complete: async (_request, options) => {
    signal = options?.signal;
    started();
    return new Promise(() => {});
  } } as ModelRuntime;
  const pending = classifyAndRoute({ config: config(), messages: [{ role: "user", content: [{ type: "text", text: "synthetic task" }] }],
    judgeRuntime, abortSignal: abort.signal });
  await entered;
  const reason = new Error("synthetic stop");
  abort.abort(reason);
  await assert.rejects(pending, error => error === reason);
  assert.equal(signal?.aborted, true);
});

test("cancellation during judge retry backoff starts no new provider request", async () => {
  const abort = new AbortController();
  let calls = 0;
  const judgeRuntime = { complete: async () => {
    calls++;
    return { role: "assistant", content: [], finishReason: "stop" };
  } } as unknown as ModelRuntime;
  let settled = false;
  const pending = classifyAndRoute({ config: config(), messages: [{ role: "user", content: [{ type: "text", text: "synthetic task" }] }],
    judgeRuntime, abortSignal: abort.signal }).finally(() => { settled = true; });
  await tick();
  const reason = new Error("synthetic stop");
  const rejection = assert.rejects(pending, error => error === reason);
  abort.abort(reason);
  await tick();
  assert.equal(settled, true, "Cancellation must not await the one-second retry delay");
  await rejection;
  assert.equal(calls, 1);
});

test("classifies the latest real request after tool results, steering, artifacts and retrieved memory", async () => {
  const task = "Find and repair the concurrent transaction failure.";
  const context = new DefaultContextRuntime({
    sessionArtifactContext: async () => "An earlier output is available as an attachment.",
    memoryResolver: {
      async retrieve() { return { systemContext: "An old task was a simple greeting.", diagnostics: [] }; },
      async captureTurn() {},
    },
  });
  const prepared = await context.prepareForModel({
    sessionId: "memory-routing", turnId: "memory-routing", cwd: process.cwd(), provider: "main", model: "main-model",
    permissionMode: "default", additionalWorkingDirectories: [], tools: [],
    messages: [
      { role: "user", content: [{ type: "text", text: "Inspect the project." }] },
      { role: "assistant", content: [{ type: "tool_call", id: "read", name: "read_file", input: {} }] },
      { role: "user", content: [{ type: "tool_result", toolCallId: "read", content: [{ type: "text", text: "Source code" }] }] },
      { role: "user", content: [{ type: "text", text: task }], metadata: { queueItemId: "user-steer" } },
    ],
  });
  assert.equal(prepared.messages.at(-1)?.metadata?.purpose, "memory_context");
  let prompt = "";
  const judgeRuntime = { complete: async (request: CanonicalModelRequest) => {
    prompt = JSON.stringify(request.messages);
    return { role: "assistant", content: [{ type: "text", text: "<tier>medium</tier>" }], finishReason: "stop" };
  } } as unknown as ModelRuntime;
  await classifyAndRoute({ config: config(), messages: prepared.messages, judgeRuntime });
  assert.ok(prompt.includes(task));
  assert.doesNotMatch(prompt, /old task|earlier output|Source code|Inspect the project/);
});

test("request-only context without a real task does not invoke the routing judge", async () => {
  let calls = 0;
  const judgeRuntime = { complete: async () => {
    calls++;
    return { role: "assistant", content: [{ type: "text", text: "<tier>medium</tier>" }], finishReason: "stop" };
  } } as unknown as ModelRuntime;
  const result = await classifyAndRoute({ config: config(), judgeRuntime, messages: [
    { role: "user", content: [{ type: "text", text: "Retrieved background." }], metadata: { synthetic: true, purpose: "memory_context" } },
  ] });
  assert.equal(result?.resolvedFrom, "default");
  assert.equal(calls, 0);
});

test("classifies the real task after context appends a midnight date update", async () => {
  let now = new Date("2026-09-10T23:59:00Z");
  const context = new DefaultContextRuntime({ now: () => now });
  const input = {
    sessionId: "midnight-routing",
    turnId: "first",
    cwd: "/workspace",
    provider: "main",
    model: "main-model",
    permissionMode: "default",
    runMode: "agent",
    additionalWorkingDirectories: [],
    tools: [],
    messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }] }],
  };
  await context.prepareForModel(input);
  now = new Date("2026-09-11T00:01:00Z");
  const task = "Design a distributed transaction coordinator with crash recovery.";
  const prepared = await context.prepareForModel({
    ...input,
    turnId: "second",
    messages: [
      ...input.messages,
      { role: "assistant", content: [{ type: "text", text: "Ready." }] },
      { role: "user", content: [{ type: "text", text: task }] },
    ],
  });
  assert.equal(prepared.messages.at(-1)?.metadata?.purpose, "date_update");
  let request: CanonicalModelRequest | undefined;
  const judgeRuntime = {
    complete: async (nextRequest: CanonicalModelRequest) => {
      request = nextRequest;
      return {
        role: "assistant",
        content: [{ type: "text", text: "<tier>medium</tier>" }],
        finishReason: "stop",
      };
    },
  } as unknown as ModelRuntime;
  await classifyAndRoute({ config: config(), messages: prepared.messages, judgeRuntime });
  const judgePrompt = JSON.stringify(request?.messages);
  assert.ok(judgePrompt.includes(task), "judge must receive the actual user task");
  assert.ok(!judgePrompt.includes("<date-update>"), "date notices must not become classification input");
});

test("records the normalized judge error when token-saver falls back", async () => {
  let attempts = 0;
  const judgeRuntime = {
    complete: async () => {
      attempts += 1;
      throw new ModelProviderError({
        provider: "judge-provider",
        protocol: "openai",
        code: "auth_error",
        message: "API key rejected by the provider.",
        retryable: false,
      });
    },
  } as unknown as ModelRuntime;

  const result = await classifyAndRoute({
    config: config(),
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    judgeRuntime,
  });

  assert.equal(attempts, 1);
  assert.deepEqual(result?.failure, {
    reason: "model_error",
    attempts: 1,
    code: "auth_error",
    message: "API key rejected by the provider.",
  });
});

test("retries a retryable judge provider error before falling back", async () => {
  let attempts = 0;
  const judgeRuntime = {
    complete: async () => {
      attempts += 1;
      throw new ModelProviderError({
        provider: "judge-provider",
        protocol: "openai",
        code: "server_error",
        message: "Provider temporarily unavailable.",
        retryable: true,
      });
    },
  } as unknown as ModelRuntime;

  const result = await classifyAndRoute({
    config: config(),
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    judgeRuntime,
  });

  assert.equal(attempts, 3);
  assert.equal(result?.failure?.attempts, 3);
});

test("redacts credentials from a judge error before returning diagnostics", async () => {
  const judgeRuntime = {
    complete: async () => {
      throw new ModelProviderError({
        provider: "judge-provider",
        protocol: "openai",
        code: "auth_error",
        message: "Authorization: Bearer super-secret-token apiKey=also-secret",
        retryable: false,
      });
    },
  } as unknown as ModelRuntime;

  const result = await classifyAndRoute({
    config: config(),
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    judgeRuntime,
  });

  assert.equal(
    result?.failure?.message,
    "Authorization: Bearer <redacted> apiKey=<redacted>",
  );
});

test("records a plain network error message when the judge request fails", async () => {
  const judgeRuntime = {
    complete: async () => {
      throw new TypeError("fetch failed");
    },
  } as unknown as ModelRuntime;

  const result = await classifyAndRoute({
    config: config(),
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    judgeRuntime,
  });

  assert.equal(result?.failure?.message, "fetch failed");
});

test("omits temperature for an Anthropic judge", async () => {
  let request: CanonicalModelRequest | undefined;
  const judgeRuntime = {
    getProviderProtocol: () => "anthropic",
    complete: async (nextRequest: CanonicalModelRequest) => {
      request = nextRequest;
      return {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "<tier>medium</tier>" }],
        finishReason: "stop" as const,
      };
    },
  } as unknown as ModelRuntime;

  const result = await classifyAndRoute({
    config: config(),
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    judgeRuntime,
  });

  assert.equal(result?.tier, "medium");
  assert.ok(request && !("temperature" in request));
});

test("omits temperature for an OpenAI-compatible judge", async () => {
  let request: CanonicalModelRequest | undefined;
  const judgeRuntime = {
    getProviderProtocol: () => "openai",
    complete: async (nextRequest: CanonicalModelRequest) => {
      request = nextRequest;
      return {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "<tier>medium</tier>" }],
        finishReason: "stop" as const,
      };
    },
  } as unknown as ModelRuntime;

  await classifyAndRoute({
    config: config(),
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    judgeRuntime,
  });

  assert.ok(request && !("temperature" in request));
});

test("aborts the judge request when its classification timeout expires", async () => {
  let aborted = false;
  const judgeRuntime = {
    complete: async (_request: unknown, options?: { signal?: AbortSignal }) =>
      new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(options.signal?.reason);
        }, { once: true });
      }),
  } as unknown as ModelRuntime;

  const result = await classifyAndRoute({
    config: { ...config(), judgeTimeoutMs: 500 },
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    judgeRuntime,
  });

  assert.equal(aborted, true);
  assert.deepEqual(result?.failure, {
    reason: "timeout",
    attempts: 1,
    code: "judge_timeout",
  });
});

function config() {
  return {
    enabled: true,
    judge: { id: "judge-provider/judge-model", provider: "judge-provider", model: "judge-model" },
    defaultTier: "medium",
    judgeTimeoutMs: 5_000,
    tiers: {
      medium: { model: { id: "main/main-model", provider: "main", model: "main-model" } },
    },
  };
}
