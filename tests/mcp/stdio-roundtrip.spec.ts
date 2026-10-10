import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import test from "node:test";
import { McpClient } from "../../src/mcp/client/McpClient.js";
import { McpRuntime } from "../../src/mcp/runtime/McpRuntime.js";
import { createMcpToolDefinitionsFromRuntime } from "../../src/mcp/runtime/PluginToToolBridge.js";
import { parsePluginMcpServers } from "../../src/mcp/runtime/parsePluginMcpServers.js";
import { toCanonicalToolResultBlock } from "../../src/tool/protocol/result.js";
import type { PilotDeckToolRuntimeContext } from "../../src/tool/protocol/types.js";
import { PluginRuntimeExtensionResolver } from "../../src/context/extension/PluginRuntimeExtensionResolver.js";
import { PromptAssembler } from "../../src/context/prompt/PromptAssembler.js";
import { collectRequiredInputModalities } from "../../src/router/utils/mediaRequirements.js";

const fixture = resolve("tests/mcp/fixtures/roundtrip-server.mjs");
const context = { abortSignal: new AbortController().signal } as PilotDeckToolRuntimeContext;

test("stdio MCP preserves desktop observations through the model projection", { timeout: 15_000 }, async () => {
  const { servers } = parsePluginMcpServers({ desktop: {
    command: process.execPath, args: [fixture], concurrencySafe: false,
  } });
  const runtime = new McpRuntime(servers);
  try {
    assert.equal((await runtime.start())[0]?.status, "ready");
    assert.match(runtime.getInstructions()[0]?.instructions ?? "", /Observe the window/);
    const extension = new PluginRuntimeExtensionResolver({ snapshot: () => [] }, () =>
      runtime.getInstructions().map(({ serverId, instructions }) => ({ serverName: serverId, instructions })));
    const prompt = new PromptAssembler(extension).assemble({ cwd: process.cwd(), provider: "openai",
      model: "fixture", permissionMode: "default", additionalWorkingDirectories: [], tools: [] }).joined;
    assert.match(prompt, /Observe the window before acting/);
    const tools = await createMcpToolDefinitionsFromRuntime(runtime);
    const observe = tools.find(tool => tool.name.endsWith("__observe"))!;
    assert.equal(observe.isReadOnly?.({}), true);
    assert.equal(observe.isConcurrencySafe?.({}), false);
    const output = await observe.execute({}, context);
    assert.ok(output.content.some(block => block.type === "image" && block.mimeType === "image/png"));
    const block = toCanonicalToolResultBlock({ type: "success", toolCallId: "observe-1",
      toolName: observe.name, ...output, startedAt: "now", completedAt: "now" });
    assert.match(JSON.stringify(block.content), /fixture:4:0/);
    assert.match(JSON.stringify(block.content), /screenshot_scale/);
    assert.deepEqual(collectRequiredInputModalities([{ role: "user", content: [block] }]), ["image"]);
    const only = await tools.find(tool => tool.name.endsWith("__structured_only"))!.execute({}, context);
    assert.match(JSON.stringify(only.content), /fixture:4:0/);
    await assert.rejects(tools.find(tool => tool.name.endsWith("__refused"))!.execute({}, context),
      (error: unknown) => {
        const refusal = error as { message: string; details?: unknown };
        assert.match(refusal.message, /Window scope changed/);
        assert.match(JSON.stringify(refusal.details), /stale_snapshot/);
        return true;
      });
  } finally { await runtime.stop(); }
});

for (const failure of ["expired", "disconnected"]) {
  for (const readOnly of [false, true]) {
    test(`stdio MCP ${readOnly ? "retries observations" : "does not replay actions"} when ${failure}`,
      { timeout: 15_000 }, async () => {
        const directory = mkdtempSync(join(tmpdir(), "pilotdeck-mcp-replay-"));
        const counter = join(directory, "calls");
        const client = new McpClient({ id: "desktop", transport: "stdio", command: process.execPath,
          args: [fixture, counter] });
        try {
          await client.listTools();
          if (readOnly) {
            assert.deepEqual((await client.callTool(`read_${failure}`, {})).content, [{ type: "text", text: "2" }]);
          } else {
            await assert.rejects(client.callTool(`action_${failure}`, {}), { code: "mcp_session_expired" });
          }
          assert.equal(readFileSync(counter, "utf8"), readOnly ? "2" : "1");
          assert.equal(client.getStatus(), "ready");
        } finally { await client.close(); rmSync(directory, { recursive: true, force: true }); }
      });
  }
}

test("stdio MCP cancellation and timeout leave the next observation usable", { timeout: 15_000 }, async () => {
  const client = new McpClient({ id: "desktop", transport: "stdio", command: process.execPath, args: [fixture] });
  try {
    await client.listTools();
    const controller = new AbortController();
    const pending = client.callTool("slow_observe", {}, { signal: controller.signal });
    const timer = setTimeout(() => controller.abort(new Error("fixture cancelled")), 50);
    try { await assert.rejects(pending, /fixture cancelled/); }
    finally { clearTimeout(timer); }
    assert.equal(client.getStatus(), "ready");
    await assert.rejects(client.callTool("slow_observe", {}, { timeoutMs: 30 }), { code: "mcp_call_timeout" });
    assert.equal(client.getStatus(), "error");
    const result = await client.callTool("observe", {});
    assert.match(JSON.stringify(result.structuredContent), /fixture:4:0/);
    assert.equal(client.getStatus(), "ready");
  } finally { await client.close(); }
});
