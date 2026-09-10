import assert from "node:assert/strict";
import test from "node:test";

import { parseTier } from "../../src/router/tokenSaver/parseTier.js";

test("prefers an exact tier over a word-prefix of a hyphenated tier", () => {
  assert.equal(parseTier("a-a", ["a", "a-a"]), "a-a");
  assert.equal(parseTier("fast-pro", ["fast", "fast-pro"]), "fast-pro");
});

test("keeps exact matching case-insensitive", () => {
  assert.equal(parseTier("Fast-Pro", ["fast", "fast-pro"]), "fast-pro");
});

test("tagged output still resolves the longer tier", () => {
  assert.equal(parseTier("<tier>a-a</tier>", ["a", "a-a"]), "a-a");
});

test("fallback text matching picks the longest tier mentioned", () => {
  assert.equal(parseTier("please use a-a", ["a", "a-a"]), "a-a");
});

test("fallback text matching still resolves a plain tier mention", () => {
  assert.equal(parseTier("the answer is fast", ["fast", "fast-pro"]), "fast");
});

test("returns undefined when no tier matches", () => {
  assert.equal(parseTier("no such tier", ["fast", "fast-pro"]), undefined);
});
