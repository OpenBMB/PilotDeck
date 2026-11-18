import assert from "node:assert/strict";
import test from "node:test";
import { PromptAssembler } from "../../src/context/prompt/PromptAssembler.js";

const assembler = new PromptAssembler({ listCommands: () => [], listSkills: () => [], listMcpInstructions: () => [] });
const tools = ["task_create", "task_output", "task_preview", "task_stop"].map(name => ({ name, description: name, inputSchema: { type: "object" as const, properties: {} } }));
const input = { cwd: "/workspace", provider: "test", model: "test", permissionMode: "default", additionalWorkingDirectories: [], tools };

test("web handoff advertises only available capabilities and preserves source-only exceptions", () => {
  const prompt = assembler.assemble(input).joined;
  assert.match(prompt, /Web application delivery:/);
  assert.match(prompt, /clickable Markdown URL/);
  assert.match(prompt, /source-only/);
  assert.match(prompt, /HTTP success alone does not prove the app renders/);
  assert.match(prompt, /remote\/Docker/);
  for (const missing of tools) {
    const partial = assembler.assemble({ ...input, tools: tools.filter(tool => tool !== missing) }).joined;
    assert.doesNotMatch(partial, /Web application delivery:/);
    assert.doesNotMatch(partial, /task_preview/);
  }
  assert.doesNotMatch(assembler.assemble({ ...input, customSystemPrompt: "Custom prompt" }).joined, /Web application delivery:/);
});

test("read-only modes omit service startup guidance even with the complete catalog", () => {
  for (const mode of [{ permissionMode: "plan" }, { runMode: "plan" }, { runMode: "ask" }]) {
    assert.doesNotMatch(assembler.assemble({ ...input, ...mode }).joined, /Web application delivery:/);
  }
});
