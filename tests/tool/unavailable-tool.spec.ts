import assert from "node:assert/strict";
import test from "node:test";

import { PermissionRuntime } from "../../src/permission/index.js";
import { ToolRuntime } from "../../src/tool/execution/ToolRuntime.js";
import { createWebSearchTool } from "../../src/tool/builtin/webSearch.js";
import { createBuiltinRegistry } from "../../src/tool/registry/createBuiltinRegistry.js";
import { filterAvailableTools } from "../../src/tool/registry/filterAvailableTools.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolRuntimeContext,
} from "../../src/tool/protocol/types.js";

function context(): PilotDeckToolRuntimeContext {
  return {
    sessionId: "session-unavailable",
    turnId: "turn-unavailable",
    cwd: process.cwd(),
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd: process.cwd(),
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
  };
}

function createUnavailableTool(): PilotDeckToolDefinition {
  return {
    name: "optional_tool",
    aliases: ["optional"],
    description: "A tool that is unavailable in this test session.",
    kind: "custom",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    checkAvailability: () => ({
      ok: false,
      code: "failed_check",
      reason: "optional_tool failed its availability check.",
    }),
    execute: async () => ({ content: [{ type: "text", text: "unexpected execution" }] }),
  };
}

test("filtered setup-required tools retain their diagnostic and error code", async () => {
  const registry = new ToolRegistry();
  registry.register(createWebSearchTool({ provider: "glm" }));

  const filtered = await filterAvailableTools(registry, { cwd: process.cwd(), env: {} });
  assert.equal(filtered.registry.has("web_search"), false);
  assert.equal(filtered.registry.getUnavailable("web_search")?.code, "setup_required");

  const result = await new ToolRuntime(filtered.registry, new PermissionRuntime()).execute(
    { id: "call-setup", name: "web_search", input: { query: "test" } },
    context(),
  );
  assert.equal(result.type, "error");
  if (result.type === "error") {
    assert.equal(result.error.code, "setup_required");
    assert.equal(result.metadata?.recovery && (result.metadata.recovery as { failureClass: string }).failureClass, "ask_user");
  }
});

test("failed availability checks become a generic tool_unavailable error", async () => {
  const registry = new ToolRegistry();
  registry.register(createUnavailableTool());

  const filtered = await filterAvailableTools(registry, { cwd: process.cwd() });
  assert.equal(filtered.registry.getUnavailable("optional")?.code, "failed_check");

  const result = await new ToolRuntime(filtered.registry, new PermissionRuntime()).execute(
    { id: "call-unavailable", name: "optional", input: {} },
    context(),
  );
  assert.equal(result.type, "error");
  if (result.type === "error") {
    assert.equal(result.error.code, "tool_unavailable");
    const recovery = result.metadata?.recovery as { failureClass: string; nextActions: string[] };
    assert.equal(recovery.failureClass, "tool_unavailable");
    assert.match(recovery.nextActions.join("\n"), /Configure|available tool/);
    assert.doesNotMatch(JSON.stringify(result), /Faxin|法信/i);
  }
});

test("pre-marked unavailable diagnostics preserve aliases through filtering", async () => {
  const registry = new ToolRegistry();
  registry.markUnavailable({
    toolName: "optional_tool",
    code: "unavailable",
    reason: "optional_tool is disabled in this session.",
  }, ["optional"]);

  const filtered = await filterAvailableTools(registry, { cwd: process.cwd() });
  assert.equal(filtered.registry.getUnavailable("optional")?.toolName, "optional_tool");

  const result = await new ToolRuntime(filtered.registry, new PermissionRuntime()).execute(
    { id: "call-pre-marked-alias", name: "optional", input: {} },
    context(),
  );
  assert.equal(result.type, "error");
  if (result.type === "error") {
    assert.equal(result.error.code, "tool_unavailable");
  }
});

test("explicitly disabled builtin tools retain an unavailable diagnostic", async () => {
  const registry = createBuiltinRegistry({ webSearch: false, webFetch: false });
  assert.equal(registry.getUnavailable("web_fetch")?.code, "unavailable");
  assert.equal(registry.getUnavailable("web_search")?.code, "unavailable");

  const filtered = await filterAvailableTools(registry, { cwd: process.cwd() });
  assert.deepEqual(filtered.unavailable, [
    {
      toolName: "web_fetch",
      code: "unavailable",
      reason: "web_fetch is disabled in this session.",
    },
    {
      toolName: "web_search",
      code: "unavailable",
      reason: "web_search is disabled in this session.",
    },
  ]);
  assert.equal(filtered.registry.getUnavailable("web_fetch")?.code, "unavailable");
  assert.equal(filtered.registry.getUnavailable("web_search")?.code, "unavailable");

  assert.equal(filtered.registry.getUnavailable("WebFetch")?.code, "unavailable");
  assert.equal(filtered.registry.getUnavailable("WebSearch")?.code, "unavailable");

  const result = await new ToolRuntime(filtered.registry, new PermissionRuntime()).execute(
    { id: "call-disabled", name: "web_fetch", input: { url: "https://example.com" } },
    context(),
  );
  assert.equal(result.type, "error");
  if (result.type === "error") {
    assert.equal(result.error.code, "tool_unavailable");
  }

  const aliasResult = await new ToolRuntime(filtered.registry, new PermissionRuntime()).execute(
    { id: "call-disabled-alias", name: "WebSearch", input: { query: "test" } },
    context(),
  );
  assert.equal(aliasResult.type, "error");
  if (aliasResult.type === "error") {
    assert.equal(aliasResult.error.code, "tool_unavailable");
  }

  const fetchAliasResult = await new ToolRuntime(filtered.registry, new PermissionRuntime()).execute(
    { id: "call-disabled-fetch-alias", name: "WebFetch", input: { url: "https://example.com" } },
    context(),
  );
  assert.equal(fetchAliasResult.type, "error");
  if (fetchAliasResult.type === "error") {
    assert.equal(fetchAliasResult.error.code, "tool_unavailable");
  }

  const configuredAliasResult = await new ToolRuntime(filtered.registry, new PermissionRuntime()).execute(
    { id: "call-disabled-configured-alias", name: "search", input: { query: "test" } },
    { ...context(), toolAliases: { search: "web_search" } },
  );
  assert.equal(configuredAliasResult.type, "error");
  if (configuredAliasResult.type === "error") {
    assert.equal(configuredAliasResult.error.code, "tool_unavailable");
  }
});
