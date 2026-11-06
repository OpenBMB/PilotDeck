import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  prepareModelRequest,
  type ModelRequestPreparationDependencies,
  type ModelRequestPreparationInput,
} from "../../../src/agent/loop/prepareModelRequest.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentContextPrepareInput, AgentPreparedContext } from "../../../src/context/ContextRuntime.js";
import { buildCachePlan } from "../../../src/context/cache/CachePlan.js";
import type { CanonicalMessage } from "../../../src/model/index.js";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import { ToolRegistry, type PilotDeckToolDefinition } from "../../../src/tool/index.js";

const text = (value: string): CanonicalMessage => ({ role: "user", content: [{ type: "text", text: value }] });
const prepared = (input: AgentContextPrepareInput): AgentPreparedContext => ({
  messages: input.messages, tools: input.tools, systemPromptParts: [], diagnostics: [], boundaries: [],
});

function tool(name: string, overrides: Partial<PilotDeckToolDefinition> = {}): PilotDeckToolDefinition {
  return {
    name, description: `Synthetic ${name}`, kind: "custom", inputSchema: { type: "object" },
    isReadOnly: () => true, isConcurrencySafe: () => true,
    execute: async () => { throw new Error("Request preparation must not execute tools"); },
    ...overrides,
  };
}

function fixture(configPatch: Partial<AgentRuntimeConfig> = {}, dependencies: Partial<ModelRequestPreparationDependencies> = {}) {
  const registry = new ToolRegistry();
  const instructionEvents: boolean[] = [];
  const config: AgentRuntimeConfig = {
    provider: "configured-provider", model: "configured-model", cwd: process.cwd(), permissionMode: "default",
    permissionContext: createDefaultPermissionContext({ cwd: process.cwd(), mode: "default", canPrompt: true }),
    ...configPatch,
  };
  return {
    registry, config, instructionEvents,
    prepare(input: Partial<ModelRequestPreparationInput> = {}, options: { previewOnly?: boolean; emitInstructionEvents?: boolean } = {}) {
      return prepareModelRequest(config, {
        toolRegistry: registry,
        onInstructionsLoaded: options.emitInstructionEvents === false ? undefined : (hasPrompt) => { instructionEvents.push(hasPrompt); },
        ...dependencies,
      }, {
        sessionId: "request-session", turnId: "request-turn", messages: [text("request")],
        ...input, previewOnly: options.previewOnly,
      });
    },
  };
}

test("request normalization merges text continuations while preserving tool boundaries and source messages", async () => {
  const messages: CanonicalMessage[] = [
    text("start"),
    { role: "assistant", content: [] },
    { role: "assistant", content: [{ type: "text", text: "first" }], metadata: { synthetic: true, model: "old" } },
    { role: "assistant", content: [{ type: "text", text: "second" }], metadata: { purpose: "continuation", model: "new" } },
    { role: "assistant", content: [{ type: "tool_call", id: "call", name: "read_file", input: { path: "a" } }] },
    { role: "user", content: [{ type: "tool_result", toolCallId: "call", content: [{ type: "text", text: "result" }] }] },
    { role: "assistant", content: [{ type: "text", text: "done" }] },
  ];
  const original = structuredClone(messages);
  let projected: CanonicalMessage[] = [];
  const f = fixture({}, { context: { async prepareForModel(input) {
    projected = structuredClone(input.messages);
    const call = input.messages[2].content[0];
    assert.equal(call.type, "tool_call");
    if (call.type === "tool_call") (call.input as { path: string }).path = "changed in context";
    return prepared(input);
  } } });
  await f.prepare({ messages });
  assert.equal(projected.length, 5);
  assert.deepEqual(projected[1].content, [{ type: "text", text: "first" }, { type: "text", text: "second" }]);
  assert.deepEqual(projected[1].metadata, { synthetic: true, purpose: "continuation", model: "new" });
  assert.equal(projected[2].content[0].type, "tool_call");
  assert.equal(projected[3].content[0].type, "tool_result");
  assert.deepEqual(messages, original);
});

for (const [canPrompt, allowPlanModeTools, expected] of [
  [true, false, ["ask_user_question", "read_file"]],
  [true, true, ["ask_user_question", "enter_plan_mode", "exit_plan_mode", "read_file"]],
  [false, true, ["read_file"]],
] as const) {
  test(`request tools honor prompt capability ${canPrompt} and plan-tool opt-in ${allowPlanModeTools}`, async () => {
    const f = fixture();
    f.registry.register(tool("read_file"));
    f.registry.register(tool("enter_plan_mode"));
    f.registry.register(tool("exit_plan_mode", { requiresUserInteraction: () => true }));
    f.registry.register(tool("ask_user_question", { requiresUserInteraction: () => true }));
    const result = await f.prepare({ canPrompt, allowPlanModeTools });
    assert.deepEqual(result.tools?.map((entry) => entry.name), expected);
    assert.equal(f.registry.list().length, 4);
  });
}

test("ask mode narrows builtin and MCP schemas without mutating tool definitions", async () => {
  const f = fixture({ runMode: "ask" });
  for (const name of ["agent", "bash", "execute_code", "read_file", "write_file"]) f.registry.register(tool(name));
  f.registry.register(tool("mcp_read", { kind: "mcp" }));
  f.registry.register(tool("mcp_write", { kind: "mcp", isReadOnly: () => false }));
  const result = await f.prepare();
  assert.deepEqual(result.tools?.map((entry) => entry.name), ["agent", "bash", "execute_code", "mcp_read", "read_file"]);
  assert.match(result.tools!.find((entry) => entry.name === "bash")!.description ?? "", /READ-ONLY/);
  assert.match(result.tools!.find((entry) => entry.name === "execute_code")!.description ?? "", /READ-ONLY/);
  const agent = result.tools!.find((entry) => entry.name === "agent")!;
  assert.notDeepEqual(agent.inputSchema, f.registry.get("agent")!.inputSchema);
  assert.match(agent.description ?? "", /read.only|READ.ONLY/i);
  assert.equal(f.registry.get("bash")!.description, "Synthetic bash");
});

test("model overrides and preparation options reach context and final request unchanged", async () => {
  let captured: AgentContextPrepareInput | undefined;
  const routes: string[] = [];
  const abort = new AbortController();
  const f = fixture({ systemPrompt: "configured prompt", maxContextMessages: 9, maxOutputTokens: 321,
    thinking: { enabled: true, mode: "high" }, metadata: { fixture: true }, toolChoice: "auto" }, {
    getModelProtocol: (provider) => { routes.push(provider); return "anthropic"; },
    getModelSupportsPromptCache: (provider, model) => { routes.push(`${provider}/${model}`); return true; },
    context: { async prepareForModel(input) { captured = input; return prepared(input); } },
  });
  const result = await f.prepare({ modelOverride: { provider: "selected", model: "selected-model", speed: 0.5 },
    abortSignal: abort.signal }, { previewOnly: true, emitInstructionEvents: false });
  assert.ok(captured);
  assert.equal(captured.previewOnly, true);
  assert.equal(captured.abortSignal, abort.signal);
  assert.equal(captured.maxMessages, 9);
  assert.equal(captured.customSystemPrompt, "configured prompt");
  assert.equal(captured.protocol, "anthropic");
  assert.equal(captured.supportsPromptCache, true);
  assert.deepEqual(routes, ["selected", "selected/selected-model"]);
  assert.deepEqual([result.provider, result.model, result.speed, result.maxOutputTokens], ["selected", "selected-model", 0.5, 321]);
  assert.deepEqual(result.thinking, f.config.thinking);
  assert.equal(result.systemPrompt, "configured prompt");
  assert.deepEqual(result.metadata, { fixture: true });
  assert.equal(result.stream, true);
  assert.equal(result.toolChoice, "auto");
  assert.deepEqual(f.instructionEvents, []);
});

test("regular preparations emit instruction events but budget previews can suppress them", async () => {
  const f = fixture({}, { context: { async prepareForModel(input) { return { ...prepared(input), systemPrompt: "assembled" }; } } });
  await f.prepare();
  await f.prepare({}, { previewOnly: true, emitInstructionEvents: false });
  assert.deepEqual(f.instructionEvents, [true]);
});

for (const systemPrompt of [undefined, "", "assembled prompt"]) {
  test(`cache plans and instruction events use the effective system prompt (${JSON.stringify(systemPrompt)})`, async () => {
    const f = fixture({ systemPrompt: "configured prompt" }, { context: { async prepareForModel(input) {
      const result = { ...prepared(input), systemPrompt };
      return { ...result, cachePlan: buildCachePlan({
        ...result, provider: input.provider, model: input.model, enabled: true,
      }, 3) };
    } } });
    const first = await f.prepare();
    assert.equal(first.systemPrompt, systemPrompt ?? "configured prompt");
    assert.deepEqual(first.cachePlan, buildCachePlan({ ...first, tools: first.tools ?? [], enabled: true }, 3));
    assert.deepEqual(f.instructionEvents, [Boolean(first.systemPrompt)]);

    f.config.systemPrompt = "updated configured prompt";
    const second = await f.prepare();
    assert.equal(second.cachePlan?.fingerprint === first.cachePlan?.fingerprint, systemPrompt !== undefined);
  });
}

test("media bodies and plan reminders participate in final cache fingerprints without changing history", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pilotdeck-request-media-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const mediaPath = join(directory, "fixture.base64");
  await writeFile(mediaPath, "Zmlyc3Q=");
  const messages: CanonicalMessage[] = [{ role: "user", content: [{ type: "media_reference", path: mediaPath,
    mediaType: "image", mimeType: "image/png", originalBytes: 5, preview: "synthetic image", hasMore: false }] }];
  const original = structuredClone(messages);
  let preparedPlan: AgentPreparedContext["cachePlan"];
  const f = fixture({ permissionMode: "plan" }, { context: { async prepareForModel(input) {
    const result = { ...prepared(input), systemPrompt: "assembled",
      tools: [{ name: "context_tool", description: "Prepared tool", inputSchema: { type: "object" as const } }] };
    preparedPlan = buildCachePlan({ ...result, provider: input.provider, model: input.model, enabled: true }, 7);
    return { ...result, cachePlan: preparedPlan };
  } } });
  const first = await f.prepare({ messages });
  assert.equal(first.messages[0].content[0].type, "image");
  assert.equal(first.messages[1].metadata?.purpose, "plan_mode_reminder");
  assert.deepEqual(first.cacheBreakpoints, [0, 1]);
  assert.equal(first.cachePlan?.generation, 7);
  assert.deepEqual(first.tools?.map((entry) => entry.name), ["context_tool"]);
  assert.notEqual(first.cachePlan?.fingerprint, preparedPlan?.fingerprint);
  assert.deepEqual(first.cachePlan, buildCachePlan({ ...first, tools: first.tools ?? [], enabled: true }, 7));
  await writeFile(mediaPath, "c2Vjb25k");
  const second = await f.prepare({ messages });
  assert.notEqual(second.cachePlan?.fingerprint, first.cachePlan?.fingerprint);
  assert.deepEqual(messages, original);
});

test("legacy cache breakpoints survive normal preparation and are cleared after adding a plan reminder", async () => {
  const f = fixture({}, { context: { async prepareForModel(input) { return { ...prepared(input), cacheBreakpoints: [0] }; } } });
  assert.deepEqual((await f.prepare()).cacheBreakpoints, [0]);
  f.config.permissionMode = "plan";
  assert.equal((await f.prepare()).cacheBreakpoints, undefined);
});

test("each preparation sees refreshed tools without changing the earlier request", async () => {
  const f = fixture();
  f.registry.register(tool("read_file"));
  const first = await f.prepare();
  f.registry.register(tool("grep"));
  const second = await f.prepare();
  assert.deepEqual(first.tools?.map((entry) => entry.name), ["read_file"]);
  assert.deepEqual(second.tools?.map((entry) => entry.name), ["grep", "read_file"]);
});

test("context failures propagate before instruction events", async () => {
  const failure = new Error("context unavailable");
  const f = fixture({}, { context: { async prepareForModel() { throw failure; } } });
  await assert.rejects(f.prepare(), (error) => error === failure);
  assert.deepEqual(f.instructionEvents, []);
});

test("prompt addenda and plan paths are resolved at their existing preparation boundaries", async () => {
  const stages: string[] = [];
  let planDirectory = "initial-plans";
  const f = fixture({ permissionMode: "plan" }, {
    getPromptAddendum: () => { stages.push("addendum"); return "todo context"; },
    context: { async prepareForModel(input) {
      stages.push("context");
      assert.equal(input.appendSystemPrompt, "todo context");
      planDirectory = "selected-plans";
      return prepared(input);
    } },
    onInstructionsLoaded: () => { stages.push("instructions"); },
    getPlanDirectoryPath: () => { stages.push("plan-path"); return planDirectory; },
  });
  const result = await f.prepare();
  assert.deepEqual(stages, ["addendum", "context", "instructions", "plan-path"]);
  assert.match(JSON.stringify(result.messages.at(-1)), /selected-plans/);
  assert.doesNotMatch(JSON.stringify(result.messages.at(-1)), /initial-plans/);
});

test("missing media retains its preview and reports the materialization failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pilotdeck-request-missing-media-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const warnings: string[] = [];
  t.mock.method(console, "warn", (warning: string) => { warnings.push(warning); });
  const result = await fixture().prepare({ messages: [{ role: "user", content: [{
    type: "media_reference", path: join(directory, "missing.base64"), mediaType: "image", mimeType: "image/png",
    originalBytes: 0, preview: "missing attachment preview", hasMore: false,
  }] }] });
  assert.deepEqual(result.messages, [text("missing attachment preview")]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /media_reference_materialization_failed/);
});
