import assert from "node:assert/strict";
import test from "node:test";
import { parseOpenAIResponsesResponse } from "../../../src/model/providers/openai-responses/response.js";
import {
  createOpenAIResponsesStreamState,
  normalizeOpenAIResponsesStreamEvent,
} from "../../../src/model/providers/openai-responses/stream.js";
import {
  classifyOpenAIResponsesTerminal,
  responsesTerminalError,
} from "../../../src/model/providers/openai-responses/terminal.js";

test("classifies completed and token-limited Responses terminal states", () => {
  assert.deepEqual(classifyOpenAIResponsesTerminal({ status: "completed" }), { finishReason: "stop" });
  assert.deepEqual(
    classifyOpenAIResponsesTerminal({ status: "completed" }, { sawToolCall: true }),
    { finishReason: "tool_call" },
  );
  for (const reason of ["max_output_tokens", "max_tokens", "token_limit", "length"]) {
    assert.deepEqual(
      classifyOpenAIResponsesTerminal({ status: "incomplete", incomplete_details: { reason } }),
      { finishReason: "length" },
    );
  }
});

test("classifies safety and content-filter incomplete reasons", () => {
  for (const reason of ["content_filter", "safety", "policy_violation", "moderation_blocked"]) {
    assert.deepEqual(
      classifyOpenAIResponsesTerminal({ status: "incomplete", incomplete_details: { reason } }),
      { finishReason: "content_filter" },
    );
  }
});

test("classifies cancelled and failed states as errors", () => {
  for (const status of ["cancelled", "failed"]) {
    const terminal = classifyOpenAIResponsesTerminal({
      status,
      error: { code: "provider_failure", message: "terminal failure", status: 400 },
    });
    assert.equal(terminal.finishReason, "error");
    assert.equal(terminal.error?.code, "provider_failure");
  }
});

test("recognizes transient Codex and OpenAI terminal codes as retryable", () => {
  for (const code of ["server_is_overloaded", "slow_down", "rate_limit_exceeded"]) {
    const error = responsesTerminalError({
      type: "response.failed",
      response: { error: { code, message: `provider ${code}`, status: 429 } },
    });
    assert.equal(error.retryable, true, code);
  }
});

test("quota, auth, and invalid request codes remain terminal", () => {
  for (const code of ["insufficient_quota", "authentication_error", "invalid_api_key", "invalid_request_error"]) {
    const error = responsesTerminalError({ error: { code, message: `provider ${code}`, status: 500 } });
    assert.equal(error.retryable, false, code);
  }
});

test("stream terminals preserve retryability, usage, finish reason, and a single message end", () => {
  const state = createOpenAIResponsesStreamState();
  const incomplete = normalizeOpenAIResponsesStreamEvent({
    type: "response.incomplete",
    response: {
      status: "incomplete",
      incomplete_details: { reason: "content_filter" },
      usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 },
    },
  }, state);
  assert.equal(incomplete.find((event) => event.type === "usage")?.type, "usage");
  assert.equal(incomplete.find((event) => event.type === "message_end")?.finishReason, "content_filter");

  const duplicate = normalizeOpenAIResponsesStreamEvent({
    type: "response.completed",
    response: { status: "completed" },
  }, state);
  assert.equal(duplicate.filter((event) => event.type === "message_end").length, 0);

  const failed = normalizeOpenAIResponsesStreamEvent({
    type: "response.failed",
    response: {
      status: "failed",
      error: { code: "server_is_overloaded", message: "busy" },
      usage: { input_tokens: 3, output_tokens: 1 },
    },
  });
  const error = failed.find((event) => event.type === "error");
  assert.equal(error?.type === "error" && error.error.retryable, true);
  assert.equal(failed.some((event) => event.type === "usage"), true);
});

test("stream refusal deltas and non-stream refusal parts become text", () => {
  const events = normalizeOpenAIResponsesStreamEvent({
    type: "response.output_refusal.delta",
    delta: "I cannot help with that.",
  });
  assert.equal(events.find((event) => event.type === "text_delta")?.text, "I cannot help with that.");

  const parsed = parseOpenAIResponsesResponse({
    status: "incomplete",
    incomplete_details: { reason: "safety" },
    output: [{
      type: "message",
      content: [{ type: "output_refusal", refusal: "I cannot comply." }],
    }],
  });
  assert.deepEqual(parsed.content, [{ type: "text", text: "I cannot comply." }]);
  assert.equal(parsed.finishReason, "content_filter");
});

test("completed non-stream tool calls retain finish precedence", () => {
  const parsed = parseOpenAIResponsesResponse({
    id: "resp_1",
    status: "completed",
    output: [{ type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" }],
  });
  assert.equal(parsed.finishReason, "tool_call");
});

test("preserves provider code, message, and HTTP status", () => {
  const raw = {
    type: "response.failed",
    response: {
      status: "failed",
      error: {
        code: "server_is_overloaded",
        message: "The service is busy; retry shortly.",
        status: 503,
      },
    },
  };
  const terminal = classifyOpenAIResponsesTerminal(raw, { provider: "codex" });
  assert.equal(terminal.finishReason, "error");
  assert.deepEqual(
    {
      provider: terminal.error?.provider,
      protocol: terminal.error?.protocol,
      code: terminal.error?.code,
      message: terminal.error?.message,
      status: terminal.error?.status,
      retryable: terminal.error?.retryable,
      raw: terminal.error?.raw,
    },
    {
      provider: "codex",
      protocol: "openai-responses",
      code: "server_is_overloaded",
      message: "The service is busy; retry shortly.",
      status: 503,
      retryable: true,
      raw,
    },
  );
});
