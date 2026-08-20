import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_MODEL_CAPABILITIES } from "../../../src/model/protocol/capabilities.js";
import type {
  CanonicalContentBlock,
  CanonicalModelRequest,
  ModelConfig,
} from "../../../src/model/protocol/canonical.js";
import { ModelRequestError } from "../../../src/model/protocol/errors.js";
import { validateModelRequest } from "../../../src/model/request/validateModelRequest.js";

test("unsupported media inputs are rejected without mutating the request", () => {
  const blocks: CanonicalContentBlock[] = [
    { type: "image", source: "base64", data: "aW1hZ2U=", mimeType: "image/png", bytes: 5 },
    { type: "pdf", source: "base64", data: "cGRm", mimeType: "application/pdf", bytes: 3 },
    { type: "audio", source: "base64", data: "YXVkaW8=", mimeType: "audio/wav", bytes: 5 },
  ];

  for (const block of blocks) {
    const request = modelRequest([structuredClone(block)]);
    const before = structuredClone(request.messages);
    assert.throws(
      () => validateModelRequest(request, textOnlyConfig()),
      (error: unknown) => error instanceof ModelRequestError
        && error.code === "unsupported_modality"
        && error.details != null,
      block.type,
    );
    assert.deepEqual(request.messages, before, `${block.type} request was mutated`);
  }
});

test("unsupported media nested in a tool result is rejected", () => {
  const request = modelRequest([{
    type: "tool_result",
    toolCallId: "call-1",
    content: [{ type: "image", source: "base64", data: "aW1hZ2U=", mimeType: "image/png" }],
  }]);

  assert.throws(
    () => validateModelRequest(request, textOnlyConfig()),
    (error: unknown) => error instanceof ModelRequestError
      && error.code === "unsupported_modality"
      && (error.details as { modality?: string }).modality === "image",
  );
});

function modelRequest(content: CanonicalContentBlock[]): CanonicalModelRequest {
  return {
    provider: "test",
    model: "text-only",
    messages: [{ role: "user", content }],
  };
}

function textOnlyConfig(): ModelConfig {
  return {
    providers: {
      test: {
        id: "test",
        protocol: "openai",
        url: "https://example.test/v1",
        apiKey: "test-key",
        headers: {},
        models: {
          "text-only": {
            id: "text-only",
            capabilities: DEFAULT_MODEL_CAPABILITIES,
            multimodal: { input: ["text"] },
          },
        },
      },
    },
  };
}
