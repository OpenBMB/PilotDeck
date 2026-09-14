import assert from "node:assert/strict";
import test from "node:test";

import { countTokens } from "../../src/context/budget/tokenizer.js";

test("token counting preserves empty and ordinary text behavior", () => {
  assert.equal(countTokens(""), 0);
  assert.equal(countTokens("hello"), 1);
});

for (const marker of ["<|endoftext|>", "<|endofprompt|>"]) {
  test(`token counting treats ${marker} as ordinary text`, () => {
    // A literal spelling must use multiple text tokens, not one control token.
    assert.ok(countTokens(marker) > 1);
    const sample = `模型配置：{"eos_token":"${marker}"}\nExplain this marker.`;
    assert.ok(countTokens(sample) > countTokens(marker));
  });
}
