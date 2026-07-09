import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ToolResultBudget } from "../../src/context/budget/ToolResultBudget.js";
import { buildAnthropicRequest } from "../../src/model/providers/anthropic/request.js";
import { buildGoogleRequest } from "../../src/model/providers/google/request.js";
import { buildOpenAIRequest } from "../../src/model/providers/openai/request.js";
import type { CanonicalMessage, CanonicalModelRequest, ModelDefinition } from "../../src/model/index.js";

const model: ModelDefinition = {
  id: "test-model",
  capabilities: {
    supportsToolUse: true,
    supportsStreaming: true,
    supportsParallelToolCalls: false,
    supportsThinking: false,
    supportsJsonSchema: false,
    supportsSystemPrompt: true,
    supportsPromptCache: false,
    maxOutputTokens: 1024,
    maxContextTokens: 8192,
  },
  multimodal: { input: ["text"] },
};

function requestWith(message: CanonicalMessage): CanonicalModelRequest {
  return {
    model: "test-model",
    provider: "test-provider",
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_call", id: "call-large-error", name: "bash", input: { command: "test" } }],
      },
      message,
    ],
    tools: [{ name: "bash", inputSchema: { type: "object" } }],
    maxOutputTokens: 1024,
  };
}

test("large tool error references preserve error semantics for model replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-tool-result-test-"));
  try {
    const budget = new ToolResultBudget({ toolResultsDir: dir, maxResultSizeChars: 120, previewBytes: 80 });
    const applied = await budget.applyToMessage({
      role: "user",
      content: [{
        type: "tool_result",
        toolCallId: "call-large-error",
        isError: true,
        content: [{ type: "text", text: `failure-start\n${"x".repeat(300)}\nfailure-tail` }],
      }],
    }, { turnId: "turn-1" });

    const ref = applied.content.find((block) => block.type === "tool_result_reference");
    assert.ok(ref, "expected a persisted tool_result_reference");
    assert.equal(ref.isError, true);

    const openai = buildOpenAIRequest(requestWith(applied), model);
    const openaiTool = openai.messages.find((message) => message.role === "tool");
    assert.match(String(openaiTool?.content), /Truncated: original/);

    const anthropic = buildAnthropicRequest(requestWith(applied), model);
    const anthropicTool = anthropic.messages[1]?.content.find((part: any) => part?.type === "tool_result") as any;
    assert.equal(anthropicTool?.is_error, true);

    const google = buildGoogleRequest(requestWith(applied), model) as any;
    const functionResponse = google.contents
      .flatMap((content: any) => content.parts ?? [])
      .find((part: any) => part.functionResponse);
    assert.match(String(functionResponse?.functionResponse?.response?.error), /Truncated: original/);
    assert.equal(functionResponse?.functionResponse?.response?.output, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("multibyte truncated tool result references still advertise read_file access", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-tool-result-multibyte-"));
  try {
    const budget = new ToolResultBudget({ toolResultsDir: dir, maxResultSizeChars: 80, previewBytes: 40 });
    const applied = await budget.applyToMessage({
      role: "user",
      content: [{
        type: "tool_result",
        toolCallId: "call-large-error",
        content: [{ type: "text", text: "错误原因：" + "模型输出过长".repeat(20) }],
      }],
    }, { turnId: "turn-1" });

    const ref = applied.content.find((block) => block.type === "tool_result_reference");
    assert.ok(ref, "expected a persisted tool_result_reference");
    assert.equal(ref.hasMore, true);
    assert.ok(Buffer.byteLength(ref.preview, "utf8") < ref.originalBytes);

    const openai = buildOpenAIRequest(requestWith({ ...applied, content: [ref] }), model);
    const openaiTool = openai.messages.find((message) => message.role === "tool");
    assert.match(String(openaiTool?.content), /Use read_file on this path/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
