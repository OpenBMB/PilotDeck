import test from "node:test";
import assert from "node:assert/strict";

import { TokenBudgetManager } from "../../src/context/budget/TokenBudgetManager.js";

test("budget snapshot uses the raw resolved token count for its ratio", () => {
  const manager = new TokenBudgetManager({ warningRatio: 0.8, blockingRatio: 0.95 });

  const snapshot = manager.snapshotFromTokens(140, 160);

  assert.equal(snapshot.tokens, 140);
  assert.equal(snapshot.totalContextTokens, 160);
  assert.equal(snapshot.effectiveContextTokens, 160);
  assert.equal(snapshot.ratio, 0.875);
  assert.equal(snapshot.state, "warning");
});

test("budget snapshot keeps raw context window separate from explicit output reserve", () => {
  const manager = new TokenBudgetManager();

  const snapshot = manager.snapshotFromTokens(100, 160, { reservedOutputTokens: 40 });

  assert.equal(snapshot.totalContextTokens, 160);
  assert.equal(snapshot.effectiveContextTokens, 120);
  assert.equal(snapshot.maxContextTokens, 120);
  assert.equal(snapshot.reservedOutputTokens, 40);
});

test("thinking budget counts native reasoning content when replayed", () => {
  const manager = new TokenBudgetManager();

  const legacy = manager.estimateBlockTokens({ type: "thinking", text: "short thought" });
  const replayed = manager.estimateBlockTokens({
    type: "thinking",
    text: "short thought",
    reasoningContent: "native reasoning ".repeat(200),
  });

  assert.ok(replayed > legacy);
});
