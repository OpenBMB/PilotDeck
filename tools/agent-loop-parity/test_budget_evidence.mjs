import assert from "node:assert/strict";
import test from "node:test";

import { TokenBudgetManager } from "../../dist/src/context/budget/TokenBudgetManager.js";
import { createRequestBudgetEvidence } from "./adapters/budget_evidence.mjs";

const tokenBudget = new TokenBudgetManager();
const request = {
  provider: "parity",
  model: "deterministic",
  systemPrompt: "system",
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  tools: [{ name: "sdk_extension", description: "extension", inputSchema: { type: "object" } }],
};

test("budget evidence is independently derived from the provider-visible request", () => {
  const expected = createRequestBudgetEvidence({ request, tokenBudget });
  const evidence = createRequestBudgetEvidence({
    request,
    tokenBudget,
    observedBudget: {
      used: expected.used,
      displayUsed: expected.used,
      budgetUsed: expected.used,
      breakdown: expected.breakdown,
    },
  });

  assert.equal(evidence.breakdown.source, "local_estimate");
  assert.equal(evidence.breakdown.total, evidence.used);
  assert.deepEqual(evidence.observedFields, ["used", "displayUsed", "budgetUsed"]);
  assert.equal(evidence.displayUsed, evidence.used);
  assert.equal(evidence.budgetUsed, evidence.used);
});

test("a budget error injected before evidence generation remains observable", () => {
  const cleanEvidence = createRequestBudgetEvidence({ request, tokenBudget });
  const corruptedBudget = {
    used: cleanEvidence.used + 30,
    displayUsed: cleanEvidence.displayUsed + 30,
    budgetUsed: cleanEvidence.budgetUsed + 30,
    breakdown: { ...cleanEvidence.breakdown, total: cleanEvidence.breakdown.total + 30 },
  };
  const evidence = createRequestBudgetEvidence({ request, tokenBudget, observedBudget: corruptedBudget });

  assert.equal(evidence, undefined);
});
