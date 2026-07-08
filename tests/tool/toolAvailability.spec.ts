import assert from "node:assert/strict";
import test from "node:test";
import type { PilotDeckToolDefinition } from "../../src/tool/protocol/types.js";
import { filterAvailableTools } from "../../src/tool/registry/filterAvailableTools.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";

function createTool(
  name: string,
  overrides: Partial<PilotDeckToolDefinition> = {},
): PilotDeckToolDefinition {
  return {
    name,
    description: `${name} test tool`,
    kind: "custom",
    inputSchema: { type: "object", additionalProperties: false, properties: {} },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async () => ({ content: [{ type: "text", text: name }] }),
    ...overrides,
  };
}

test("filterAvailableTools removes unavailable tools and keeps diagnostics", async () => {
  const registry = new ToolRegistry();
  registry.register(createTool("available"));
  registry.register(createTool("missing_setup", {
    checkAvailability: () => ({ ok: false, code: "setup_required", reason: "missing API key" }),
  }));

  const result = await filterAvailableTools(registry, { cwd: process.cwd(), env: {} });

  assert.equal(result.registry.has("available"), true);
  assert.equal(result.registry.has("missing_setup"), false);
  assert.deepEqual(result.unavailable, [
    { toolName: "missing_setup", code: "setup_required", reason: "missing API key" },
  ]);
});

test("filterAvailableTools converts throwing checks into failed_check diagnostics", async () => {
  const registry = new ToolRegistry();
  registry.register(createTool("broken", {
    checkAvailability: () => {
      throw new Error("boom");
    },
  }));

  const result = await filterAvailableTools(registry, { cwd: process.cwd(), env: {} });

  assert.equal(result.registry.has("broken"), false);
  assert.deepEqual(result.unavailable, [
    { toolName: "broken", code: "failed_check", reason: "boom" },
  ]);
});

test("filterAvailableTools caches shared checks within one filtering pass", async () => {
  let calls = 0;
  const sharedCheck = () => {
    calls += 1;
    return { ok: true as const };
  };
  const registry = new ToolRegistry();
  registry.register(createTool("one", { checkAvailability: sharedCheck }));
  registry.register(createTool("two", { checkAvailability: sharedCheck }));

  const result = await filterAvailableTools(registry, { cwd: process.cwd(), env: {} });

  assert.equal(result.registry.has("one"), true);
  assert.equal(result.registry.has("two"), true);
  assert.equal(calls, 1);
});
