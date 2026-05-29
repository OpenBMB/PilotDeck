import test from "node:test";
import assert from "node:assert/strict";

import { createRouterRuntime } from "../../src/router/RouterRuntime.js";
import type { CanonicalModelRequest, ModelRuntime } from "../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import { DEFAULT_MULTIMODAL_CONSTRAINTS } from "../../src/model/protocol/multimodal.js";

test("RouterRuntime replaces unsupported images before model validation", async () => {
  let sawImage = false;
  let sawPlaceholder = false;
  const modelRuntime: ModelRuntime = {
    stream: async function* (request) {
      sawImage = request.messages.some((message) =>
        message.content.some((block) => block.type === "image"),
      );
      sawPlaceholder = request.messages.some((message) =>
        message.content.some((block) => block.type === "text" && block.text.includes("Image removed")),
      );
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "ok" };
      yield { type: "message_end", finishReason: "stop" };
    },
    complete: async () => ({ role: "assistant", content: [{ type: "text", text: "ok" }], finishReason: "stop" }),
    getCapabilities: () => ({
      ...DEFAULT_MODEL_CAPABILITIES,
      supportsStreaming: true,
      maxOutputTokens: 128,
    }),
    getMultimodal: () => DEFAULT_MULTIMODAL_CONSTRAINTS,
  };
  const router = createRouterRuntime({
    scenarios: {
      default: { id: "p/m", provider: "p", model: "m" },
    },
    fallback: {},
    zeroUsageRetry: { enabled: false, maxAttempts: 1 },
    stats: { enabled: false },
  }, { modelRuntime });
  const request: CanonicalModelRequest = {
    provider: "p",
    model: "m",
    stream: true,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image", source: "base64", data: "abc", mimeType: "image/png" },
      ],
    }],
  };

  const decision = await router.decide({ request, sessionId: "s", isMainAgent: true });
  const events = [];
  for await (const event of router.execute(decision, request, { sessionId: "s", turnId: "t", projectPath: "/tmp" })) {
    events.push(event.type);
  }

  assert.equal(sawImage, false);
  assert.equal(sawPlaceholder, true);
  assert.deepEqual(events, ["message_start", "text_delta", "message_end"]);
});
