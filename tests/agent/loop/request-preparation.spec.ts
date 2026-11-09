import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareModelRequest, type ModelRequestConfig, type ModelRequestPreparationDependencies, type ModelRequestPreparationInput } from "../../../src/agent/loop/prepareModelRequest.js";
import type { AgentContextPrepareInput, AgentPreparedContext } from "../../../src/context/ContextRuntime.js";
import { buildCachePlan } from "../../../src/context/cache/CachePlan.js";
import type { CanonicalMessage } from "../../../src/model/index.js";
import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import { ToolRegistry, type PilotDeckToolDefinition } from "../../../src/tool/index.js";

const message = (text: string): CanonicalMessage => ({ role: "user", content: [{ type: "text", text }] });
const project = (input: AgentContextPrepareInput): AgentPreparedContext => ({
  messages: input.messages, tools: input.tools, systemPromptParts: [], diagnostics: [], boundaries: [],
});
const tool = (name: string, extra: Partial<PilotDeckToolDefinition> = {}): PilotDeckToolDefinition => ({
  name, kind: "custom", description: `Synthetic ${name}`, inputSchema: { type: "object" },
  isReadOnly: () => true, isConcurrencySafe: () => true,
  execute: async () => { assert.fail("Preparing a request must not execute a tool"); }, ...extra,
});

function fixture(configPatch: Partial<ModelRequestConfig> = {}, dependencies: Partial<ModelRequestPreparationDependencies> = {}) {
  const registry = new ToolRegistry();
  const events: boolean[] = [];
  const config: ModelRequestConfig = {
    provider: "test", model: "test-model", cwd: process.cwd(), permissionMode: "default",
    permissionContext: createDefaultPermissionContext({ cwd: process.cwd(), canPrompt: true }), ...configPatch,
  };
  return { registry, config, events,
    prepare(input: Partial<ModelRequestPreparationInput> = {}) {
      return prepareModelRequest(config, { toolRegistry: registry, onInstructionsLoaded: (hasPrompt) => { events.push(hasPrompt); }, ...dependencies },
        { sessionId: "prepare-session", turnId: "prepare-turn", messages: [message("request")], ...input });
    },
  };
}

test("request projection preserves Python capability, overrides, cancellation and preview settings", async () => {
  let captured: AgentContextPrepareInput | undefined;
  const controller = new AbortController();
  const pythonRuntime = { enabled: true, state: "ready" as const, executable: "/synthetic/python", environment: "/synthetic", version: "3.12.16", packages: { mcp: "1.30.0" } };
  const f = fixture({ pythonRuntime, systemPrompt: "Configured", thinking: { enabled: true, mode: "high" },
    maxOutputTokens: 500, maxContextMessages: 7, toolChoice: "auto", metadata: { fixture: true } }, {
    context: { prepareForModel: async (input) => { captured = input; return project(input); } },
    getModelProtocol: (provider) => { assert.equal(provider, "override"); return "anthropic"; },
    getModelSupportsPromptCache: (provider, model) => { assert.equal(`${provider}/${model}`, "override/selected"); return true; },
    onInstructionsLoaded: undefined,
  });
  const result = await f.prepare({ previewOnly: true, modelOverride: { provider: "override", model: "selected", speed: 0.6 }, abortSignal: controller.signal });
  assert.ok(captured);
  assert.equal(captured.pythonRuntime, pythonRuntime);
  assert.equal(captured.abortSignal, controller.signal);
  assert.equal(captured.previewOnly, true);
  assert.equal(captured.maxMessages, 7);
  assert.equal(captured.customSystemPrompt, "Configured");
  assert.deepEqual([captured.provider, captured.model, captured.protocol, captured.supportsPromptCache], ["override", "selected", "anthropic", true]);
  assert.deepEqual([result.provider, result.model, result.speed, result.maxOutputTokens], ["override", "selected", 0.6, 500]);
  assert.deepEqual(result.thinking, { enabled: true, mode: "high" });
  assert.deepEqual(result.metadata, { fixture: true });
  assert.equal(result.toolChoice, "auto");
  assert.deepEqual(f.events, []);
});

for (const canPrompt of [false, true]) for (const allowPlanModeTools of [false, true]) {
  test(`tool visibility honors prompt capability and plan opt-in (${canPrompt}/${allowPlanModeTools})`, async () => {
    const f = fixture();
    for (const definition of [tool("read_file"), tool("prompt", { requiresUserInteraction: () => true }), tool("enter_plan_mode"), tool("exit_plan_mode")]) f.registry.register(definition);
    const result = await f.prepare({ canPrompt, allowPlanModeTools });
    assert.deepEqual(result.tools?.map((entry) => entry.name), [
      ...(canPrompt && allowPlanModeTools ? ["enter_plan_mode"] : []),
      ...(allowPlanModeTools ? ["exit_plan_mode"] : []), ...(canPrompt ? ["prompt"] : []), "read_file",
    ]);
    assert.equal(f.registry.list().length, 4);
  });
}

test("ask-mode tool narrowing preserves source schemas and reads the registry once", async (t) => {
  const f = fixture({ runMode: "ask" });
  for (const name of ["agent", "bash", "execute_code", "read_file", "write_file"]) f.registry.register(tool(name));
  f.registry.register(tool("mcp_read", { kind: "mcp" }));
  f.registry.register(tool("mcp_write", { kind: "mcp", isReadOnly: () => false }));
  const list = t.mock.method(f.registry, "list");
  const result = await f.prepare({ canPrompt: false });
  assert.equal(list.mock.callCount(), 1);
  assert.deepEqual(result.tools?.map((entry) => entry.name), ["agent", "bash", "execute_code", "mcp_read", "read_file"]);
  assert.match(result.tools!.find((entry) => entry.name === "bash")!.description!, /READ-ONLY/);
  assert.notDeepEqual(result.tools!.find((entry) => entry.name === "agent")!.inputSchema, f.registry.get("agent")!.inputSchema);
  assert.equal(f.registry.get("bash")!.description, "Synthetic bash");
});

test("normalization merges assistant text while preserving tool boundaries and original history", async () => {
  const source: CanonicalMessage[] = [message("start"), { role: "assistant", content: [] },
    { role: "assistant", content: [{ type: "text", text: "first" }], metadata: { model: "first-model" } },
    { role: "assistant", content: [{ type: "text", text: "second" }], metadata: { model: "second-model" } },
    { role: "assistant", content: [{ type: "tool_call", id: "call", name: "probe", input: {} }] },
    { role: "user", content: [{ type: "tool_result", toolCallId: "call", content: [{ type: "text", text: "result" }] }] },
    { role: "assistant", content: [{ type: "text", text: "end" }] }];
  const original = structuredClone(source);
  const result = await fixture().prepare({ messages: source });
  assert.equal(result.messages.length, 5);
  assert.deepEqual(result.messages[1].content, [{ type: "text", text: "first" }, { type: "text", text: "second" }]);
  assert.equal(result.messages[1].metadata?.model, "second-model");
  assert.equal(result.messages[2].content[0].type, "tool_call");
  assert.equal(result.messages[3].content[0].type, "tool_result");
  result.messages[0].content.push({ type: "text", text: "context-only mutation" });
  assert.deepEqual(source, original);
});

for (const systemPrompt of [undefined, "", "Context prompt"]) {
  test(`cache identity and instruction events use the effective prompt (${JSON.stringify(systemPrompt)})`, async () => {
    const f = fixture({ systemPrompt: "Configured" }, { context: { prepareForModel: async (input) => {
      const result = { ...project(input), systemPrompt };
      return { ...result, cachePlan: buildCachePlan({ ...result, provider: input.provider, model: input.model, enabled: true }, 4) };
    } } });
    const first = await f.prepare();
    assert.equal(first.systemPrompt, systemPrompt ?? "Configured");
    assert.deepEqual(first.cachePlan, buildCachePlan({ ...first, tools: first.tools ?? [], enabled: true }, 4));
    assert.deepEqual(f.events, [Boolean(first.systemPrompt)]);
    f.config.systemPrompt = "Updated";
    const second = await f.prepare();
    assert.equal(first.cachePlan?.fingerprint === second.cachePlan?.fingerprint, systemPrompt !== undefined);
  });
}

test("media loading and plan reminders precede final cache planning without altering context input", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-request-contract-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mediaPath = join(root, "fixture.base64");
  await writeFile(mediaPath, "c3ludGhldGlj");
  const messages: CanonicalMessage[] = [{ role: "user", content: [{ type: "media_reference", path: mediaPath,
    mediaType: "image", mimeType: "image/png", originalBytes: 9, preview: "synthetic", hasMore: false }] }];
  const stages: string[] = [];
  let plans = "original-plans";
  const f = fixture({ permissionMode: "plan" }, {
    getPromptAddendum: () => { stages.push("addendum"); return "Todo state"; },
    context: { prepareForModel: async (input) => {
      stages.push("context");
      assert.deepEqual(input.messages, messages);
      assert.equal(input.appendSystemPrompt, "Todo state");
      plans = "selected-plans";
      return { ...project(input), cachePlan: buildCachePlan({ ...input, enabled: true }, 8) };
    } },
    onInstructionsLoaded: () => { stages.push("instructions"); },
    getPlanDirectoryPath: () => { stages.push("plan-path"); return plans; },
  });
  const result = await f.prepare({ messages });
  assert.deepEqual(stages, ["addendum", "context", "instructions", "plan-path"]);
  assert.equal(result.messages[0].content[0].type, "image");
  assert.equal(result.messages[1].metadata?.purpose, "plan_mode_reminder");
  assert.match(JSON.stringify(result.messages[1]), /selected-plans/);
  assert.deepEqual(result.cacheBreakpoints, [0, 1]);
  assert.deepEqual(result.cachePlan, buildCachePlan({ ...result, tools: result.tools ?? [], enabled: true }, 8));
  assert.equal(messages[0].content[0].type, "media_reference");
});

test("legacy breakpoints are retained normally and cleared when a plan reminder changes history", async () => {
  const f = fixture({}, { context: { prepareForModel: async (input) => ({ ...project(input), cacheBreakpoints: [0] }) } });
  assert.deepEqual((await f.prepare()).cacheBreakpoints, [0]);
  f.config.permissionMode = "plan";
  assert.equal((await f.prepare()).cacheBreakpoints, undefined);
});

test("new preparations see tool replacement and removal without mutating earlier requests", async () => {
  const f = fixture();
  f.registry.register(tool("probe"));
  const first = await f.prepare();
  f.registry.replace(tool("probe", { description: "Updated tool" }));
  const second = await f.prepare();
  f.registry.unregister("probe");
  assert.deepEqual((await f.prepare()).tools, []);
  assert.equal(first.tools![0].description, "Synthetic probe");
  assert.equal(second.tools![0].description, "Updated tool");
});

test("context failure propagates without announcing loaded instructions", async () => {
  const failure = new Error("Synthetic context failure");
  const f = fixture({}, { context: { prepareForModel: async () => { throw failure; } } });
  await assert.rejects(f.prepare(), (error) => error === failure);
  assert.deepEqual(f.events, []);
});

test("missing media retains its preview and reports its diagnostic", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-request-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const warn = t.mock.method(console, "warn", () => {});
  const result = await fixture().prepare({ messages: [{ role: "user", content: [{ type: "media_reference",
    path: join(root, "missing.base64"), mediaType: "image", mimeType: "image/png", originalBytes: 0, preview: "Preview", hasMore: false }] }] });
  assert.deepEqual(result.messages, [message("Preview")]);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /media_reference_materialization_failed/);
});
