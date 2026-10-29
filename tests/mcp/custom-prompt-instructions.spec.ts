import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionResolver } from "../../src/context/extension/ExtensionResolver.js";
import { PromptAssembler, type PromptAssemblerInput } from "../../src/context/prompt/PromptAssembler.js";

const extension: ExtensionResolver = {
  listCommands: () => [],
  listSkills: () => [],
  listMcpInstructions: () => [
    { serverName: "desktop/app", instructions: "Observe before acting." },
    { serverName: "desktop/app-other", instructions: "Unrelated server guidance." },
  ],
};
const customInput: PromptAssemblerInput = {
  cwd: "/workspace",
  provider: "test",
  model: "model",
  permissionMode: "default",
  additionalWorkingDirectories: [],
  customSystemPrompt: "You are the custom observer.",
  appendSystemPrompt: "Final role addendum.",
  tools: [{
    name: "mcp__desktop_app__observe",
    description: "Observe a window",
    inputSchema: { type: "object", properties: {} },
  }],
};

test("custom root prompts retain their full override without MCP instruction opt-in", () => {
  const prompt = new PromptAssembler(extension).assemble(customInput).joined;
  assert.match(prompt, /^You are the custom observer\./);
  assert.doesNotMatch(prompt, /Observe before acting|Unrelated server guidance|You are PilotDeck/);
  assert.ok(prompt.endsWith("Final role addendum."));
});

test("custom subagent prompts include only instructions for their available MCP servers", () => {
  const prompt = new PromptAssembler(extension).assemble({
    ...customInput,
    includeMcpInstructionsWithCustomPrompt: true,
  }).joined;
  assert.match(prompt, /^You are the custom observer\./);
  assert.match(prompt, /Observe before acting/);
  assert.doesNotMatch(prompt, /Unrelated server guidance|You are PilotDeck/);
  assert.ok(prompt.endsWith("Final role addendum."));
});

test("subagents without MCP tools receive no MCP instructions", () => {
  const prompt = new PromptAssembler(extension).assemble({
    ...customInput,
    includeMcpInstructionsWithCustomPrompt: true,
    tools: [{ name: "read_file", description: "Read", inputSchema: { type: "object" } }],
  }).joined;
  assert.doesNotMatch(prompt, /mcp-instructions|Observe before acting|Unrelated server guidance/);
});

test("overlapping server names do not guess ownership from ambiguous wire names", () => {
  const prompt = new PromptAssembler({ ...extension, listMcpInstructions: () => [
    { serverName: "desktop", instructions: "Short server guidance." },
    { serverName: "desktop__private", instructions: "Private server guidance." },
  ] }).assemble({
    ...customInput,
    includeMcpInstructionsWithCustomPrompt: true,
    tools: [{ ...customInput.tools[0]!, name: "mcp__desktop__private__observe" }],
  }).joined;
  assert.doesNotMatch(prompt, /mcp-instructions|Short server guidance|Private server guidance/);
});

test("ambiguous wire names do not expose instructions from an unrelated server", () => {
  for (const instructions of [
    [{ serverName: "desktop", instructions: "Unrelated guidance." }],
    [
      { serverName: "desktop/app", instructions: "Unrelated guidance." },
      { serverName: "desktop_app", instructions: "Also unrelated guidance." },
    ],
  ]) {
    const prompt = new PromptAssembler({ ...extension, listMcpInstructions: () => instructions }).assemble({
      ...customInput,
      includeMcpInstructionsWithCustomPrompt: true,
      tools: [{ ...customInput.tools[0]!, name: instructions.length === 1
        ? "mcp__desktop__private__observe" : "mcp__desktop_app__observe" }],
    }).joined;
    assert.doesNotMatch(prompt, /mcp-instructions|Unrelated guidance|Also unrelated guidance/);
  }
});
