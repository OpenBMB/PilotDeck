import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDialogProjectRegistry } from "../../src/gateway/dialog/projectRegistry.js";

const testRoot = join(tmpdir(), "pilotdeck-dialog-project-registry");

test("dialog project registry accepts General and registered projects", async () => {
  const pilotHome = join(testRoot, "home");
  const registeredProject = join(testRoot, "workspace", "project");
  const registry = createDialogProjectRegistry({
    pilotHome,
    listProjects: async () => [{ projectKey: registeredProject }],
  });

  assert.equal(await registry.resolveProjectKey(join(pilotHome, ".")), pilotHome);
  assert.equal(await registry.resolveProjectKey(registeredProject), registeredProject);
  assert.deepEqual(await registry.listProjectKeys(), [pilotHome, registeredProject]);
});

test("dialog project registry keeps unknown paths outside the allowed boundary", async () => {
  const pilotHome = join(testRoot, "home");
  const unknownProject = join(testRoot, "workspace", "unknown");
  const registry = createDialogProjectRegistry({
    pilotHome,
    listProjects: async () => [{ projectKey: join(testRoot, "workspace", "project") }],
  });

  for (const projectKey of [join(pilotHome, "sessions"), unknownProject]) {
    await assert.rejects(
      registry.resolveProjectKey(projectKey),
      (error: unknown) => (
        (error as { code?: string }).code === "PROJECT_NOT_FOUND"
        && (error as Error).message === `Unknown projectKey: ${projectKey}`
      ),
    );
  }
});

test("dialog project registry lists normalized projects only once", async () => {
  const pilotHome = join(testRoot, "home");
  const registeredProject = join(testRoot, "workspace", "project");
  const registry = createDialogProjectRegistry({
    pilotHome,
    listProjects: async () => [
      { projectKey: pilotHome },
      { projectKey: registeredProject },
      { projectKey: join(registeredProject, ".") },
    ],
  });

  assert.deepEqual(await registry.listProjectKeys(), [pilotHome, registeredProject]);
});
