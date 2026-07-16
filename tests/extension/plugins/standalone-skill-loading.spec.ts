import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getPluginCommandName } from "../../../src/extension/plugins/loading/PluginCommandLoader.js";
import { loadSkillFromPath } from "../../../src/extension/plugins/loading/PluginLoader.js";
import { PluginRuntime } from "../../../src/extension/plugins/runtime/PluginRuntime.js";

async function writeSkill(
  skillDir: string,
  name: string,
  description: string,
  body: string,
): Promise<void> {
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
    "utf8",
  );
}

test("standalone skills expose only their slug without a parent-directory namespace", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-standalone-skill-"));
  try {
    const skillDir = join(root, "docx");
    await writeSkill(skillDir, "docx", "Create and edit Word documents.", "# DOCX skill");
    await mkdir(join(skillDir, "references"), { recursive: true });
    await writeFile(join(skillDir, "references", "workflows.md"), "# Workflows\n", "utf8");

    const loaded = await loadSkillFromPath(skillDir, "global");
    assert.equal(loaded.name, "docx");
    assert.equal(loaded.skills?.length, 1);
    assert.equal(loaded.skills?.[0]?.name, "docx");
    assert.equal(loaded.skills?.[0]?.isSkill, true);
    assert.match(loaded.skills?.[0]?.content ?? "", /# DOCX skill/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a plugin skill directory used as the configured base never derives a parent namespace", () => {
  const skillDir = join("tmp", "office", "skills", "docx");
  assert.equal(
    getPluginCommandName("office", join(skillDir, "SKILL.md"), skillDir),
    "office:docx",
  );
});

test("standalone skill precedence is project > user > builtin without legacy aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-skill-precedence-"));
  try {
    const pilotHome = join(root, "pilot-home");
    const projectRoot = join(root, "project");
    const builtinSkillsRoot = join(root, "bundled-skills");
    await writeSkill(
      join(builtinSkillsRoot, "docx"),
      "docx",
      "Built-in DOCX skill description.",
      "# Built-in DOCX skill",
    );
    await writeSkill(
      join(pilotHome, "skills", "docx"),
      "docx",
      "Global DOCX skill description.",
      "# Global DOCX skill",
    );
    await writeSkill(
      join(projectRoot, ".pilotdeck", "skills", "docx"),
      "docx",
      "Project DOCX skill description.",
      "# Project DOCX skill",
    );

    const pluginDir = join(pilotHome, "plugins", "office");
    await mkdir(join(pluginDir, "skills", "docx"), { recursive: true });
    await writeFile(
      join(pluginDir, "plugin.json"),
      JSON.stringify({ name: "office", version: "1.0.0" }),
      "utf8",
    );
    await writeSkill(
      join(pluginDir, "skills", "docx"),
      "docx",
      "Plugin DOCX skill description.",
      "# Plugin DOCX skill",
    );

    const runtime = new PluginRuntime({ projectRoot, pilotHome, builtinSkillsRoot });
    await runtime.refresh();

    const docxSkills = runtime.getAllSkills().filter((skill) => skill.name.includes("docx"));
    assert.deepEqual(docxSkills.map((skill) => skill.name).sort(), ["docx", "office:docx"]);
    assert.equal(docxSkills.find((skill) => skill.name === "docx")?.description, "Project DOCX skill description.");
    assert.equal(
      docxSkills.find((skill) => skill.name === "docx")?.path,
      join(projectRoot, ".pilotdeck", "skills", "docx", "SKILL.md"),
    );
    assert.equal(
      docxSkills.find((skill) => skill.name === "office:docx")?.path,
      join(pluginDir, "skills", "docx", "SKILL.md"),
    );

    assert.match(await runtime.loadSkillPrompt("docx") ?? "", /# Project DOCX skill/);
    assert.equal(await runtime.loadSkillPrompt("docx:..:docx"), undefined);
    assert.equal(await runtime.loadSkillPrompt("docx:docx"), undefined);
    assert.match(await runtime.loadSkillPrompt("office:docx") ?? "", /# Plugin DOCX skill/);

    await rm(join(projectRoot, ".pilotdeck", "skills", "docx"), { recursive: true, force: true });
    await runtime.refresh();
    assert.equal(
      runtime.getAllSkills().find((skill) => skill.name === "docx")?.description,
      "Global DOCX skill description.",
    );
    assert.equal(
      runtime.getAllSkills().find((skill) => skill.name === "docx")?.path,
      join(pilotHome, "skills", "docx", "SKILL.md"),
    );
    assert.match(await runtime.loadSkillPrompt("docx") ?? "", /# Global DOCX skill/);

    await rm(join(pilotHome, "skills", "docx"), { recursive: true, force: true });
    await runtime.refresh();
    assert.equal(
      runtime.getAllSkills().find((skill) => skill.name === "docx")?.description,
      "Built-in DOCX skill description.",
    );
    assert.equal(
      runtime.getAllSkills().find((skill) => skill.name === "docx")?.path,
      join(builtinSkillsRoot, "docx", "SKILL.md"),
    );
    assert.match(await runtime.loadSkillPrompt("docx") ?? "", /# Built-in DOCX skill/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
