import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SkillManager, SkillManagerError } from "../../../src/extension/skills/SkillManager.js";

test("SkillManager rejects project scope for desktop runtime roots", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-skills-runtime-"));
  try {
    const pilotHome = join(root, "pilot-home");
    const runtimeRoot = join(root, "Program Files", "PilotDeck", "resources", "runtime");
    const manager = new SkillManager({
      pilotHome,
      env: { PILOTDECK_DESKTOP: "1" },
    });

    await assert.rejects(
      () =>
        manager.create({
          scope: "project",
          projectKey: runtimeRoot,
          slug: "runtime-skill",
          content: "---\nname: runtime-skill\n---\n",
        }),
      (error) =>
        error instanceof SkillManagerError
        && error.code === "project_required",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SkillManager keeps project scope under real project roots", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-skills-project-"));
  try {
    const pilotHome = join(root, "pilot-home");
    const projectRoot = join(root, "repo");
    const manager = new SkillManager({
      pilotHome,
      env: { PILOTDECK_DESKTOP: "1" },
    });

    const result = await manager.create({
      scope: "project",
      projectKey: projectRoot,
      slug: "real-skill",
      content: "---\nname: real-skill\n---\n",
    });

    assert.equal(result.skillPath, join(projectRoot, ".pilotdeck", "skills", "real-skill"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
