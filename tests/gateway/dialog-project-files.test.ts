import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listProjectFiles } from "../../src/gateway/dialog/projectFiles.js";

test("project files paginate without duplicates and return UTF-16 match ranges", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "src"));
  await Promise.all([
    writeFile(join(root, "src", "alpha.ts"), ""),
    writeFile(join(root, "src", "emoji-😀-name.ts"), ""),
    writeFile(join(root, "zeta.md"), ""),
  ]);
  const first = await listProjectFiles({ projectKey: root, includeDirs: false, limit: 2 });
  const second = await listProjectFiles({ projectKey: root, includeDirs: false, limit: 2, cursor: first.nextCursor });
  assert.equal(first.items.length, 2);
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.id)).size, 3);

  const searched = await listProjectFiles({ projectKey: root, query: "name", includeDirs: false });
  assert.equal(searched.items[0]?.name, "emoji-😀-name.ts");
  assert.deepEqual(searched.items[0]?.matches?.find((match) => match.field === "name"), {
    field: "name", start: 9, end: 13,
  });
});

test("project files do not follow symlinks outside the project", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-root-"));
  const outside = await mkdtemp(join(tmpdir(), "pilotdeck-project-outside-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  await writeFile(join(outside, "secret.txt"), "secret");
  await symlink(outside, join(root, "external"));
  const result = await listProjectFiles({ projectKey: root });
  assert.equal(result.items.some((item) => item.relativePath.includes("secret")), false);
});

test("project file cursor is bound to its query", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-project-cursor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([writeFile(join(root, "a.txt"), ""), writeFile(join(root, "b.txt"), "")]);
  const first = await listProjectFiles({ projectKey: root, limit: 1 });
  await assert.rejects(
    listProjectFiles({ projectKey: root, query: "a", cursor: first.nextCursor }),
    (error: unknown) => (error as { code?: string }).code === "INVALID_CURSOR",
  );
});
