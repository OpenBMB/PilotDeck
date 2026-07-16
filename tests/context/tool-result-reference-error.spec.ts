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

function requestWith(message: CanonicalMessage, toolCallId = "call-large-error"): CanonicalModelRequest {
  return {
    model: "test-model",
    provider: "test-provider",
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_call", id: toolCallId, name: "bash", input: { command: "test" } }],
      },
      message,
    ],
    tools: [{ name: "bash", inputSchema: { type: "object" } }],
    maxOutputTokens: 1024,
  };
}

test("tool text under token budget remains inline even when over legacy byte threshold", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-tool-result-inline-token-"));
  try {
    const budget = new ToolResultBudget({
      toolResultsDir: dir,
      maxResultSizeChars: 80_000,
      maxResultSizeTokens: 10_000,
      previewBytes: 12_000,
    });
    const body = `search output start\n${"x".repeat(60_000)}\nsearch output tail`;
    assert.ok(Buffer.byteLength(body, "utf8") > 50_000, "fixture should exceed the old 50KB threshold");

    const applied = await budget.applyToMessage({
      role: "user",
      content: [{
        type: "tool_result",
        toolCallId: "call-large-but-inline",
        content: [{ type: "text", text: body }],
      }],
    }, { turnId: "turn-1" });

    assert.equal(applied.content[0]?.type, "tool_result");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tool text over token budget is persisted with expanded grep-first preview", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-tool-result-token-ref-"));
  try {
    const budget = new ToolResultBudget({
      toolResultsDir: dir,
      maxResultSizeChars: 500_000,
      maxResultSizeTokens: 10_000,
      previewBytes: 12_000,
    });
    const body = Array.from({ length: 20_000 }, (_, index) => `candidate ${index}: unique evidence token ${index}`).join("\n");

    const applied = await budget.applyToMessage({
      role: "user",
      content: [{
        type: "tool_result",
        toolCallId: "call-over-token-budget",
        content: [{ type: "text", text: body }],
      }],
    }, { turnId: "turn-1" });

    const ref = applied.content.find((block) => block.type === "tool_result_reference");
    assert.ok(ref, "expected a persisted tool_result_reference");
    assert.match(ref.readFilePath ?? "", /refs\/result-0001\.txt$/);
    assert.ok(Buffer.byteLength(ref.preview, "utf8") > 8_000, "expected a substantially larger preview");

    const openai = buildOpenAIRequest(requestWith({ ...applied, content: [ref] }, "call-over-token-budget"), model);
    const openaiTool = openai.messages.find((message) => message.role === "tool");
    assert.match(String(openaiTool?.content), /grep\(\{ pattern: "<keyword>", path: ".*refs\/result-0001\.txt", output_mode: "content", head_limit: 20 \}/);
    assert.match(String(openaiTool?.content), /Avoid paging through the whole file from offset 1/);
    assert.match(String(openaiTool?.content), /search candidates/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("large tool error references preserve error semantics for model replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-tool-result-test-"));
  try {
    const budget = new ToolResultBudget({ toolResultsDir: dir, maxResultSizeChars: 120, maxResultSizeTokens: 20, previewBytes: 80 });
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
    assert.match(String(openaiTool?.content), /Tool result preview only/);
    assert.match(String(openaiTool?.content), /grep\(\{ pattern: "<keyword>", path: ".*refs\/result-0001\.txt", output_mode: "content", head_limit: 20 \}/);
    assert.match(String(openaiTool?.content), /read_file\(\{ file_path: ".*refs\/result-0001\.txt"/);

    const anthropic = buildAnthropicRequest(requestWith(applied), model);
    const anthropicTool = anthropic.messages[1]?.content.find((part: any) => part?.type === "tool_result") as any;
    assert.equal(anthropicTool?.is_error, true);

    const google = buildGoogleRequest(requestWith(applied), model) as any;
    const functionResponse = google.contents
      .flatMap((content: any) => content.parts ?? [])
      .find((part: any) => part.functionResponse);
    assert.match(String(functionResponse?.functionResponse?.response?.error), /Tool result preview only/);
    assert.equal(functionResponse?.functionResponse?.response?.output, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("multibyte truncated tool result references advertise read_file access", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-tool-result-multibyte-"));
  try {
    const budget = new ToolResultBudget({ toolResultsDir: dir, maxResultSizeChars: 80, maxResultSizeTokens: 20, previewBytes: 40 });
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
    assert.match(String(openaiTool?.content), /grep/);
    assert.match(String(openaiTool?.content), /read_file/);
    assert.match(String(openaiTool?.content), /refs\/result-0001\.txt/);
    assert.doesNotMatch(String(openaiTool?.content), /read_tool_result/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
