import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SnapshotCopyProvider } from "../../../src/always-on/workspace/SnapshotCopyProvider.js";

test("snapshot copy ignores nested dependency directories before size checks and after copy", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "pilotdeck-snapshot-copy-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));

  const projectRoot = join(fixtureRoot, "project");
  const baseDir = join(fixtureRoot, "snapshots");
  const sourceDir = join(projectRoot, "packages", "app", "src");
  const nestedNodeModules = join(projectRoot, "packages", "app", "node_modules");
  const nestedDist = join(projectRoot, "packages", "app", "dist");
  const nestedGitFile = join(projectRoot, "packages", "lib", ".git");

  await mkdir(sourceDir, { recursive: true });
  await mkdir(nestedNodeModules, { recursive: true });
  await mkdir(nestedDist, { recursive: true });
  await mkdir(join(projectRoot, "packages", "lib"), { recursive: true });
  await writeFile(join(projectRoot, "README.md"), "small source file\n");
  await writeFile(join(sourceDir, "index.ts"), "export const ok = true;\n");
  await writeFile(join(nestedNodeModules, "large.bin"), Buffer.alloc(2 * 1024 * 1024));
  await writeFile(join(nestedDist, "bundle.js"), Buffer.alloc(512 * 1024));
  await writeFile(nestedGitFile, "gitdir: ../../.git/modules/lib\n");

  const provider = new SnapshotCopyProvider({
    baseDir,
    maxBytes: 64 * 1024,
  });

  const handle = await provider.prepare({
    projectRoot,
    runId: "run-1",
  });

  assert.ok(existsSync(join(handle.cwd, "README.md")));
  assert.ok(existsSync(join(handle.cwd, "packages", "app", "src", "index.ts")));
  assert.equal(existsSync(join(handle.cwd, "packages", "app", "node_modules")), false);
  assert.equal(existsSync(join(handle.cwd, "packages", "app", "dist")), false);
  assert.equal(existsSync(join(handle.cwd, "packages", "lib", ".git")), false);
  assert.ok(Number(handle.metadata.baseSize) < 64 * 1024);
});
