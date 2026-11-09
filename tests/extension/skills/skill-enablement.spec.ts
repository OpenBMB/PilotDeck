import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SkillManager } from "../../../src/extension/skills/SkillManager.js";
import { PluginRuntime } from "../../../src/extension/plugins/runtime/PluginRuntime.js";

test("switches persist independently by scope and project and affect an already loaded runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-skill-switch-"));
  try {
    const pilotHome = join(root, "home"), projectRoot = join(root, "project"), builtinSkillsRoot = join(root, "bundled");
    const options = { pilotHome, projectRoot, builtinSkillsRoot };
    for (const [base, label] of [[builtinSkillsRoot, "bundled"], [join(pilotHome, "skills"), "user"], [join(projectRoot, ".pilotdeck/skills"), "project"]]) {
      await mkdir(join(base!, "notes"), { recursive: true });
      await writeFile(join(base!, "notes/SKILL.md"), `---\nname: notes\ndescription: ${label}\n---\n${label} instructions`);
    }
    const manager = new SkillManager(options), runtime = new PluginRuntime(options);
    await runtime.refresh();
    assert.equal((await manager.list({ projectKey: projectRoot })).builtin[0]?.enabled, true);
    assert.match((await runtime.loadSkillPrompt("notes"))!, /project instructions/);
    await manager.setEnabled({ scope: "project", slug: "notes", projectKey: projectRoot, enabled: false });
    assert.match((await runtime.loadSkillPrompt("notes"))!, /user instructions/);
    await manager.setEnabled({ scope: "user", slug: "notes", enabled: false });
    assert.match((await runtime.loadSkillPrompt("notes"))!, /bundled instructions/);
    const listed = await manager.list({ projectKey: projectRoot });
    assert.equal(listed.builtin[0]?.overriddenBy, undefined);
    assert.equal(listed.project[0]?.enabled, false);
    assert.deepEqual(listed.items.map(skill => skill.scope), ["builtin"]);
    const original = await readFile(join(builtinSkillsRoot, "notes/SKILL.md"), "utf8");
    await manager.setEnabled({ scope: "builtin", slug: "notes", enabled: false });
    assert.deepEqual(runtime.getAllSkills(), []);
    assert.equal(await runtime.loadSkillPrompt("notes"), undefined);
    assert.equal(await readFile(join(builtinSkillsRoot, "notes/SKILL.md"), "utf8"), original);
    assert.match((await manager.read({ scope: "builtin", slug: "notes" })).content, /bundled instructions/);
    const restarted = new SkillManager(options);
    assert.equal((await restarted.list({})).builtin[0]?.enabled, false);
    await restarted.setEnabled({ scope: "user", slug: "notes", enabled: true });
    assert.match((await runtime.loadSkillPrompt("notes"))!, /user instructions/);
    assert.equal((await restarted.list({ projectKey: projectRoot })).project[0]?.enabled, false);
    const otherRoot = join(root, "other");
    await mkdir(join(otherRoot, ".pilotdeck/skills/notes"), { recursive: true });
    await writeFile(join(otherRoot, ".pilotdeck/skills/notes/SKILL.md"), original);
    assert.equal((await restarted.list({ projectKey: otherRoot })).project[0]?.enabled, true);
    await assert.rejects(manager.setEnabled({ scope: "builtin", slug: "missing", enabled: false }), /not found/);
    await assert.rejects(manager.setEnabled({ scope: "builtin", slug: "notes", enabled: "false" as unknown as boolean }), /boolean/);
    await assert.rejects(manager.setEnabled({ scope: "builtin", slug: "../notes", enabled: false }), /Invalid slug/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent switches preserve all entries and corrupt preferences are never overwritten", async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-skill-preferences-"));
  try {
    const manager = new SkillManager({ pilotHome });
    for (const slug of ["one", "two"]) await manager.create({ scope: "user", slug, description: slug });
    await Promise.all(["one", "two"].map(slug => manager.setEnabled({ scope: "user", slug, enabled: false })));
    assert.ok((await manager.list({})).user.every(skill => skill.enabled === false));
    const file = join(pilotHome, "skill-preferences.json");
    await writeFile(file, "broken");
    await assert.rejects(manager.setEnabled({ scope: "user", slug: "one", enabled: true }));
    assert.equal(await readFile(file, "utf8"), "broken");
  } finally {
    await rm(pilotHome, { recursive: true, force: true });
  }
});
