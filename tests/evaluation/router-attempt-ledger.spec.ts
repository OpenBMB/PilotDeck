import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import type {
  CanonicalModelRequest,
  ModelRuntime,
  ModelRuntimeOptions,
} from "../../src/model/index.js";
import { createRouterRuntime } from "../../src/router/RouterRuntime.js";
import type { RouterConfig } from "../../src/router/config/schema.js";

const capabilities = {
  supportsToolUse: true,
  supportsStreaming: true,
  supportsParallelToolCalls: false,
  supportsThinking: false,
  supportsJsonSchema: false,
  supportsSystemPrompt: true,
  supportsPromptCache: false,
  maxContextTokens: 8_192,
  maxOutputTokens: 1_024,
};

test("ledger records judge, every provider retry, and successful fallback exactly once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotroute-full-chain-"));
  const ledgerFilePath = path.join(dir, "run", "calls.jsonl");
  const timestamp = (second: number) => `2026-01-01T00:00:0${second}.000Z`;

  const judgeRuntime = {
    async complete(_request: CanonicalModelRequest, options?: ModelRuntimeOptions) {
      options?.onProviderAttempt?.({
        provider: "judge", model: "classifier", attempt: 1,
        startedAt: timestamp(0), endedAt: timestamp(1), status: "succeeded",
        usage: { inputTokens: 10, outputTokens: 1, nativeCost: 0.001 },
      });
      return {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "<tier>simple</tier>" }],
        finishReason: "stop" as const,
      };
    },
  } as unknown as ModelRuntime;

  const modelRuntime: ModelRuntime = {
    async *stream(request: CanonicalModelRequest, options?: ModelRuntimeOptions) {
      if (request.provider === "primary") {
        options?.onProviderAttempt?.({
          provider: "primary", model: "model-a", attempt: 1,
          startedAt: timestamp(1), endedAt: timestamp(2), status: "failed",
          usage: { inputTokens: 100, nativeCost: 0.01 }, errorType: "server_error",
        });
        options?.onProviderAttempt?.({
          provider: "primary", model: "model-a", attempt: 2,
          startedAt: timestamp(2), endedAt: timestamp(3), status: "failed",
          usage: { inputTokens: 100, nativeCost: 0.01 }, errorType: "server_error",
        });
        yield {
          type: "error" as const,
          error: {
            provider: "primary", protocol: "openai" as const, code: "server_error" as const,
            message: "primary unavailable", retryable: true,
          },
        };
        return;
      }

      options?.onProviderAttempt?.({
        provider: "fallback", model: "model-b", attempt: 1,
        startedAt: timestamp(3), endedAt: timestamp(4), status: "succeeded",
        usage: { inputTokens: 100, outputTokens: 20, nativeCost: 0.005 },
      });
      yield { type: "text_delta" as const, text: "recovered" };
      yield {
        type: "usage" as const,
        usage: { inputTokens: 100, outputTokens: 20, nativeCost: 0.005 },
      };
    },
    async complete() {
      throw new Error("main runtime complete is not used");
    },
    getCapabilities() { return capabilities; },
    getMultimodal() { return { input: ["text"] }; },
    getProviderProtocol() { return "openai"; },
    getProviderBaseUrl(provider: string) { return `https://${provider}.invalid`; },
  };

  const config: RouterConfig = {
    enabled: true,
    scenarios: { default: { id: "primary/model-a", provider: "primary", model: "model-a" } },
    tokenSaver: {
      enabled: true,
      judge: { id: "judge/classifier", provider: "judge", model: "classifier" },
      defaultTier: "simple",
      judgeTimeoutMs: 5_000,
      tiers: { simple: { model: { id: "primary/model-a", provider: "primary", model: "model-a" } } },
    },
    fallback: {
      default: [{ id: "fallback/model-b", provider: "fallback", model: "model-b" }],
    },
    zeroUsageRetry: { enabled: false, maxAttempts: 1 },
    transientRetry: { enabled: false, maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0 },
    stats: {
      enabled: false, ledgerFilePath, runId: "run-four-attempts", taskId: "task-four-attempts",
      strategyVersion: "pilotroute", baselineCommit: "cfc4d177",
    },
  };

  const router = createRouterRuntime(config, { modelRuntime, judgeRuntime });
  const request: CanonicalModelRequest = {
    provider: "original", model: "original",
    messages: [{ role: "user", content: [{ type: "text", text: "do the task" }] }],
  };
  try {
    const decision = await router.decide({ request, sessionId: "session-1", isMainAgent: true });
    for await (const _event of router.execute(decision, request, {
      sessionId: "session-1", turnId: "turn-1",
    })) {
      // Consume the stream so all attempts reach the ledger.
    }
  } finally {
    await router.shutdown();
  }

  const rows = fs.readFileSync(ledgerFilePath, "utf8")
    .trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((row) => [row.role, row.provider, row.status]), [
    ["judge", "judge", "succeeded"],
    ["main", "primary", "failed"],
    ["retry", "primary", "failed"],
    ["fallback", "fallback", "succeeded"],
  ]);
  assert.equal(rows.reduce((total, row) => total + row.cost, 0), 0.026);
  assert.equal(rows[2].retryOfAttemptId, rows[1].attemptId);
  assert.equal(rows[3].fallbackFromAttemptId, rows[2].attemptId);
  assert.equal(new Set(rows.map((row) => row.attemptId)).size, 4);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("router-disabled baseline still records provider attempts without changing routing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pilotroute-baseline-ledger-"));
  const ledgerFilePath = path.join(dir, "calls.jsonl");
  const runtime: ModelRuntime = {
    async *stream(request: CanonicalModelRequest, options?: ModelRuntimeOptions) {
      options?.onProviderAttempt?.({
        provider: request.provider, model: request.model, attempt: 1,
        startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:01.000Z",
        status: "failed", errorType: "network_error",
      });
      options?.onProviderAttempt?.({
        provider: request.provider, model: request.model, attempt: 2,
        startedAt: "2026-01-01T00:00:01.000Z", endedAt: "2026-01-01T00:00:02.000Z",
        status: "succeeded", usage: { inputTokens: 20, outputTokens: 2, nativeCost: 0.004 },
      });
      yield { type: "text_delta", text: "baseline response" };
      yield { type: "usage", usage: { inputTokens: 20, outputTokens: 2, nativeCost: 0.004 } };
    },
    async complete() { throw new Error("not used"); },
    getCapabilities() { return capabilities; },
    getMultimodal() { return { input: ["text"] }; },
    getProviderProtocol() { return "openai"; },
    getProviderBaseUrl(provider: string) { return `https://${provider}.invalid`; },
  };
  const router = createRouterRuntime({
    enabled: false,
    scenarios: { default: { id: "fixed/model", provider: "fixed", model: "model" } },
    stats: {
      enabled: false, ledgerFilePath, runId: "baseline-run", taskId: "baseline-task",
      strategyVersion: "pilotdeck-fixed-baseline", baselineCommit: "cfc4d177",
    },
  }, { modelRuntime: runtime });
  const request: CanonicalModelRequest = {
    provider: "fixed", model: "model",
    messages: [{ role: "user", content: [{ type: "text", text: "baseline task" }] }],
  };
  try {
    for await (const _event of router.stream(request, {
      sessionId: "baseline-session", turnId: "baseline-turn", isMainAgent: true,
    })) {
      // Consume baseline response.
    }
  } finally {
    await router.shutdown();
  }

  const rows = fs.readFileSync(ledgerFilePath, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => [row.role, row.status, row.costSource]), [
    ["main", "failed", "unknown"],
    ["retry", "succeeded", "provider_reported"],
  ]);
  assert.equal(rows[1].retryOfAttemptId, rows[0].attemptId);
  fs.rmSync(dir, { recursive: true, force: true });
});
