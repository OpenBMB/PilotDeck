import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  ContentAddressedWorkspaceSnapshotRecorder,
  createWorkspaceSnapshotProvider,
  resolveWorkspaceSnapshotConfig,
} from "../../src/storage/workspaceSnapshot.js";

test("workspace snapshot configuration is completely disabled without the legal root", () => {
  assert.equal(resolveWorkspaceSnapshotConfig({}), undefined);
  assert.deepEqual(resolveWorkspaceSnapshotConfig({
    PILOTDECK_LEGAL_STORAGE_ROOT: "/tmp/legal",
    PILOTDECK_LEGAL_SNAPSHOT_ROOT: "/tmp/snapshots",
  }), { root: "/tmp/legal", snapshotRoot: "/tmp/snapshots" });
});

test("snapshots are idempotent, content-addressed, and do not traverse symlinks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-snapshot-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const snapshots = join(root, "snapshots");
  await mkdir(join(workspace, "nested"), { recursive: true });
  await writeFile(join(workspace, "a.txt"), "same");
  await writeFile(join(workspace, "nested", "b.txt"), "same");
  await symlink("a.txt", join(workspace, "link"));
  const recorder = new ContentAddressedWorkspaceSnapshotRecorder({ root, snapshotRoot: snapshots });
  const input = { workspaceId: "w1", sessionId: "s1", turnId: "t1", runId: "r1", workspaceDir: workspace };

  const first = await recorder.capturePreUser(input);
  const repeated = await recorder.capturePreUser(input);
  assert.deepEqual(repeated, first);
  assert.equal(first.state, "committed");

  const manifest = JSON.parse(await readFile(first.manifestPath!, "utf8")) as {
    entries: Array<{ entryType: string; objectKey?: string; linkTarget?: string }>;
  };
  const files = manifest.entries.filter((entry) => entry.entryType === "file");
  assert.equal(files.length, 2);
  assert.equal(files[0]?.objectKey, files[1]?.objectKey);
  assert.equal(manifest.entries.find((entry) => entry.entryType === "symlink")?.linkTarget, "a.txt");
  assert.deepEqual((await readdir(dirname(first.manifestPath!))).sort(), ["_COMMITTED", "manifest.json"]);
});

test("unstable post snapshots write a failure marker and workspace IDs remain isolated", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-snapshot-failed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const snapshots = join(root, "snapshots");
  await mkdir(workspace);
  await writeFile(join(workspace, "a.txt"), "content");
  const recorder = new ContentAddressedWorkspaceSnapshotRecorder({ root, snapshotRoot: snapshots });

  const failed = await recorder.capturePostAgent({
    workspaceId: "w1",
    sessionId: "s2",
    turnId: "t1",
    runId: "r1",
    workspaceDir: workspace,
    workspaceStable: false,
    failureKind: "timeout",
  });
  assert.equal(failed.state, "failed");
  assert.match(failed.error ?? "", /quiescent/);
  assert.ok(failed.failureMarkerPath?.includes("/workspaces/w1/"));

  const other = await recorder.capturePostAgent({
    workspaceId: "w2",
    sessionId: "s1",
    turnId: "t1",
    runId: "r1",
    workspaceDir: workspace,
    failureKind: "agent_error",
  });
  assert.equal(other.state, "committed");
  assert.ok(other.manifestPath?.includes("/workspaces/w2/"));
});

test("snapshot provider lists, reads, and restores a committed workspace", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-snapshot-provider-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const snapshots = join(root, "snapshots");
  const restored = join(root, "restored");
  await mkdir(workspace);
  await writeFile(join(workspace, "report.md"), "native archive");
  const recorder = new ContentAddressedWorkspaceSnapshotRecorder({ root, snapshotRoot: snapshots });
  const captured = await recorder.capturePreUser({ workspaceId: "w1", sessionId: "s1", turnId: "t1", runId: "r1", workspaceDir: workspace });
  const provider = createWorkspaceSnapshotProvider({ root, snapshotRoot: snapshots });
  assert.equal((await provider.list()).length, 1);
  assert.equal((await provider.get(captured.snapshotId))?.snapshotId, captured.snapshotId);
  assert.deepEqual(await provider.restore(captured.snapshotId, restored), { restored: true, workspaceKey: restored });
  assert.equal(await readFile(join(restored, "report.md"), "utf8"), "native archive");
});
