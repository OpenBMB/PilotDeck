import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { GenerateContentParameters, GenerateContentResponse } from "@google/genai";
import { complete, streamModel } from "../../../src/model/streaming/streamModel.js";
import { parseGoogleResponse } from "../../../src/model/providers/google/response.js";
import { normalizeGoogleStreamEvent } from "../../../src/model/providers/google/stream.js";
import type { CanonicalModelRequest, ModelConfig } from "../../../src/model/protocol/canonical.js";

const modelConfig: ModelConfig = {
  providers: {
    google: {
      id: "google",
      protocol: "google",
      url: "https://generativelanguage.googleapis.com",
      apiKey: "test-key",
      headers: {},
      models: {
        "gemini-2.5-flash": {
          id: "gemini-2.5-flash",
          capabilities: {
            supportsToolUse: true,
            supportsStreaming: true,
            supportsParallelToolCalls: true,
            supportsThinking: true,
            supportsJsonSchema: true,
            supportsSystemPrompt: true,
            supportsPromptCache: false,
            maxContextTokens: 1_048_576,
            maxOutputTokens: 8_192,
          },
          multimodal: {
            input: ["text", "image", "audio", "pdf"],
          },
        },
      },
    },
  },
};

const baseRequest: CanonicalModelRequest = {
  provider: "google",
  model: "gemini-2.5-flash",
  messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
  stream: false,
};

describe("Google response adaptation", () => {
  it("parses text, thinking, function calls, usage, and finish reason", () => {
    const parsed = parseGoogleResponse({
      responseId: "resp 1",
      candidates: [{
        finishReason: "MALFORMED_FUNCTION_CALL",
        content: {
          parts: [
            { text: "thinking", thought: true, thoughtSignature: "sig" },
            { text: "visible" },
            { functionCall: { name: "lookup", args: { query: "x" } } },
          ],
        },
      }],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 4,
        cachedContentTokenCount: 2,
        totalTokenCount: 16,
      },
    });

    assert.deepEqual(parsed.content, [
      { type: "thinking", text: "thinking", signature: "sig" },
      { type: "text", text: "visible" },
      {
        type: "tool_call",
        id: "call_resp_1_2",
        name: "lookup",
        input: { query: "x" },
        raw: {
          provider: "google",
          functionCall: { name: "lookup", args: { query: "x" } },
        },
      },
    ]);
    assert.deepEqual(parsed.usage, {
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 2,
      totalTokens: 16,
    });
    assert.equal(parsed.finishReason, "tool_call");
  });

  it("normalizes Google stream chunks into canonical events", () => {
    const events = normalizeGoogleStreamEvent({
      responseId: "stream 1",
      candidates: [{
        finishReason: "STOP",
        content: {
          parts: [
            { text: "hi " },
            { functionCall: { id: "tool 1", name: "lookup", args: { query: "x" } } },
          ],
        },
      }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
    });

    assert.deepEqual(events.map((event) => event.type), [
      "message_start",
      "usage",
      "text_delta",
      "tool_call_start",
      "tool_call_delta",
      "tool_call_end",
      "message_end",
    ]);
    assert.equal(events[3]?.type, "tool_call_start");
    assert.equal("id" in events[3] ? events[3].id : undefined, "tool_1");
    assert.equal("name" in events[3] ? events[3].name : undefined, "lookup");
    assert.equal(events.at(-1)?.type, "message_end");
  });
});

describe("Google runtime SDK integration", () => {
  it("uses a Google client for non-streaming completion", async () => {
    let seen: GenerateContentParameters | undefined;
    const response = await complete(baseRequest, modelConfig, {
      googleClientFactory: () => ({
        models: {
          generateContent: async (params) => {
            seen = params;
            return {
              candidates: [{
                finishReason: "STOP",
                content: { parts: [{ text: "Hello back" }] },
              }],
            } as GenerateContentResponse;
          },
          generateContentStream: async () => emptyGoogleStream(),
        },
      }),
    });

    assert.equal(seen?.model, "gemini-2.5-flash");
    assert.equal(response.finishReason, "stop");
    assert.deepEqual(response.content, [{ type: "text", text: "Hello back" }]);
  });

  it("uses a Google client for streaming completion", async () => {
    const events = [];
    for await (const event of streamModel({ ...baseRequest, stream: true }, modelConfig, {
      googleClientFactory: () => ({
        models: {
          generateContent: async () => ({}) as GenerateContentResponse,
          generateContentStream: async () => googleStream([
            {
              candidates: [{ content: { parts: [{ text: "hel" }] } }],
            },
            {
              candidates: [{ finishReason: "STOP", content: { parts: [{ text: "lo" }] } }],
              usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
            },
          ]),
        },
      }),
    })) {
      events.push(event);
    }

    assert.deepEqual(events.map((event) => event.type), [
      "request_started",
      "message_start",
      "text_delta",
      "usage",
      "text_delta",
      "message_end",
    ]);
  });

  it("normalizes Google SDK errors through provider error handling", async () => {
    await assert.rejects(
      () => complete(baseRequest, modelConfig, {
        googleClientFactory: () => ({
          models: {
            generateContent: async () => {
              throw Object.assign(new Error("API key not valid."), { status: 401 });
            },
            generateContentStream: async () => emptyGoogleStream(),
          },
        }),
      }),
      (error: unknown) => {
        assert.equal((error as { error?: { code?: string } }).error?.code, "auth_error");
        assert.equal((error as { error?: { protocol?: string } }).error?.protocol, "google");
        return true;
      },
    );
  });
});

async function* googleStream(chunks: unknown[]): AsyncGenerator<GenerateContentResponse> {
  for (const chunk of chunks) {
    yield chunk as GenerateContentResponse;
  }
}

async function* emptyGoogleStream(): AsyncGenerator<GenerateContentResponse> {}
