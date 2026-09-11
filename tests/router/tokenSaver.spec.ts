import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalModelRequest, ModelRuntime } from "../../src/model/index.js";
import { ModelProviderError } from "../../src/model/index.js";
import { classifyAndRoute } from "../../src/router/index.js";
import { DefaultContextRuntime } from "../../src/context/DefaultContextRuntime.js";

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
  assert.equal(request?.temperature, undefined);
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

  assert.equal(request?.temperature, undefined);
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
