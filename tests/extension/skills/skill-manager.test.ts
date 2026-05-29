import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SkillManager } from "../../../src/extension/skills/index.js";

const VALID_SKILL_MD = [
  "---",
  "name: Caps Skill",
  "description: A useful skill with an uppercase markdown filename.",
  "---",
  "",
  "# Caps Skill",
  "",
].join("\n");

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-skill-test-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("SkillManager accepts SKILL.MD for path-based skill import and reads the imported skill", async () => {
  await withTempDir(async (dir) => {
    const sourceParent = join(dir, "sources");
    const sourceSkill = join(sourceParent, "caps-skill");
    await mkdir(sourceSkill, { recursive: true });
    await writeFile(join(sourceSkill, "SKILL.MD"), VALID_SKILL_MD, { encoding: "utf8" });

    const manager = new SkillManager({ pilotHome: join(dir, "pilot-home") });

    const scan = await manager.scan({ parentPath: sourceParent });
    assert.equal(scan.folders.length, 1);
    assert.equal(scan.folders[0]?.hasSkillMd, true);
    assert.equal(scan.folders[0]?.name, "Caps Skill");

    const validation = await manager.validate({ sourcePath: sourceSkill });
    assert.equal(validation.ok, true);

    const imported = await manager.import({
      sourcePath: sourceSkill,
      scope: "user",
      mode: "copy",
    });
    assert.equal(imported.ok, true);
    assert.equal(imported.skill?.name, "Caps Skill");

    const listed = await manager.list({});
    assert.deepEqual(listed.user.map((skill) => skill.slug), ["caps-skill"]);

    const read = await manager.read({ scope: "user", slug: "caps-skill" });
    assert.match(read.content, /# Caps Skill/);

    await manager.write({
      scope: "user",
      slug: "caps-skill",
      content: VALID_SKILL_MD.replace("# Caps Skill", "# Updated Skill"),
    });

    const targetUppercase = join(imported.skillPath, "SKILL.MD");
    assert.equal((await stat(targetUppercase)).isFile(), true);
    assert.match(await readFile(targetUppercase, "utf8"), /# Updated Skill/);
  });
});

test("SkillManager validates uploaded manifest SKILL.MD files case-insensitively", async () => {
  await withTempDir(async (dir) => {
    const manager = new SkillManager({ pilotHome: join(dir, "pilot-home") });
    const validation = await manager.validate({
      skillMdContent: VALID_SKILL_MD,
      files: [{ relativePath: "SKILL.MD", size: Buffer.byteLength(VALID_SKILL_MD) }],
    });

    assert.equal(validation.ok, true);
    assert.equal(validation.frontmatter?.name, "Caps Skill");
  });
});
