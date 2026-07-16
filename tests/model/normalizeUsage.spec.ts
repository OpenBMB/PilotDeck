import test from "node:test";
import assert from "node:assert/strict";

import { normalizeOpenAIUsage } from "../../src/model/response/normalizeUsage.js";
import { normalizeGoogleUsage } from "../../src/model/providers/google/response.js";

test("OpenAI Responses usage reads cached tokens from input token details", () => {
  const usage = normalizeOpenAIUsage({
    input_tokens: 100,
    input_tokens_details: { cached_tokens: 40 },
    output_tokens: 7,
    total_tokens: 107,
  });

  assert.equal(usage?.inputTokens, 60);
  assert.equal(usage?.outputTokens, 7);
  assert.equal(usage?.cacheReadTokens, 40);
  assert.equal(usage?.totalTokens, 107);
});

test("Gemini usage counts thoughts tokens as output consumption", () => {
  const usage = normalizeGoogleUsage({
    promptTokenCount: 9,
    candidatesTokenCount: 0,
    thoughtsTokenCount: 13,
    totalTokenCount: 22,
  });

  assert.equal(usage?.inputTokens, 9);
  assert.equal(usage?.outputTokens, 13);
  assert.equal(usage?.totalTokens, 22);
});
