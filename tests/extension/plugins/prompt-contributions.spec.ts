import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { PluginRuntimeExtensionResolver } from "../../../src/context/extension/PluginRuntimeExtensionResolver.js";
import { PluginRuntime } from "../../../src/extension/plugins/runtime/PluginRuntime.js";
import { writeSkillEnabled } from "../../../src/extension/skills/skillPreferences.js";

test("prompt snapshots honor live skill preferences and precedence without loading unrelated contributions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-prompt-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pilotHome = join(root, "home");
  const projectRoot = join(root, "project");
  const builtinSkillsRoot = join(root, "builtin");
  for (const [directory, description] of [[builtinSkillsRoot, "Builtin guide"], [join(pilotHome, "skills"), "User guide"],
    [join(projectRoot, ".pilotdeck", "skills"), "Project guide"]]) {
    await mkdir(join(directory, "guide"), { recursive: true });
    await writeFile(join(directory, "guide", "SKILL.md"), `---\nname: guide\ndescription: ${description}\n---\nSynthetic guide.`);
  }
  const runtime = new PluginRuntime({ projectRoot, pilotHome, builtinSkillsRoot });
  await runtime.refresh();
  const full = runtime.snapshotContributions();
  const first = runtime.getPromptContributions();
  assert.deepEqual(first, { commands: full.commands, skills: full.skills, mcpInstructions: full.mcpInstructions });
  assert.equal(first.skills[0].description, "Project guide");
  t.mock.method(runtime, "snapshotContributions", () => { assert.fail("Prompt metadata must not aggregate hooks and server configuration"); });
  const resolver = new PluginRuntimeExtensionResolver(runtime, () => [{ serverName: "connected", instructions: "Live server guide" }]);

  writeSkillEnabled(pilotHome, { scope: "project", projectKey: projectRoot, slug: "guide" }, false);
  assert.equal(resolver.getPromptContributions().skills[0].description, "User guide");
  assert.equal(runtime.getAllSkills()[0].description, "User guide");
  assert.deepEqual(runtime.getAllCommands(), first.commands);
  writeSkillEnabled(pilotHome, { scope: "user", slug: "guide" }, false);
  assert.equal(resolver.getPromptContributions().skills[0].description, "Builtin guide");
  writeSkillEnabled(pilotHome, { scope: "builtin", slug: "guide" }, false);
  assert.deepEqual(resolver.getPromptContributions().skills, []);
  assert.equal(first.skills[0].description, "Project guide");
  assert.deepEqual(resolver.getPromptContributions().mcpInstructions, [{ serverName: "connected", instructions: "Live server guide" }]);

  writeSkillEnabled(pilotHome, { scope: "project", projectKey: projectRoot, slug: "guide" }, true);
  await writeFile(join(projectRoot, ".pilotdeck", "skills", "guide", "SKILL.md"), "---\nname: guide\ndescription: Updated project guide\n---\nUpdated.");
  await runtime.refresh();
  assert.equal(resolver.getPromptContributions().skills[0].description, "Updated project guide");
});

test("legacy runtime aggregators remain usable through the prompt snapshot boundary", () => {
  const resolver = new PluginRuntimeExtensionResolver({
    snapshot: () => [], getAllCommands: () => [{ name: "legacy-command" }],
    getAllSkills: () => [{ name: "legacy-skill", path: "/legacy/SKILL.md" }],
    getAllMcpInstructions: () => [{ serverName: "static", instructions: "Static guidance" }],
  }, () => [{ serverName: "connected", instructions: "Connected guidance" }]);
  assert.deepEqual(resolver.getPromptContributions(), {
    commands: [{ name: "legacy-command" }], skills: [{ name: "legacy-skill", path: "/legacy/SKILL.md" }],
    mcpInstructions: [{ serverName: "static", instructions: "Static guidance" }, { serverName: "connected", instructions: "Connected guidance" }],
  });
});
