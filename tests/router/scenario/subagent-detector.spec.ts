import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalMessage, CanonicalToolSchema } from "../../../src/model/index.js";
import { detectSubagent, stripSubagentTagFromMessages } from "../../../src/router/scenario/subagentDetector.js";

function userMessage(text: string): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

const AGENT_TOOL: CanonicalToolSchema[] = [{ name: "agent", description: "", inputSchema: {} }];

test("detectSubagent: matching tag family yields a model hint", () => {
  const messages = [userMessage("Use <ccr-subagent-model>claude-sonnet-4</ccr-subagent-model> for this.")];
  const detection = detectSubagent(messages, AGENT_TOOL, true);
  assert.equal(detection.taggedInUserMessage, true);
  assert.equal(detection.isSubagent, true);
  assert.equal(detection.modelHint, "claude-sonnet-4");
});

test("detectSubagent: mismatched opening/closing tag families are ignored", () => {
  const text = "Use <ccr-subagent-model>claude-sonnet-4</pilotdeck-subagent-model> for this.";
  const messages = [userMessage(text)];
  const detection = detectSubagent(messages, AGENT_TOOL, true);
  assert.equal(detection.taggedInUserMessage, false);
  assert.equal(detection.modelHint, undefined);
  // A main agent without the tag keeps isSubagent false (agent tool present).
  assert.equal(detection.isSubagent, false);
});

test("stripSubagentTagFromMessages: keeps mismatched tags as ordinary user text", () => {
  const text = "Keep <ccr-subagent-model>x</pilotdeck-subagent-model> verbatim.";
  const messages = [userMessage(text)];
  const stripped = stripSubagentTagFromMessages(messages);
  assert.equal(stripped[0].content[0].type === "text" && stripped[0].content[0].text, text);
});

test("stripSubagentTagFromMessages: strips a matching tag pair", () => {
  const text = "Please <pilotdeck-subagent-model>gpt-5</pilotdeck-subagent-model> summarize.";
  const messages = [userMessage(text)];
  const stripped = stripSubagentTagFromMessages(messages);
  const result = stripped[0].content[0].type === "text" ? stripped[0].content[0].text : "";
  assert.equal(result.includes("pilotdeck-subagent-model"), false);
});
