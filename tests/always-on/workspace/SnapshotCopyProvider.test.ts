import assert from "node:assert/strict";
import test from "node:test";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SnapshotCopyProvider } from "../../../src/always-on/workspace/SnapshotCopyProvider.js";

test("snapshot-copy size cap and pruning ignore nested ignored directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-snapshot-copy-"));
  const project = join(root, "project");
  const snapshots = join(root, "snapshots");
  await mkdir(join(project, "packages", "app", "src"), { recursive: true });
  await mkdir(join(project, "packages", "app", "node_modules", "large-lib"), { recursive: true });
  await mkdir(join(project, "packages", "app", "dist"), { recursive: true });
  await writeFile(join(project, "packages", "app", "src", "index.ts"), "export {};\n");
  await writeFile(join(project, "packages", "app", "node_modules", "large-lib", "bundle.js"), Buffer.alloc(4096));
  await writeFile(join(project, "packages", "app", "dist", "bundle.js"), Buffer.alloc(4096));

  try {
    const provider = new SnapshotCopyProvider({
      baseDir: snapshots,
      maxBytes: 1024,
    });

    const handle = await provider.prepare({
      projectRoot: project,
      runId: "run-1",
    });

    assert.equal(handle.cwd, join(snapshots, "run-1"));
    assert.equal(Number(handle.metadata.baseSize) < 1024, true);
    await access(join(handle.cwd, "packages", "app", "src", "index.ts"));
    await assert.rejects(access(join(handle.cwd, "packages", "app", "node_modules")));
    await assert.rejects(access(join(handle.cwd, "packages", "app", "dist")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
