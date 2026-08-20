import assert from "node:assert/strict";
import test from "node:test";

import type { McpClient } from "../../src/mcp/client/McpClient.js";
import type { PilotDeckMcpToolSpec } from "../../src/mcp/protocol/types.js";
import type { McpRuntime } from "../../src/mcp/runtime/McpRuntime.js";
import { createMcpToolDefinitionsFromRuntime } from "../../src/mcp/runtime/PluginToToolBridge.js";
import { createDefaultPermissionContext } from "../../src/permission/index.js";
import type { PilotDeckToolRuntimeContext } from "../../src/tool/index.js";

test("MCP ImageContent is preserved as an inline tool-result image", async () => {
  const spec: PilotDeckMcpToolSpec = {
    serverId: "browser",
    toolName: "screenshot",
    wireName: "mcp__browser__screenshot",
    description: "Take a screenshot",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
  };
  const rawContent = [
    { type: "text", text: "Screenshot captured" },
    { type: "image", data: "aW1hZ2UtYnl0ZXM=", mimeType: "image/png" },
    { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
  ];
  const client = {
    spec: { id: "browser", transport: "streamable_http", url: "https://mcp.example.test" },
    callTool: async () => ({ content: rawContent }),
  } as unknown as McpClient;
  const runtime = {
    listAllTools: async () => [spec],
    getClient: (serverId: string) => serverId === "browser" ? client : undefined,
  } as unknown as McpRuntime;

  const definitions = await createMcpToolDefinitionsFromRuntime(runtime);
  assert.equal(definitions.length, 1);
  const output = await definitions[0]!.execute({}, toolContext());

  assert.deepEqual(output.content, [
    { type: "text", text: "Screenshot captured" },
    { type: "image", mimeType: "image/png", data: "aW1hZ2UtYnl0ZXM=" },
    { type: "json", value: [{ type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" }] },
  ]);
  assert.deepEqual(output.data, rawContent);
  assert.deepEqual(output.metadata, {
    mcp: {
      serverId: "browser",
      toolName: "screenshot",
      wireName: "mcp__browser__screenshot",
    },
  });
});

function toolContext(): PilotDeckToolRuntimeContext {
  const cwd = "/tmp/project";
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    cwd,
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({
      cwd,
      mode: "default",
      canPrompt: false,
    }),
  };
}
