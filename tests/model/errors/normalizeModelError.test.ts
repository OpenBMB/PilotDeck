import test from "node:test";
import assert from "node:assert/strict";
import { normalizeModelError } from "../../../src/model/errors/normalizeModelError.js";

test("prompt_too_long (openai) → recoverableViaCompact", () => {
  const result = normalizeModelError("openai", "openai", {
    message: "input length and max_tokens exceed context limit. The input is 8000 tokens.",
  });
  assert.equal(result.code, "prompt_too_long");
  assert.equal(result.recoverableViaCompact, true);
});

test("prompt_too_long (anthropic) with pattern match", () => {
  const result = normalizeModelError("anthropic", "anthropic", {
    error: { message: "prompt is too long: your request exceeds the maximum token limit" },
  });
  assert.equal(result.code, "prompt_too_long");
  assert.equal(result.recoverableViaCompact, true);
});

test("401 → auth_error, not retryable", () => {
  const result = normalizeModelError("openai", "openai", null, 401);
  assert.equal(result.code, "auth_error");
  assert.equal(result.retryable, false);
});

test("401 with error message body", () => {
  const result = normalizeModelError("openai", "openai", {
    error: { message: "invalid API key" },
  }, 401);
  assert.equal(result.code, "auth_error");
  assert.equal(result.retryable, false);
  assert.ok(result.message.includes("invalid API key"));
});

test("429 → rate_limit_error, retryable", () => {
  const result = normalizeModelError("openai", "openai", null, 429);
  assert.equal(result.code, "rate_limit_error");
  assert.equal(result.retryable, true);
});

test("429 with rate limit message", () => {
  const result = normalizeModelError("openai", "openai", {
    error: { message: "rate limit exceeded" },
  }, 429);
  assert.equal(result.code, "rate_limit_error");
  assert.equal(result.retryable, true);
});

test("500 → server_error, retryable", () => {
  const result = normalizeModelError("openai", "openai", null, 500);
  assert.equal(result.code, "server_error");
  assert.equal(result.retryable, true);
});

test("408 timeout → retryable via status", () => {
  const result = normalizeModelError("openai", "openai", null, 408);
  assert.equal(result.retryable, true);
});

test("409 conflict → retryable via status", () => {
  const result = normalizeModelError("openai", "openai", null, 409);
  assert.equal(result.retryable, true);
});

test("recoverableViaImageStrip for multimodal errors", () => {
  const result = normalizeModelError("openai", "openai", {
    message: "processor failed to apply to the image data",
  });
  assert.equal(result.recoverableViaImageStrip, true);
});

test("returns provider_error for unknown error with no status", () => {
  const result = normalizeModelError("openai", "openai", {
    message: "something unexpected happened",
  });
  assert.equal(result.code, "provider_error");
  assert.equal(result.retryable, false);
});

test("request_too_large from message pattern", () => {
  const result = normalizeModelError("openai", "openai", {
    message: "request too large: the request body exceeds the maximum allowed size",
  });
  assert.equal(result.code, "request_too_large");
});

test("max_output_reached from message pattern", () => {
  const result = normalizeModelError("openai", "openai", {
    message: "maximum output tokens exceeded",
  });
  assert.equal(result.code, "max_output_reached");
});

test("unexpected Error instance is handled gracefully", () => {
  const result = normalizeModelError("openai", "openai", new Error("connection refused"), 503);
  assert.equal(result.retryable, true);
  assert.ok(result.message.includes("connection refused"));
});
