import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { loadBuiltinPlugins } from "../../../src/extension/plugins/builtin/loadBuiltinPlugins.js";
import { PluginRuntime } from "../../../src/extension/plugins/runtime/PluginRuntime.js";
import { parsePluginMcpServers } from "../../../src/mcp/runtime/parsePluginMcpServers.js";
import {
  patchProjectScopedMcpSpec,
  PILOTDECK_NODE_EXECUTABLE_MARKER,
  PILOTDECK_PLAYWRIGHT_MCP_ENTRYPOINT_MARKER,
} from "../../../src/mcp/runtime/projectMcpSpec.js";

test("browser-use resolves its local Playwright MCP entrypoint", () => {
  const plugin = loadBuiltinPlugins().find((candidate) => candidate.name === "browser-use");
  assert.ok(plugin);
  const { servers, diagnostics } = parsePluginMcpServers(plugin.mcpServers);
  assert.deepEqual(diagnostics, []);
  assert.equal(servers[0]?.transport, "stdio");
  if (servers[0]?.transport !== "stdio") throw new Error("expected stdio MCP spec");
  assert.equal(servers[0].command, PILOTDECK_NODE_EXECUTABLE_MARKER);
  assert.ok(servers[0].args?.includes(PILOTDECK_PLAYWRIGHT_MCP_ENTRYPOINT_MARKER));

  const patched = patchProjectScopedMcpSpec(servers[0]!, "/tmp/project", "/tmp/pilot-home");
  assert.equal(patched.transport, "stdio");
  if (patched.transport !== "stdio") throw new Error("expected stdio MCP spec");
  assert.equal(patched.command, process.execPath);
  assert.match(patched.args?.[0] ?? "", /@playwright[\\/]mcp[\\/]cli\.js$/);
});

test("builtin plugin skills are hydrated by PluginRuntime", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-browser-use-plugin-"));
  try {
    const runtime = new PluginRuntime({
      projectRoot: root,
      pilotHome: join(root, "pilot-home"),
      builtinPlugins: loadBuiltinPlugins(),
    });
    await runtime.refresh();
    const skills = runtime.getAllSkills();
    assert.ok(skills.some((skill) => skill.name.endsWith("browser-use-install")));
    assert.ok(skills.some((skill) => skill.name.endsWith("powershell-safe-invocation")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
