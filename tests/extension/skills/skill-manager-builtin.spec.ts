import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SkillManager, SkillManagerError } from "../../../src/extension/skills/index.js";

async function writeSkill(root: string, slug: string, description: string): Promise<void> {
  const dir = join(root, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${slug}\ndescription: ${description}\n---\n\n# ${slug}\n`,
    "utf8",
  );
}

test("SkillManager lists built-ins separately and describes override relationships", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-skill-manager-builtin-"));
  try {
    const pilotHome = join(root, "pilot-home");
    const projectRoot = join(root, "project");
    const builtinSkillsRoot = join(root, "bundled-skills");

    await writeSkill(builtinSkillsRoot, "pdf", "Built-in PDF");
    await writeSkill(builtinSkillsRoot, "docx", "Built-in DOCX");
    await writeSkill(join(pilotHome, "skills"), "pdf", "User PDF override");
    await writeSkill(join(projectRoot, ".pilotdeck", "skills"), "docx", "Project DOCX override");
    await writeSkill(join(projectRoot, ".pilotdeck", "skills"), "custom", "Project custom skill");

    const manager = new SkillManager({ pilotHome, builtinSkillsRoot });
    const result = await manager.list({ projectKey: projectRoot });

    assert.deepEqual(result.builtin.map((skill) => skill.slug), ["docx", "pdf"]);
    assert.equal(result.builtin.find((skill) => skill.slug === "pdf")?.overriddenBy, "user");
    assert.equal(result.builtin.find((skill) => skill.slug === "docx")?.overriddenBy, "project");
    assert.equal(result.builtin.every((skill) => skill.readonly), true);
    assert.equal(result.user[0]?.overridesBuiltin, true);
    assert.equal(result.project.find((skill) => skill.slug === "docx")?.overridesBuiltin, true);
    assert.equal(result.project.find((skill) => skill.slug === "custom")?.overridesBuiltin, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SkillManager permits reading but rejects mutations of built-in skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-skill-manager-readonly-"));
  try {
    const pilotHome = join(root, "pilot-home");
    const builtinSkillsRoot = join(root, "bundled-skills");
    await writeSkill(builtinSkillsRoot, "pdf", "Built-in PDF");
    const manager = new SkillManager({ pilotHome, builtinSkillsRoot });

    const read = await manager.read({ scope: "builtin", slug: "pdf" });
    assert.match(read.content, /Built-in PDF/);
    assert.equal(read.skill?.readonly, true);

    for (const operation of [
      () => manager.write({ scope: "builtin", slug: "pdf", content: "changed" }),
      () => manager.create({ scope: "builtin", slug: "new-skill", name: "new-skill" }),
      () => manager.delete({ scope: "builtin", slug: "pdf" }),
      () => manager.import({ sourcePath: join(builtinSkillsRoot, "pdf"), scope: "builtin" }),
    ]) {
      await assert.rejects(operation, (error: unknown) => {
        assert.equal(error instanceof SkillManagerError, true);
        assert.equal((error as SkillManagerError).code, "read_only");
        return true;
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
