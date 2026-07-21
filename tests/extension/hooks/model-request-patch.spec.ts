import test from "node:test";
import assert from "node:assert/strict";
import { parseHookOutput } from "../../../src/extension/hooks/execution/parseHookOutput.js";

test("parses only the supported model request patch fields", () => {
  const output = parseHookOutput(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreModelRequest",
      modelRequestPatch: {
        provider: "provider",
        model: "model",
        maxOutputTokens: 4096,
        temperature: 0.2,
        metadata: { domain: "legal" },
        messages: [{ role: "user", content: "forbidden" }],
        tools: [],
      },
    },
  }));
  assert.equal(output.type, "sync");
  if (output.type !== "sync") return;
  assert.deepEqual(output.specific?.modelRequestPatch, {
    provider: "provider",
    model: "model",
    maxOutputTokens: 4096,
    temperature: 0.2,
    metadata: { domain: "legal" },
  });
});

test("parses bounded dynamic context controls for hook-driven injection", () => {
  const output = parseHookOutput(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      dynamicContext: [
        { id: "goal", content: "Goal checkpoint 3/7", priority: "critical", ttlMs: 2_000 },
        { id: "invalid", content: "ignored priority", priority: "urgent", ttlMs: 999_999_999 },
        { id: "blank", content: "   " },
      ],
    },
  }));

  assert.equal(output.type, "sync");
  if (output.type !== "sync") return;
  assert.deepEqual(output.specific?.dynamicContext, [
    { id: "goal", content: "Goal checkpoint 3/7", priority: "critical", ttlMs: 2_000 },
    { id: "invalid", content: "ignored priority", priority: undefined, ttlMs: 86_400_000 },
  ]);
});
