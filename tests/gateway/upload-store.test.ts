import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { UploadStore } from "../../src/gateway/dialog/UploadStore.js";

test("upload store persists, verifies, and resolves streamed attachments", async (t) => {
  const project = await mkdtemp(join(tmpdir(), "pilotdeck-upload-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const store = new UploadStore({ resolveProject: async () => project, listProjects: async () => [project] });
  const created = await store.create(project, [{ clientFileId: "file-0-opaque-upload-id", name: "one.txt", relativePath: "folder/one.txt", size: 5 }], "retry-key");
  const duplicate = await store.create(project, [{ clientFileId: "file-0-opaque-upload-id", name: "one.txt", relativePath: "folder/one.txt", size: 5 }], "retry-key");
  assert.equal(duplicate.uploadId, created.uploadId);
  await store.writePart(created.uploadId, "file-0-opaque-upload-id", Readable.from([Buffer.from("hello")]));
  const completed = await store.complete(created.uploadId);
  assert.equal(completed.status, "completed");
  assert.equal(completed.uploadedBytes, 5);
  const attachments = await store.verifyAttachment(created.uploadId, project);
  assert.match(attachments[0]!.path, /file-0-opaque-upload-id\.txt$/);
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
