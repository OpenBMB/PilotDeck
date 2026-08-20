import assert from "node:assert/strict";
import test from "node:test";

import type { RouterTokenSaverConfig } from "../../src/router/config/schema.js";
import { classifyAndRoute } from "../../src/router/tokenSaver/classifyAndRoute.js";
import { externalModel } from "./helpers.js";

const benchmark = [
  ["What does this function do?", "SIMPLE"],
  ["Rename the variable foo to bar", "SIMPLE"],
  ["Write a hello world program", "SIMPLE"],
  ["Add a null check to this function", "SIMPLE"],
  ["ok", "SIMPLE"],
  ["Refactor the authentication module from sessions to JWT across the codebase", "COMPLEX"],
  ["Design and implement CI/CD for test, staging, and production", "COMPLEX"],
  ["Analyze the full architecture and recommend improvements with diagrams", "COMPLEX"],
  ["Profile the application, find bottlenecks, and implement optimizations", "COMPLEX"],
  ["Merge five CSV files, compute statistics, charts, and a PDF report", "COMPLEX"],
] as const;

test("real router judge classifies the benchmark with at least 80 percent accuracy", { timeout: 240_000 }, async () => {
  const { provider, model, runtime } = externalModel();
  const ref = { id: `${provider}/${model}`, provider, model };
  const config: RouterTokenSaverConfig = {
    enabled: true,
    judge: ref,
    defaultTier: "SIMPLE",
    tiers: {
      SIMPLE: { model: ref, description: "Quick questions, one small edit, or short code generation" },
      COMPLEX: { model: ref, description: "Multi-step system work, broad refactors, debugging, or data pipelines" },
    },
    rules: [
      "Use COMPLEX for multi-file, multi-step, architecture, profiling, or pipeline work",
      "Use SIMPLE for one small edit, quick answer, or short standalone generation",
    ],
    judgeTimeoutMs: 30_000,
  };
  const results = [];
  for (const [instruction, expected] of benchmark) {
    const decision = await classifyAndRoute({
      config,
      messages: [{ role: "user", content: [{ type: "text", text: instruction }] }],
      judgeRuntime: runtime,
    });
    results.push({ instruction, expected, actual: decision?.tier ?? "UNKNOWN" });
  }
  const correct = results.filter(item => item.actual === item.expected).length;
  console.log(JSON.stringify({ correct, total: results.length, results }, null, 2));
  assert.ok(correct >= 8, `Expected at least 8/10 correct, got ${correct}/10.`);
});
