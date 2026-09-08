import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { loadBuiltinPlugins } from "../../../src/extension/plugins/builtin/loadBuiltinPlugins.js";
import { PluginRuntime } from "../../../src/extension/plugins/runtime/PluginRuntime.js";
import { parsePluginMcpServers } from "../../../src/mcp/runtime/parsePluginMcpServers.js";
import {
  patchProjectScopedMcpSpec,
  PILOTDECK_FUNASR_INSTALL_COMMAND_MARKER,
  PILOTDECK_FUNASR_MCP_ENTRYPOINT_MARKER,
  PILOTDECK_FUNASR_RUNTIME_ROOT_MARKER,
  PILOTDECK_NODE_EXECUTABLE_MARKER,
  PILOTDECK_PROJECT_ROOT_MARKER,
} from "../../../src/mcp/runtime/projectMcpSpec.js";

test("built-in FunASR plugin exposes a local per-session Node MCP", () => {
  const plugin = loadBuiltinPlugins().find((candidate) => candidate.name === "funasr");
  assert.ok(plugin);
  assert.equal(plugin.manifest.version, "0.2.0");

  const { servers, diagnostics } = parsePluginMcpServers(plugin.mcpServers);
  assert.deepEqual(diagnostics, []);
  assert.equal(servers.length, 1);
  assert.equal(servers[0]?.id, "funasr");
  assert.equal(servers[0]?.transport, "stdio");
  assert.equal(servers[0]?.perSession, true);
  assert.equal(servers[0]?.command, PILOTDECK_NODE_EXECUTABLE_MARKER);
  assert.equal(servers[0]?.callTimeoutMs, 300_000);
  assert.ok(servers[0]?.args?.includes(PILOTDECK_FUNASR_MCP_ENTRYPOINT_MARKER));
  assert.ok(servers[0]?.args?.includes(PILOTDECK_PROJECT_ROOT_MARKER));
  assert.ok(servers[0]?.args?.includes(PILOTDECK_FUNASR_RUNTIME_ROOT_MARKER));
  assert.ok(servers[0]?.args?.includes(PILOTDECK_FUNASR_INSTALL_COMMAND_MARKER));
});

test("FunASR MCP receives Node, project-root, runtime-root, and entrypoint markers", () => {
  const patched = patchProjectScopedMcpSpec(
    {
      id: "funasr",
      transport: "stdio",
      command: PILOTDECK_NODE_EXECUTABLE_MARKER,
      args: [
        PILOTDECK_FUNASR_MCP_ENTRYPOINT_MARKER,
        "--project-root",
        PILOTDECK_PROJECT_ROOT_MARKER,
        "--runtime-root",
        PILOTDECK_FUNASR_RUNTIME_ROOT_MARKER,
        "--install-command",
        PILOTDECK_FUNASR_INSTALL_COMMAND_MARKER,
      ],
    },
    "/tmp/pilotdeck-project",
    "/tmp/pilotdeck-home",
  );

  assert.equal(patched.transport, "stdio");
  if (patched.transport !== "stdio") throw new Error("expected stdio MCP spec");
  assert.equal(patched.command, process.execPath);
  assert.equal(patched.cwd, "/tmp/pilotdeck-project");
  assert.deepEqual(patched.args?.slice(1, 5), [
    "--project-root", "/tmp/pilotdeck-project", "--runtime-root", "/tmp/pilotdeck-home/funasr",
  ]);
  assert.match(patched.args?.[0] ?? "", /funasr-local-mcp\.mjs$/);
  assert.match(patched.args?.[6] ?? "", /npm --prefix/);
});

test("FunASR can be disabled through builtinPluginsEnabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-funasr-plugin-"));
  try {
    const runtime = new PluginRuntime({
      projectRoot: root,
      pilotHome: join(root, "pilot-home"),
      builtinPlugins: loadBuiltinPlugins(),
      builtinPluginsEnabled: { funasr: false },
    });
    await runtime.refresh();
    assert.equal(runtime.snapshot().some((plugin) => plugin.name === "funasr"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("audio-transcription Skill documents local runtime installation and same-session retry", async () => {
  const skill = await readFile(join(process.cwd(), "skills", "audio-transcription", "SKILL.md"), "utf8");
  assert.match(skill, /install:asr/);
  assert.match(skill, /same session/i);
  assert.match(skill, /mcp__funasr__transcribe_audio/);
  assert.match(skill, /project-local host path/);
  assert.doesNotMatch(skill, /\/audio\//);
  assert.match(skill, /funasr-installation\.md/);
  assert.match(skill, /Do not invoke ASR merely because an audio attachment is present/);
});
