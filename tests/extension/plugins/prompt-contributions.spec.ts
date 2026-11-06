import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import test from "node:test";

import { PluginRuntimeExtensionResolver } from "../../../src/context/extension/PluginRuntimeExtensionResolver.js";
import { PluginRuntime } from "../../../src/extension/plugins/runtime/PluginRuntime.js";

test("prompt projections match full contributions and refresh without changing earlier results", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-prompt-contributions-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "home");
  const pluginRoot = join(pilotHome, "plugins", "fixture");
  const skillPath = join(pluginRoot, "skills", "inspect", "SKILL.md");
  const commandPath = join(pluginRoot, "commands", "review.md");
  await mkdir(join(pluginRoot, "skills", "inspect"), { recursive: true });
  await mkdir(join(pluginRoot, "commands"), { recursive: true });
  await writeFile(join(pluginRoot, "plugin.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  await writeFile(skillPath, "---\nname: inspect\ndescription: Inspect a synthetic fixture\n---\nInspect.");
  await writeFile(commandPath, "---\ndescription: Review a synthetic fixture\nargument-hint: <path>\n---\nReview.");

  const runtime = new PluginRuntime({ projectRoot, pilotHome });
  const resolver = new PluginRuntimeExtensionResolver(runtime);
  await runtime.refresh();
  const commands = resolver.listCommands();
  const skills = resolver.listSkills();
  assert.deepEqual(commands, [{
    name: "fixture:review", description: "Review a synthetic fixture", argumentHint: "<path>", namespace: "fixture",
  }]);
  assert.deepEqual(skills.map((skill) => ({ ...skill, path: normalize(skill.path) })), [{
    name: "fixture:inspect", description: "Inspect a synthetic fixture", path: skillPath, namespace: "fixture",
  }]);
  const snapshot = runtime.snapshotContributions();
  assert.deepEqual(commands, snapshot.commands);
  assert.deepEqual(skills, snapshot.skills);

  await writeFile(commandPath, "---\ndescription: Updated review\n---\nReview again.");
  await writeFile(skillPath, "---\nname: inspect\ndescription: Updated inspection\n---\nInspect again.");
  await runtime.refresh();
  assert.equal(resolver.listCommands()[0].description, "Updated review");
  assert.equal(resolver.listCommands()[0].argumentHint, undefined);
  assert.equal(resolver.listSkills()[0].description, "Updated inspection");
  assert.equal(commands[0].description, "Review a synthetic fixture");
  assert.equal(skills[0].description, "Inspect a synthetic fixture");
  assert.deepEqual(resolver.listCommands(), runtime.snapshotContributions().commands);
  assert.deepEqual(resolver.listSkills(), runtime.snapshotContributions().skills);
});
