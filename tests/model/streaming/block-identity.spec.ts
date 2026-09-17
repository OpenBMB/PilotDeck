import assert from "node:assert/strict";
import test from "node:test";
import {
  applyModelEventToAssembler,
  assembleAssistantMessage,
  createModelMessageAssemblerState,
  getModelStreamBlockId,
} from "../../../src/model/streaming/assembleModelMessage.js";
import { flattenCanonicalMessage } from "../../../src/web/server/readSessionMessages.js";

test("tool boundaries give repeated output distinct identities shared with persisted history", () => {
  const state = createModelMessageAssemblerState("response");
  const liveIds = [];
  for (let index = 0; index < 2; index += 1) {
    liveIds.push(getModelStreamBlockId(state, "thinking"));
    applyModelEventToAssembler(state, { type: "thinking_delta", text: "Same thought" });
    liveIds.push(getModelStreamBlockId(state, "text"));
    applyModelEventToAssembler(state, { type: "text_delta", text: "Same answer" });
    applyModelEventToAssembler(state, {
      type: "tool_call_end", toolCall: { id: `tool-${index}`, name: "read_file", input: { path: "example.txt" } },
    });
  }
  const history = flattenCanonicalMessage(assembleAssistantMessage(state).message, { index: 0, sessionKey: "s" });
  assert.equal(new Set(liveIds).size, 4);
  assert.deepEqual(history.filter(message => message.blockId).map(message => message.blockId), liveIds);
});

test("history keeps adjacent identified text blocks distinct and still merges legacy text", () => {
  const history = flattenCanonicalMessage({ role: "assistant", content: [
    { type: "text", text: "legacy " }, { type: "text", text: "prefix" },
    { type: "text", text: "same", blockId: "response:text:0" },
    { type: "text", text: "same", blockId: "response:text:1" },
    { type: "text", text: "legacy " }, { type: "text", text: "suffix" },
  ] }, { index: 0, sessionKey: "s" });
  assert.deepEqual(history.map(message => [message.text, message.blockId]), [
    ["legacy prefix", undefined], ["same", "response:text:0"], ["same", "response:text:1"], ["legacy suffix", undefined],
  ]);
});
