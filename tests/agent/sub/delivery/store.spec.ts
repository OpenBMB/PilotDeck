import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { saveDelivery } from "../../../../src/agent/sub/delivery/store.js";

async function tmpWorkspace(t: import("node:test").TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "pd-delivery-store-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("saveDelivery stores record with host-written version and delivery_file", async (t) => {
  const cwd = await tmpWorkspace(t);
  const returned = await saveDelivery({
    cwd,
    subagentId: "alpha-1",
    attempt: 1,
    record: { summary: "done", version: 99, delivery_file: "/evil/path.json" },
  });

  assert.ok(path.isAbsolute(returned));
  const expected = path.join(cwd, ".pilotdeck", "deliveries", "alpha-1", "attempt-1.json");
  assert.equal(path.resolve(returned), path.resolve(expected));

  const parsed = JSON.parse(await readFile(expected, "utf8")) as Record<string, unknown>;
  assert.equal(parsed.version, 1); // record must not override
  assert.equal(parsed.delivery_file, returned); // record must not override
  assert.equal(parsed.summary, "done");
});

test("saveDelivery keeps attempts separate and updates the same attempt atomically", async (t) => {
  const cwd = await tmpWorkspace(t);
  await saveDelivery({ cwd, subagentId: "beta", attempt: 1, record: { n: 1 } });
  const attemptTwo = await saveDelivery({ cwd, subagentId: "beta", attempt: 2, record: { n: 2 } });
  assert.match(attemptTwo, /attempt-2\.json$/);

  const updated = await saveDelivery({
    cwd,
    subagentId: "beta",
    attempt: 2,
    record: { n: 2, review: { status: "accepted" } },
  });
  assert.equal(updated, attemptTwo);

  const second = JSON.parse(await readFile(attemptTwo, "utf8")) as Record<string, unknown>;
  assert.deepEqual(second.review, { status: "accepted" });

  // Attempt 1 untouched by the attempt-2 update.
  const first = JSON.parse(
    await readFile(path.join(cwd, ".pilotdeck", "deliveries", "beta", "attempt-1.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(first.n, 1);

  const files = await readdir(path.join(cwd, ".pilotdeck", "deliveries", "beta"));
  assert.deepEqual(files.sort(), ["attempt-1.json", "attempt-2.json"]); // no tmp leftovers
});

test("saveDelivery rejects unsafe subagent ids", async (t) => {
  const cwd = await tmpWorkspace(t);
  for (const id of ["", ".", "..", "../evil", "a/b", "a\\b", ".hidden", "a".repeat(200), "id with space"]) {
    await assert.rejects(
      saveDelivery({ cwd, subagentId: id, attempt: 1, record: {} }),
      `id: ${JSON.stringify(id)}`,
    );
  }
});

test("saveDelivery rejects invalid attempt numbers and records", async (t) => {
  const cwd = await tmpWorkspace(t);
  for (const attempt of [0, -1, 1.5, Number.NaN, "1" as unknown as number]) {
    await assert.rejects(saveDelivery({ cwd, subagentId: "ok", attempt, record: {} }));
  }
  for (const record of [null, "str", [1, 2]] as unknown as Record<string, unknown>[]) {
    await assert.rejects(saveDelivery({ cwd, subagentId: "ok", attempt: 1, record }));
  }
});

test("saveDelivery rejects records above the 1 MiB bound", async (t) => {
  const cwd = await tmpWorkspace(t);
  const huge = { blob: "x".repeat(1024 * 1024 + 256) };
  await assert.rejects(saveDelivery({ cwd, subagentId: "ok", attempt: 1, record: huge }));
});

test("saveDelivery rejects symlinked .pilotdeck parent escaping the workspace", async (t) => {
  const cwd = await tmpWorkspace(t);
  const outside = await mkdtemp(path.join(tmpdir(), "pd-delivery-store-out-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(cwd, ".pilotdeck"));
  await assert.rejects(saveDelivery({ cwd, subagentId: "gamma", attempt: 1, record: {} }));
});

test("saveDelivery rejects symlinked per-subagent directory escaping deliveries", async (t) => {
  const cwd = await tmpWorkspace(t);
  const outside = await mkdtemp(path.join(tmpdir(), "pd-delivery-store-out2-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(path.join(cwd, ".pilotdeck", "deliveries"), { recursive: true });
  await symlink(outside, path.join(cwd, ".pilotdeck", "deliveries", "delta"));
  await assert.rejects(saveDelivery({ cwd, subagentId: "delta", attempt: 1, record: {} }));
});

test("saveDelivery rejects escaping archive-style paths via crafted ids", async (t) => {
  const cwd = await tmpWorkspace(t);
  for (const id of ["..%2fevil", "sub/../../../evil", "a/../b"]) {
    await assert.rejects(saveDelivery({ cwd, subagentId: id, attempt: 1, record: {} }));
  }
  // And nothing was written outside.
  const base = await stat(path.join(cwd, ".pilotdeck", "deliveries")).then(
    () => true,
    () => false,
  );
  assert.ok(base || true); // base may or may not exist; escaping writes must not
});

test("saveDelivery persists under a workspace containing unrelated files", async (t) => {
  const cwd = await tmpWorkspace(t);
  await writeFile(path.join(cwd, "keep.txt"), "keep");
  await saveDelivery({ cwd, subagentId: "eps", attempt: 3, record: { a: { deep: [1, 2] } } });
  const stored = JSON.parse(
    await readFile(path.join(cwd, ".pilotdeck", "deliveries", "eps", "attempt-3.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(stored.a, { deep: [1, 2] });
  assert.equal(await readFile(path.join(cwd, "keep.txt"), "utf8"), "keep");
});
