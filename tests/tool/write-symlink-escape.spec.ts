import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createEditFileTool } from "../../src/tool/builtin/editFile.js";
import { createWriteFileTool } from "../../src/tool/builtin/writeFile.js";
import { checkFilesystemWritePermission } from "../../src/tool/builtin/filesystem/writePermissions.js";
import type { PermissionMode } from "../../src/permission/index.js";
import { matchPermissionRule } from "../../src/permission/policy/matchPermissionRule.js";

function context(cwd: string, permissionMode: PermissionMode = "default") {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd,
    permissionMode,
    permissionContext: {
      mode: permissionMode,
      cwd,
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
    now: () => new Date("2026-09-28T00:00:00.000Z"),
  };
}

async function withTempDirs(run: (workspace: string, outside: string) => Promise<void>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-symlink-ws-"));
  const outside = await mkdtemp(join(tmpdir(), "pilotdeck-symlink-out-"));
  try {
    await run(workspace, outside);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}

for (const permissionMode of ["default", "bypassPermissions"] as const) {
  test(`write_file rejects writes into .git through a directory symlink (${permissionMode})`, async () => {
    await withTempDirs(async (workspace) => {
      await mkdir(join(workspace, ".git"));
      await symlink(".git", join(workspace, "repo-internals"));
      const ctx = context(workspace, permissionMode);

      const permission = checkFilesystemWritePermission("write_file", "repo-internals/HEAD", ctx);
      assert.equal(permission.type, "deny");

      const validation = await createWriteFileTool().validateInput!({
        file_path: "repo-internals/HEAD",
        content: "clobbered\n",
      }, ctx);
      assert.equal(validation.ok, false);

      await assert.rejects(
        createWriteFileTool().execute({ file_path: "repo-internals/HEAD", content: "clobbered\n" }, ctx),
        /not allowed/,
      );
      await assert.rejects(readFile(join(workspace, ".git", "HEAD"), "utf8"), { code: "ENOENT" });
    });
  });
}

test("write_file rejects writes into .git through a file symlink", async () => {
  await withTempDirs(async (workspace) => {
    await mkdir(join(workspace, ".git"));
    await writeFile(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n");
    await symlink(join(".git", "HEAD"), join(workspace, "head-link"));
    const ctx = context(workspace);

    assert.equal(checkFilesystemWritePermission("write_file", "head-link", ctx).type, "deny");
    await assert.rejects(
      createWriteFileTool().execute({ file_path: "head-link", content: "clobbered\n" }, ctx),
      /not allowed/,
    );
    assert.equal(await readFile(join(workspace, ".git", "HEAD"), "utf8"), "ref: refs/heads/main\n");
  });
});

test("write_file rejects writes into .git through a dangling file symlink", async () => {
  await withTempDirs(async (workspace) => {
    await mkdir(join(workspace, ".git"));
    await symlink(join(".git", "config"), join(workspace, "config-link"));
    const ctx = context(workspace);

    assert.equal(checkFilesystemWritePermission("write_file", "config-link", ctx).type, "deny");
    await assert.rejects(
      createWriteFileTool().execute({ file_path: "config-link", content: "clobbered\n" }, ctx),
      /not allowed/,
    );
    await assert.rejects(readFile(join(workspace, ".git", "config"), "utf8"), { code: "ENOENT" });
  });
});

test("edit_file rejects edits into .git through a directory symlink", async () => {
  await withTempDirs(async (workspace) => {
    await mkdir(join(workspace, ".git"));
    await symlink(".git", join(workspace, "repo-internals"));
    const ctx = context(workspace);

    assert.equal(checkFilesystemWritePermission("edit_file", "repo-internals/HEAD", ctx).type, "deny");
    await assert.rejects(
      createEditFileTool().execute({
        file_path: "repo-internals/HEAD",
        old_string: "",
        new_string: "clobbered\n",
      }, ctx),
      /not allowed/,
    );
    await assert.rejects(readFile(join(workspace, ".git", "HEAD"), "utf8"), { code: "ENOENT" });
  });
});

test("write_file asks before writing outside the workspace through a directory symlink", async () => {
  await withTempDirs(async (workspace, outside) => {
    await symlink(outside, join(workspace, "escape"));
    const ctx = context(workspace);

    const permission = checkFilesystemWritePermission("write_file", "escape/created.txt", ctx);
    assert.equal(permission.type, "ask");

    await assert.rejects(
      createWriteFileTool().execute({ file_path: "escape/created.txt", content: "outside\n" }, ctx),
      /outside the PilotDeck workspace/,
    );
    await assert.rejects(readFile(join(outside, "created.txt"), "utf8"), { code: "ENOENT" });
  });
});

test("write_file still writes through symlinks that stay inside the workspace", async () => {
  await withTempDirs(async (workspace) => {
    await mkdir(join(workspace, "real-dir"));
    await symlink("real-dir", join(workspace, "alias-dir"));
    const ctx = context(workspace);

    assert.equal(checkFilesystemWritePermission("write_file", "alias-dir/new.txt", ctx).type, "passthrough");
    await createWriteFileTool().execute({ file_path: "alias-dir/new.txt", content: "inside\n" }, ctx);
    assert.equal(await readFile(join(workspace, "real-dir", "new.txt"), "utf8"), "inside\n");
  });
});

test("a workspace-scoped write_file allow rule does not cover symlinks that escape the workspace", async () => {
  await withTempDirs(async (workspace, outside) => {
    await mkdir(join(workspace, "real-dir"));
    await symlink("real-dir", join(workspace, "alias-dir"));
    await symlink(outside, join(workspace, "escape"));
    const { permissionContext } = context(workspace);
    const rule = { source: "session" as const, behavior: "allow" as const, toolName: "write_file" };

    assert.equal(matchPermissionRule(rule, "write_file", { file_path: "alias-dir/new.txt" }, permissionContext), true);
    assert.equal(matchPermissionRule(rule, "write_file", { file_path: "escape/new.txt" }, permissionContext), false);
  });
});
