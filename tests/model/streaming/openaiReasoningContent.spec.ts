import assert from "node:assert/strict";
import test from "node:test";

import {
  applyModelEventToAssembler,
  assembleAssistantMessage,
  createModelMessageAssemblerState,
} from "../../../src/model/index.js";
import {
  createOpenAIStreamState,
  normalizeOpenAIStreamEvent,
} from "../../../src/model/providers/openai/stream.js";
import { parseOpenAIResponse } from "../../../src/model/providers/openai/response.js";

test("openai stream parser preserves native reasoning content for replay", () => {
  const streamState = createOpenAIStreamState();
  const events = normalizeOpenAIStreamEvent({
    choices: [{
      delta: { reasoning_content: "native content" },
    }],
  }, streamState);

  const assembler = createModelMessageAssemblerState();
  for (const event of events) {
    applyModelEventToAssembler(assembler, event);
  }
  applyModelEventToAssembler(assembler, { type: "message_end", finishReason: "stop" });

  const assembled = assembleAssistantMessage(assembler);
  assert.deepEqual(assembled.message.content[0], {
    type: "thinking",
    text: "native content",
    reasoningContent: "native content",
  });
});

test("content-only streams preserve special token examples without inferring thinking", () => {
  const samples = [
    "BEGIN `think` A `<think>` B `</think>` C END",
    "<think>This entire response is literal text.</think>",
    "```text\n<think>\nB\n</think>\n```\nAFTER_CODE",
    "BEGIN `<|endoftext|>` `<|endofprompt|>` `<|im_end|>` AFTER_EOS",
    "A partial literal tag: <thi",
  ];
  for (const content of samples) {
    // Whole responses and single-character chunks must produce the same text.
    for (const chunks of [[content], [...content]]) {
      const state = createOpenAIStreamState();
      const events = chunks.flatMap((chunk) => normalizeOpenAIStreamEvent({
        choices: [{ delta: { content: chunk } }],
      }, state));
      events.push(...normalizeOpenAIStreamEvent({
        choices: [{ delta: {}, finish_reason: "stop" }],
      }, state));
      assert.equal(events.some((event) => event.type === "thinking_delta"), false, content);
      assert.equal(events.filter((event) => event.type === "text_delta").map((event) => event.text).join(""), content);
    }
  }
});

for (const field of ["reasoning_content", "reasoning"]) {
  test(`${field} remains separate from literal tags in later content chunks`, () => {
    const state = createOpenAIStreamState();
    const thinking = "Compare the literal strings <think> and </think>.";
    const content = "The answer is `<think>` B `</think>` AFTER_THINK.";
    const events = normalizeOpenAIStreamEvent({
      choices: [{ delta: { [field]: thinking } }],
    }, state);
    for (const text of content) {
      events.push(...normalizeOpenAIStreamEvent({ choices: [{ delta: { content: text } }] }, state));
    }
    assert.deepEqual(events.filter((event) => event.type === "thinking_delta").map((event) => ({
      text: event.text, reasoningContent: event.reasoningContent,
    })), [{ text: thinking, reasoningContent: thinking }]);
    assert.equal(events.filter((event) => event.type === "text_delta").map((event) => event.text).join(""), content);
  });
}

test("mixed reasoning and content chunks match non-streaming response order and text", () => {
  const message = {
    reasoning_content: "The tags <think> and </think> below are quoted examples.",
    content: "BEGIN `<think>` B `</think>` `<|endoftext|>` END",
  };
  const assembler = createModelMessageAssemblerState();
  for (const event of normalizeOpenAIStreamEvent({
    choices: [{ delta: message, finish_reason: "stop" }],
  }, createOpenAIStreamState())) {
    applyModelEventToAssembler(assembler, event);
  }
  const response = parseOpenAIResponse({ choices: [{ message, finish_reason: "stop" }] });
  assert.deepEqual(assembleAssistantMessage(assembler).message.content, response.content);
});
