import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { UploadStore } from "../../src/gateway/dialog/UploadStore.js";

test("upload metadata cannot escape through a symlink or change its directory identity", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "pilotdeck-upload-boundary-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const store = new UploadStore({ resolveProject: async () => project, listProjects: async () => [project] });
  const created = await store.create(project, [{ clientFileId: "one", name: "one.txt", relativePath: "one.txt", size: 0 }]);
  const taskDir = join(project, ".tmp", "chat-uploads", created.uploadId);
  const outside = join(project, "outside-upload-store");
  await rename(taskDir, outside);
  await symlink(outside, taskDir, "junction");
  await assert.rejects(store.get(created.uploadId), { code: "PROJECT_PATH_FORBIDDEN" });
  await rm(taskDir);
  await rename(outside, taskDir);
  assert.equal((await store.get(created.uploadId)).uploadId, created.uploadId);
  for (const changed of [{ uploadId: "other-upload" }, { projectKey: outside }]) {
    await writeFile(join(taskDir, "metadata.json"), JSON.stringify({ ...created, ...changed }));
    await assert.rejects(store.get(created.uploadId), { code: "UPLOAD_INTEGRITY_MISMATCH" });
  }
});

test("upload lookups reject path separators, traversal and absolute paths", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "pilotdeck-upload-id-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const store = new UploadStore({ resolveProject: async () => project, listProjects: async () => [project] });
  for (const id of ["../outside", "..", "/etc/passwd", "a/b", "a\\b", "C:\\outside", "%2e%2e", ""]) {
    await assert.rejects(store.get(id), { code: "UPLOAD_NOT_FOUND" });
  }
});

test("upload store persists, verifies, and resolves streamed attachments", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "pilotdeck-upload-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const store = new UploadStore({ resolveProject: async () => project, listProjects: async () => [project] });
  const created = await store.create(project, [{ clientFileId: "one", name: "one.txt", relativePath: "folder/one.txt", size: 5 }], "retry-key");
  const duplicate = await store.create(project, [{ clientFileId: "one", name: "one.txt", relativePath: "folder/one.txt", size: 5 }], "retry-key");
  assert.equal(duplicate.uploadId, created.uploadId);
  await store.writePart(created.uploadId, "one", Readable.from([Buffer.from("hello")]));
  const completed = await store.complete(created.uploadId);
  assert.equal(completed.status, "completed");
  assert.equal(completed.uploadedBytes, 5);
  const attachments = await store.verifyAttachment(created.uploadId, project);
  assert.equal(await readFile(attachments[0]!.path, "utf8"), "hello");
});

test("upload store rejects unsafe manifests and size mismatches", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "pilotdeck-upload-invalid-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const store = new UploadStore({ resolveProject: async () => project, listProjects: async () => [project] });
  await assert.rejects(
    store.create(project, [{ clientFileId: "bad", name: "bad", relativePath: "../bad", size: 1 }]),
    (error: unknown) => (error as { code?: string }).code === "UPLOAD_MANIFEST_INVALID",
  );
  const created = await store.create(project, [{ clientFileId: "bad-size", name: "bad", relativePath: "bad", size: 3 }]);
  await assert.rejects(
    store.writePart(created.uploadId, "bad-size", Readable.from([Buffer.from("too long")])),
    (error: unknown) => (error as { code?: string }).code === "UPLOAD_INTEGRITY_MISMATCH",
  );
  assert.equal((await store.get(created.uploadId)).status, "failed");
});

test("upload creation enforces the per-project concurrency limit atomically", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "pilotdeck-upload-concurrency-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const store = new UploadStore({
    resolveProject: async () => project,
    listProjects: async () => [project],
    maxConcurrentPerProject: 1,
  });
  const results = await Promise.allSettled([
    store.create(project, [{ clientFileId: "one", name: "one", relativePath: "one", size: 1 }]),
    store.create(project, [{ clientFileId: "two", name: "two", relativePath: "two", size: 1 }]),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.equal(rejected.reason.code, "UPLOAD_CONCURRENCY_LIMIT");
});

test("attachment verification returns stable project and expiry errors", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "pilotdeck-upload-owner-"));
  const otherProject = await mkdtemp(join(tmpdir(), "pilotdeck-upload-other-"));
  t.after(() => Promise.all([
    rm(project, { recursive: true, force: true }),
    rm(otherProject, { recursive: true, force: true }),
  ]));
  let now = new Date("2026-08-11T00:00:00.000Z");
  const store = new UploadStore({
    resolveProject: async (projectKey) => projectKey,
    listProjects: async () => [project, otherProject],
    now: () => now,
    retentionMs: 1_000,
  });
  const created = await store.create(project, [
    { clientFileId: "one", name: "one.txt", relativePath: "one.txt", size: 5 },
  ]);
  await store.writePart(created.uploadId, "one", Readable.from([Buffer.from("hello")]));
  await store.complete(created.uploadId);

  await assert.rejects(
    store.verifyAttachment(created.uploadId, otherProject),
    (error: unknown) => (error as { code?: string }).code === "PROJECT_PATH_FORBIDDEN",
  );

  now = new Date("2026-08-11T00:00:02.000Z");
  await assert.rejects(
    store.verifyAttachment(created.uploadId, project),
    (error: unknown) => (error as { code?: string }).code === "ATTACHMENT_EXPIRED",
  );
});
