import assert from "node:assert/strict";
import test from "node:test";

import { DefaultContextRuntime } from "../../src/context/DefaultContextRuntime.js";
import { NullExtensionResolver, type ExtensionResolver } from "../../src/context/extension/ExtensionResolver.js";
import { PromptAssembler, type PromptAssemblerInput } from "../../src/context/prompt/PromptAssembler.js";
import type { ContextPrepareInput } from "../../src/context/protocol/types.js";
import type { CanonicalMessage } from "../../src/model/index.js";

const text = (value: string): CanonicalMessage => ({ role: "user", content: [{ type: "text", text: value }] });
const input = (patch: Partial<PromptAssemblerInput> = {}): PromptAssemblerInput => ({
  cwd: process.cwd(), provider: "test", model: "test-model", permissionMode: "default",
  additionalWorkingDirectories: [], tools: [], now: () => new Date("2026-11-01T00:00:00Z"), ...patch,
});
const contextInput = (patch: Partial<ContextPrepareInput> = {}): ContextPrepareInput => ({
  ...input(), sessionId: "prompt-session", turnId: "prompt-turn", messages: [text("Find the project conventions")],
  protocol: "anthropic", supportsPromptCache: true, ...patch,
});

test("equivalent extension inventories render the same prompt without mutating their order", () => {
  const commands = [{ name: "z-command" }, { name: "a-command" }];
  const skills = [{ name: "z-skill", path: "/skills/z/SKILL.md" }, { name: "a-skill", path: "/skills/a/SKILL.md" }];
  const resolver: ExtensionResolver = { listCommands: () => commands, listSkills: () => skills, listMcpInstructions: () => [] };
  const assembler = new PromptAssembler(resolver);
  const first = assembler.assemble(input());
  assert.deepEqual(commands.map(entry => entry.name), ["z-command", "a-command"]);
  assert.deepEqual(skills.map(entry => entry.name), ["z-skill", "a-skill"]);
  commands.reverse();
  skills.reverse();
  assert.equal(assembler.assemble(input()).joined, first.joined);
});

test("custom prompts do not discover extension sections that they replace", () => {
  const unexpected = () => { assert.fail("The custom prompt replaced extension discovery"); };
  const assembler = new PromptAssembler({ listCommands: unexpected, listSkills: unexpected, listMcpInstructions: unexpected });
  const result = assembler.assemble(input({ customSystemPrompt: "Custom application policy" }));
  assert.match(result.joined, /Custom application policy/);
  assert.match(result.joined, /<user-context>/);
  assert.deepEqual(result.sections.defaultSystemPrompt, []);
  assert.deepEqual(result.sections.systemContext, []);
});

test("tool guidance only recommends execution capabilities exposed to the model", () => {
  const assembler = new PromptAssembler(new NullExtensionResolver());
  const searchOnly = assembler.assemble(input({ tools: [{ name: "web_search", inputSchema: { type: "object" } }] })).joined;
  assert.match(searchOnly, /web_search/);
  assert.doesNotMatch(searchOnly, /web_fetch|write_file|edit_file|\bbash\b|Parallel delegation policy/);
  const noTools = assembler.assemble(input()).joined;
  assert.doesNotMatch(noTools, /web_search|web_fetch|write_file|edit_file|\bbash\b|Parallel delegation policy/);
});

test("one fresh contribution snapshot supplies every section of a default prompt", () => {
  let reads = 0;
  const unexpected = () => { assert.fail("The snapshot already contains every contribution"); };
  const assembler = new PromptAssembler({
    listCommands: unexpected, listSkills: unexpected, listMcpInstructions: unexpected,
    getPromptContributions: () => {
      reads++;
      return { commands: [{ name: `command-${reads}` }], skills: [{ name: `skill-${reads}`, path: `/skill-${reads}/SKILL.md` }],
        mcpInstructions: [{ serverName: "fixture", instructions: `server-${reads}` }] };
    },
  });
  const first = assembler.assemble(input()).joined;
  assert.equal(reads, 1);
  assert.match(first, /command-1/);
  assert.match(first, /skill-1/);
  assert.match(first, /server-1/);
  const second = assembler.assemble(input()).joined;
  assert.equal(reads, 2);
  assert.match(second, /command-2/);
  assert.doesNotMatch(first, /command-2/);
});

for (const reader of [undefined, "read_file", "read_skill"]) {
  test(`skill loading guidance respects the available reader (${reader ?? "none"})`, () => {
    const assembler = new PromptAssembler({ listCommands: () => [], listMcpInstructions: () => [],
      listSkills: () => [{ name: "fixture", path: "/skills/fixture/SKILL.md" }] });
    const prompt = assembler.assemble(input({ tools: reader ? [{ name: reader, inputSchema: { type: "object" } }] : [] })).joined;
    assert.match(prompt, /\/skills\/fixture\/SKILL.md/);
    if (reader) assert.ok(prompt.includes(`Use the ${reader} tool`));
    else assert.match(prompt, /Do not claim to have read or applied them/);
    if (reader !== "read_skill") assert.doesNotMatch(prompt, /\bread_skill\b/);
  });
}

test("retrieved memory changes request context without rewriting the stable system prefix or history", async () => {
  let memory = "First retrieved fact";
  const queries: string[] = [];
  const runtime = new DefaultContextRuntime({ now: () => new Date("2026-11-01T00:00:00Z"), memoryResolver: {
    async retrieve(request) { queries.push(request.query); return { systemContext: memory, diagnostics: [] }; },
    async captureTurn() {},
  } });
  const request = contextInput();
  const history = structuredClone(request.messages);
  const first = await runtime.prepareForModel(request);
  memory = "Updated retrieved fact";
  const second = await runtime.prepareForModel(request);
  assert.equal(first.systemPrompt, second.systemPrompt);
  assert.doesNotMatch(first.systemPrompt ?? "", /First retrieved fact|memory-context/);
  assert.deepEqual(first.messages.slice(0, -1), history);
  assert.equal(first.messages.at(-1)?.metadata?.purpose, "memory_context");
  assert.match(JSON.stringify(first.messages.at(-1)), /First retrieved fact/);
  assert.match(JSON.stringify(second.messages.at(-1)), /Updated retrieved fact/);
  assert.notEqual(first.cachePlan?.fingerprint, second.cachePlan?.fingerprint);
  assert.deepEqual(request.messages, history);
  assert.deepEqual(queries, ["Find the project conventions", "Find the project conventions"]);
});

test("post-compaction memory and continuation notices do not replace the retrieval query", async () => {
  const queries: string[] = [];
  const runtime = new DefaultContextRuntime({ memoryResolver: {
    async retrieve(request) { queries.push(request.query); return { diagnostics: [] }; }, async captureTurn() {},
  } });
  await runtime.prepareForModel(contextInput({ messages: [text("Actual user request"),
    text("<memory-context>Prior retrieved fact</memory-context>"),
    text("[system: the conversation above has been compacted. please continue with the current task.]"),
  ] }));
  assert.deepEqual(queries, ["Actual user request"]);
});
