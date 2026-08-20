import assert from "node:assert/strict";
import test from "node:test";

import { externalModel, responseText } from "./helpers.js";

test("real provider completes a normalized model request", { timeout: 120_000 }, async () => {
  const { provider, model, runtime } = externalModel();
  const response = await runtime.complete({
    provider,
    model,
    messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly: PilotDeck external OK" }] }],
    maxOutputTokens: 1024,
    temperature: 0,
    metadata: { test: "external-model-complete" },
  });

  assert.equal(response.role, "assistant");
  assert.match(responseText(response), /PilotDeck external OK/i);
  assert.ok(response.finishReason);
});

test("real provider stream preserves protocol order and reaches a terminal event", { timeout: 120_000 }, async () => {
  const { provider, model, runtime } = externalModel();
  const types: string[] = [];
  let text = "";
  for await (const event of runtime.stream({
    provider,
    model,
    messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly: stream-ok" }] }],
    maxOutputTokens: 1024,
    temperature: 0,
    stream: true,
    metadata: { test: "external-model-stream" },
  })) {
    types.push(event.type);
    if (event.type === "text_delta") text += event.text;
    if (event.type === "error") throw new Error(event.error.message);
  }

  assert.match(text, /stream-ok/i);
  assert.ok(types.includes("message_start"), JSON.stringify(types));
  assert.ok(types.includes("message_end"), JSON.stringify(types));
  assert.ok(types.indexOf("message_start") < types.indexOf("message_end"), JSON.stringify(types));
});
