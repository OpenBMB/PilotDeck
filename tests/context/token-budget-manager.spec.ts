import test from "node:test";
import assert from "node:assert/strict";

import { TokenBudgetManager } from "../../src/context/budget/TokenBudgetManager.js";

test("budget snapshot uses conservative budget tokens for ratio while preserving real tokens", () => {
  const manager = new TokenBudgetManager({ warningRatio: 0.8, blockingRatio: 0.95 });

  const snapshot = manager.snapshotFromTokens(100, 160, { budgetTokens: 140 });

  assert.equal(snapshot.tokens, 100);
  assert.equal(snapshot.budgetTokens, 140);
  assert.equal(snapshot.ratio, 0.875);
  assert.equal(snapshot.state, "warning");
});
