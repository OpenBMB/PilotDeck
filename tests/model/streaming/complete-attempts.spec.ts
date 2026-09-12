import assert from "node:assert/strict";
import test from "node:test";

import { parseModelConfig } from "../../../src/model/config/parseModelConfig.js";
import { complete, type ProviderAttemptEvent } from "../../../src/model/streaming/streamModel.js";

test("complete emits one accounting event for each physical provider attempt", async () => {
  const config = parseModelConfig({ providers: { test: {
    protocol: "openai", url: "https://example.test/v1", apiKey: "test",
    retry: { requestMaxRetries: 1, baseDelayMs: 1 }, models: { model: {} },
  } } });
  let fetchCalls = 0;
  const attempts: ProviderAttemptEvent[] = [];
  const response = await complete({
    provider: "test", model: "model",
    messages: [{ role: "user", content: [{ type: "text", text: "public fixture" }] }],
  }, config, {
    fetch: async () => {
      fetchCalls += 1;
      if (fetchCalls === 1) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
    onProviderAttempt: (attempt) => attempts.push(attempt),
  });

  assert.equal(response.finishReason, "stop");
  assert.equal(fetchCalls, 2);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.status, "failed");
  assert.equal(attempts[0]?.attempt, 1);
  assert.equal(attempts[1]?.status, "succeeded");
  assert.equal(attempts[1]?.attempt, 2);
  assert.equal(attempts[1]?.usage?.inputTokens, 12);
  assert.equal(attempts[1]?.usage?.outputTokens, 3);
  assert.equal(attempts[1]?.usage?.totalTokens, 15);
  assert.equal("messages" in attempts[1]!, false);
});
