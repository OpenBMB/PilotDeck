import test from "node:test";
import assert from "node:assert/strict";

import { parseOpenAIResponse } from "../../../../src/model/providers/openai/response.js";
import {
  createOpenAIStreamState,
  normalizeOpenAIStreamEvent,
} from "../../../../src/model/providers/openai/stream.js";

test("normalizeOpenAIStreamEvent assigns a valid fallback id when stream tool call id is missing", () => {
  const state = createOpenAIStreamState();
  const events = [
    ...normalizeOpenAIStreamEvent({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            function: { name: "read_file", arguments: "{\"file_path\":\"package.json\"}" },
          }],
        },
      }],
    }, state),
    ...normalizeOpenAIStreamEvent({
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
    }, state),
  ];

  const toolEnd = events.find((event) => event.type === "tool_call_end");

  assert.equal(toolEnd?.type, "tool_call_end");
  assert.equal(toolEnd.toolCall.id, "call_0");
});

test("normalizeOpenAIStreamEvent assigns stable non-empty ids for empty stream tool call ids", () => {
  const state = createOpenAIStreamState();
  const events = [
    ...normalizeOpenAIStreamEvent({
      choices: [{
        delta: {
          tool_calls: [{
            index: 0,
            id: "",
            function: { name: "read_file", arguments: "{\"file_path\":\"package.json\"}" },
          }],
        },
      }],
    }, state),
    ...normalizeOpenAIStreamEvent({
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
    }, state),
  ];

  const toolStart = events.find((event) => event.type === "tool_call_start");
  const toolEnd = events.find((event) => event.type === "tool_call_end");

  assert.equal(toolStart?.type, "tool_call_start");
  assert.equal(toolEnd?.type, "tool_call_end");
  assert.equal(toolStart.id, "call_0");
  assert.equal(toolEnd.toolCall.id, "call_0");
});

test("normalizeOpenAIStreamEvent avoids duplicate stream tool call ids", () => {
  const state = createOpenAIStreamState();
  const events = [
    ...normalizeOpenAIStreamEvent({
      choices: [{
        delta: {
          tool_calls: [
            { index: 0, id: "dup", function: { name: "first", arguments: "{}" } },
            { index: 1, id: "dup", function: { name: "second", arguments: "{}" } },
          ],
        },
      }],
    }, state),
    ...normalizeOpenAIStreamEvent({
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
    }, state),
  ];

  const toolEnds = events.filter((event) => event.type === "tool_call_end");

  assert.equal(toolEnds.length, 2);
  assert.deepEqual(toolEnds.map((event) => event.toolCall.id), ["dup", "dup_1"]);
});

test("parseOpenAIResponse assigns a valid fallback id when response tool call id is missing", () => {
  const response = parseOpenAIResponse({
    choices: [{
      message: {
        role: "assistant",
        tool_calls: [{
          type: "function",
          function: { name: "read_file", arguments: "{\"file_path\":\"package.json\"}" },
        }],
      },
      finish_reason: "tool_calls",
    }],
  });

  const toolCall = response.content.find((block) => block.type === "tool_call");

  assert.equal(toolCall?.type, "tool_call");
  assert.equal(toolCall.id, "call_0");
});

test("parseOpenAIResponse avoids duplicate response tool call ids", () => {
  const response = parseOpenAIResponse({
    choices: [{
      message: {
        role: "assistant",
        tool_calls: [
          { id: "dup", type: "function", function: { name: "first", arguments: "{}" } },
          { id: "dup", type: "function", function: { name: "second", arguments: "{}" } },
          { type: "function", function: { name: "third", arguments: "{}" } },
        ],
      },
      finish_reason: "tool_calls",
    }],
  });

  const toolCalls = response.content.filter((block) => block.type === "tool_call");

  assert.deepEqual(toolCalls.map((block) => block.id), ["dup", "dup_1", "call_2"]);
});
