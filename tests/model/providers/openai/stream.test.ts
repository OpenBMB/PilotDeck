import test from "node:test";
import assert from "node:assert/strict";

import {
  createOpenAIStreamState,
  normalizeOpenAIStreamEvent,
} from "../../../../src/model/providers/openai/stream.js";
import { ModelProviderError } from "../../../../src/model/protocol/errors.js";

test("normalizeOpenAIStreamEvent parses standard OpenAI streaming tool calls", () => {
  const state = createOpenAIStreamState();

  normalizeOpenAIStreamEvent({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: {
                name: "read_file",
                arguments: "{\"file_path\":\"README.md\"",
              },
            },
          ],
        },
      },
    ],
  }, state);

  const events = normalizeOpenAIStreamEvent({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              function: {
                arguments: "}",
              },
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  }, state);

  const toolCallEnd = events.find((event) => event.type === "tool_call_end");
  assert.ok(toolCallEnd);
  if (toolCallEnd.type !== "tool_call_end") {
    throw new Error(`Expected tool_call_end, got ${toolCallEnd.type}`);
  }
  assert.equal(toolCallEnd.toolCall.id, "call_1");
  assert.equal(toolCallEnd.toolCall.name, "read_file");
  assert.deepEqual(toolCallEnd.toolCall.input, { file_path: "README.md" });
});

test("normalizeOpenAIStreamEvent accepts top-level tool call name and arguments variants", () => {
  const state = createOpenAIStreamState();

  normalizeOpenAIStreamEvent({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_2",
              name: "read_file",
              arguments: "{\"file_path\":\"README.md\"",
            },
          ],
        },
      },
    ],
  }, state);

  const events = normalizeOpenAIStreamEvent({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              input: "}",
            },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  }, state);

  const toolCallEnd = events.find((event) => event.type === "tool_call_end");
  assert.ok(toolCallEnd);
  if (toolCallEnd.type !== "tool_call_end") {
    throw new Error(`Expected tool_call_end, got ${toolCallEnd.type}`);
  }
  assert.equal(toolCallEnd.toolCall.id, "call_2");
  assert.equal(toolCallEnd.toolCall.name, "read_file");
  assert.deepEqual(toolCallEnd.toolCall.input, { file_path: "README.md" });
});

test("normalizeOpenAIStreamEvent rejects tool calls without a function name", () => {
  const state = createOpenAIStreamState();

  normalizeOpenAIStreamEvent({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: "call_3",
              function: {
                arguments: "{\"file_path\":\"README.md\"}",
              },
            },
          ],
        },
      },
    ],
  }, state);

  assert.throws(
    () => normalizeOpenAIStreamEvent({
      choices: [
        {
          delta: {},
          finish_reason: "tool_calls",
        },
      ],
    }, state),
    (error: unknown) => {
      assert.ok(error instanceof ModelProviderError);
      assert.equal(error.error.code, "missing_tool_name");
      return true;
    },
  );
});
