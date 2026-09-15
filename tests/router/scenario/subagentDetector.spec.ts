import assert from "node:assert/strict";
import test from "node:test";

import { detectSubagent } from "../../../src/router/scenario/subagentDetector.js";
import type { CanonicalMessage, CanonicalToolSchema } from "../../../src/model/index.js";

const userText = (text: string): CanonicalMessage => ({
  role: "user",
  content: [{ type: "text", text }],
});

const toolSchema = (name: string): CanonicalToolSchema => ({
  name,
  description: "",
  inputSchema: { type: "object", properties: {} },
});

test("detectSubagent: main agent with custom toolset (no Agent tool) is NOT misclassified as subagent", () => {
  // Regression: the previous implementation OR-ed `missingAgentTool` into the
  // `isSubagent` boolean. A main agent that customized its tool registry to
  // omit `agent` / `task` was therefore reclassified as a subagent, which
  // changed the model selection, the fallback chain, and (via
  // RouterRuntime) could terminate the request under the subagent token
  // budget check.
  const messages: CanonicalMessage[] = [userText("Please help me refactor this file.")];
  const tools: CanonicalToolSchema[] = [
    toolSchema("read_file"),
    toolSchema("edit"),
    toolSchema("grep"),
  ];
  const result = detectSubagent(messages, tools, /* isMainAgent */ true);
  assert.equal(result.isSubagent, false, "main agent must remain main agent");
  assert.equal(result.missingAgentTool, true, "the heuristic flag is still reported");
  assert.equal(result.taggedInUserMessage, false);
});

test("detectSubagent: main agent with the Agent tool stays main", () => {
  const tools: CanonicalToolSchema[] = [
    toolSchema("agent"),
    toolSchema("read_file"),
  ];
  const result = detectSubagent([userText("hi")], tools, /* isMainAgent */ true);
  assert.equal(result.isSubagent, false);
  assert.equal(result.missingAgentTool, false);
});

test("detectSubagent: actual subagent (isMainAgent=false) is always subagent", () => {
  const result = detectSubagent([userText("hi")], undefined, /* isMainAgent */ false);
  assert.equal(result.isSubagent, true);
});

test("detectSubagent: explicit subagent tag in user message reclassifies main agent", () => {
  const result = detectSubagent(
    [userText("<pilotdeck-subagent-model>haiku</pilotdeck-subagent-model>\nDo a quick scan.")],
    [toolSchema("agent")],
    /* isMainAgent */ true,
  );
  assert.equal(result.isSubagent, true);
  assert.equal(result.subagentModelHint, "haiku");
  assert.equal(result.taggedInUserMessage, true);
});

test("detectSubagent: CCR-style tag is also accepted", () => {
  const result = detectSubagent(
    [userText("<ccr-subagent-model>qwen-coder</ccr-subagent-model>")],
    undefined,
    /* isMainAgent */ true,
  );
  assert.equal(result.isSubagent, true);
  assert.equal(result.subagentModelHint, "qwen-coder");
});

test("detectSubagent: spawned_agent / launch-agent / spawn_agent name patterns also satisfy the heuristic", () => {
  for (const name of ["spawn_agent", "launch-agent", "TASK", "Agent"]) {
    const result = detectSubagent([userText("hi")], [toolSchema(name)], false);
    assert.equal(result.missingAgentTool, false, `name ${name} should be recognised`);
  }
});
