import assert from "node:assert/strict";
import test from "node:test";
import { normalizeModelError } from "../../../src/model/errors/normalizeModelError.js";

function codeFor(message: string): string {
  return normalizeModelError("test", "openai", new Error(message)).code;
}

test("normalizeModelError extracts SSE error details from HTTP error bodies", () => {
  const message = "Invalid value: 'input_text'. Supported values are: 'output_text' and 'refusal'.";
  const raw = `event: error\r\ndata: ${JSON.stringify({ error: {
    type: "invalid_request_error", code: "invalid_request", message,
  } })}\r\n\r\n`;
  const error = normalizeModelError("test", "openai-responses", raw, 400);

  assert.equal(error.message, message);
  assert.equal(error.code, "invalid_request");
  assert.equal(error.retryable, false);
  assert.equal(error.raw, raw);
});

test("normalizeModelError ignores malformed SSE data before an error event", () => {
  const raw = 'data: not-json\n\ndata: {"error":{"code":"invalid_api_key","message":"Incorrect API key provided"}}\n\n';
  const error = normalizeModelError("test", "openai-responses", raw, 401);
  assert.equal(error.code, "auth_error");
  assert.equal(error.message, "Incorrect API key provided");
});

test("normalizeModelError classifies common network failures", () => {
  assert.equal(codeFor("getaddrinfo ENOTFOUND api.test"), "dns_error");
  assert.equal(codeFor("read ECONNRESET"), "connection_reset");
  assert.equal(codeFor("connect ECONNREFUSED 127.0.0.1:443"), "connection_refused");
  assert.equal(codeFor("certificate has expired"), "tls_error");
  assert.equal(codeFor("proxy CONNECT failed"), "proxy_error");
});

test("normalizeModelError marks unsupported image model errors as image-strip recoverable", () => {
  for (const message of [
    "g9v3-39a5b is not a multimodal model",
    "This model does not support image input",
    "Vision input is not supported",
  ]) {
    const error = normalizeModelError("test", "openai", new Error(message), 400);
    assert.equal(error.recoverableViaImageStrip, true, message);
  }
});

test("normalizeModelError maps invalid API key messages to auth_error", () => {
  for (const message of [
    "invalid_api_key: the supplied key is invalid",
    "Incorrect API key provided",
  ]) {
    const error = normalizeModelError("test", "openai", new Error(message));
    assert.equal(error.code, "auth_error", message);
    assert.equal(error.retryable, false, message);
  }
});

test("normalizeModelError maps exhausted quota messages to billing", () => {
  for (const message of ["quota exhausted for this account", "quota_exhausted: monthly limit reached"]) {
    const error = normalizeModelError("test", "openai", new Error(message));

    assert.equal(error.code, "billing", message);
    assert.equal(error.retryable, false, message);
  }
});

test("rate-limit signals take precedence over exhausted quota", () => {
  for (const [message, status] of [
    ["rate limit: quota exhausted", 429],
    ["quota exhausted, retry later", undefined],
  ] as const) {
    const error = normalizeModelError("test", "openai", new Error(message), status);

    assert.equal(error.code, "rate_limit_error", message);
    assert.equal(error.retryable, true, message);
  }
});

test("specific request errors remain ahead of generic retry wording", () => {
  const error = normalizeModelError(
    "test",
    "openai",
    new Error("prompt is too long; retry after reducing the request"),
  );

  assert.equal(error.code, "prompt_too_long");
});
