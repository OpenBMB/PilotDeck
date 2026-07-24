import test from "node:test";
import assert from "node:assert/strict";

import { formatModelRequestFailureMessage, modelFailureAction } from "../../src/agent/loop/AgentLoop.js";
import { normalizeModelError } from "../../src/model/errors/normalizeModelError.js";
import type { CanonicalModelError } from "../../src/model/protocol/errors.js";

test("model request failure preserves provider raw message before action guidance", () => {
  const providerMessage = "No such model: typo-model";
  const error = normalizeModelError(
    "modelbest-openai",
    "openai",
    { error: { message: providerMessage, code: "model_not_found" } },
    404,
  );

  const formatted = formatModelRequestFailureMessage(providerMessage, error);

  assert.ok(formatted.startsWith(providerMessage), formatted);
  assert.match(formatted, /Action:/);
  assert.match(formatted, /Settings → Model Provider/);
  assert.match(formatted, /pilotdeck\.yaml/);
});

test("model_not_found guidance points users to local model settings", () => {
  const error = normalizeModelError(
    "modelbest-openai",
    "openai",
    { error: { message: "The model `does-not-exist` does not exist" } },
    404,
  );

  assert.equal(error.code, "model_not_found");
  assert.match(error.userHint ?? "", /Select a valid model/);
  assert.match(error.userHint ?? "", /Settings → Model Provider/);
  assert.equal(error.settingsFix?.configPath, "model.default");

  const action = modelFailureAction(error);
  assert.equal(action.fixTarget, "settings");
  assert.match(action.userHint, /valid/);
  assert.match(action.userHint, /pilotdeck\.yaml/);
  assert.equal(action.userHintI18n.key, "chat:agentStatus.modelRequestFailed.actions.modelNotFound");
  assert.equal(action.userHintI18n.params?.provider, "modelbest-openai");
});

test("stream idle timeout is classified as timeout with network and timeoutMs guidance", () => {
  const error = normalizeModelError(
    "modelbest-openai",
    "openai",
    new Error("Stream idle timeout: no data received for 30000ms"),
  );

  assert.equal(error.code, "timeout");
  assert.match(error.userHint ?? "", /timeoutMs/);
  assert.match(error.userHint ?? "", /network|proxy|provider status/i);

  const action = modelFailureAction(error);
  assert.equal(action.fixTarget, "network");
  assert.match(action.userHint, /timeoutMs/);
  assert.match(action.userHint, /network|proxy|provider status/i);
});

test("provider terminated stream is classified as a retryable connection reset", () => {
  const error = normalizeModelError("llmcenter", "anthropic", new Error("terminated"));

  assert.equal(error.code, "connection_reset");
  assert.equal(error.retryable, true);
});

test("billing and rate limit guidance distinguish provider-side fixes", () => {
  const billing = normalizeModelError(
    "modelbest-openai",
    "openai",
    { error: { message: "insufficient balance, please top up your account" } },
    402,
  );
  const rateLimit = normalizeModelError(
    "modelbest-openai",
    "openai",
    { error: { message: "rate limit exceeded, retry later" } },
    429,
  );

  assert.equal(billing.code, "billing");
  assert.equal(modelFailureAction(billing).fixTarget, "provider");
  assert.match(modelFailureAction(billing).userHint, /Top up billing\/quota/);

  assert.equal(rateLimit.code, "rate_limit_error");
  assert.equal(modelFailureAction(rateLimit).fixTarget, "provider");
  assert.match(modelFailureAction(rateLimit).userHint, /rate limit/);
  assert.match(modelFailureAction(rateLimit).userHint, /reduce concurrency|switch/);
});

test("unknown provider errors still give actionable settings and provider checks", () => {
  const action = modelFailureAction({
    provider: "custom",
    protocol: "openai",
    code: "weird_provider_code",
    message: "provider said something unexpected",
    retryable: false,
    raw: {},
  } satisfies CanonicalModelError);

  assert.equal(action.fixTarget, "settings");
  assert.match(action.userHint, /base URL\/API key\/model/);
  assert.match(action.userHint, /timeoutMs/);
  assert.match(action.userHint, /provider API status\/logs/);
});
