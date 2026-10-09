import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createEditFileTool } from "../../src/tool/builtin/editFile.js";
import { createWriteFileTool } from "../../src/tool/builtin/writeFile.js";
import { checkFilesystemWritePermission } from "../../src/tool/builtin/filesystem/writePermissions.js";
import type { PermissionMode, PermissionRule } from "../../src/permission/index.js";
import { matchPermissionRule } from "../../src/permission/policy/matchPermissionRule.js";
import { PermissionRuntime } from "../../src/permission/decision/PermissionRuntime.js";
import { resolveRealWritePath } from "../../src/tool/builtin/filesystem/pathSafety.js";

function context(cwd: string, permissionMode: PermissionMode = "default") {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd,
    permissionMode,
    permissionContext: {
      mode: permissionMode,
      cwd,
      additionalWorkingDirectories: [] as string[],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [] as PermissionRule[], deny: [], ask: [] },
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

for (const absoluteTarget of [false, true]) {
  for (const targetKind of ["outside", ".git"] as const) {
    test(`write_file rejects an existing ${targetKind} target behind a symlink and .. (${absoluteTarget ? "absolute" : "relative"})`, async () => {
      await withTempDirs(async (workspace, outside) => {
        const targetRoot = targetKind === "outside" ? outside : join(workspace, ".git");
        await mkdir(join(targetRoot, "subdir"), { recursive: true });
        await symlink(join(targetRoot, "subdir"), join(workspace, "dirlink"));
        // Both destinations exist so the incorrect normalized path also resolves.
        await writeFile(join(workspace, "victim.txt"), "workspace\n");
        await writeFile(join(targetRoot, "victim.txt"), "protected\n");
        await symlink(`${absoluteTarget ? `${workspace}/` : ""}dirlink/../victim.txt`, join(workspace, "filelink"));
        const ctx = context(workspace);

        assert.equal(resolveRealWritePath(join(workspace, "filelink")), join(await realpath(targetRoot), "victim.txt"));
        assert.equal(checkFilesystemWritePermission("write_file", "filelink", ctx).type, targetKind === "outside" ? "ask" : "deny");
        assert.equal(matchPermissionRule(
          { source: "session", behavior: "allow", toolName: "write_file" },
          "write_file", { file_path: "filelink" }, ctx.permissionContext,
        ), targetKind !== "outside");
        const tool = createWriteFileTool();
        assert.equal((await new PermissionRuntime().decide(tool, { file_path: "filelink", content: "clobbered\n" }, ctx, "call")).type,
          targetKind === "outside" ? "ask" : "deny");
        await assert.rejects(tool.execute({ file_path: "filelink", content: "clobbered\n" }, ctx),
          targetKind === "outside" ? /outside the PilotDeck workspace/ : /not allowed/);
        assert.equal(await readFile(join(targetRoot, "victim.txt"), "utf8"), "protected\n");
        assert.equal(await readFile(join(workspace, "victim.txt"), "utf8"), "workspace\n");
      });
    });
  }

  test(`write_file asks for a dangling symlink target with an intermediate symlink and .. (${absoluteTarget ? "absolute" : "relative"})`, async () => {
    await withTempDirs(async (workspace, outside) => {
      await mkdir(join(outside, "subdir"));
      await symlink(join(outside, "subdir"), join(workspace, "dirlink"));
      const target = `${absoluteTarget ? `${workspace}/` : ""}dirlink/../created.txt`;
      await symlink(target, join(workspace, "filelink"));
      const ctx = context(workspace);

      assert.equal(resolveRealWritePath(join(workspace, "filelink")), join(await realpath(outside), "created.txt"));
      assert.equal(checkFilesystemWritePermission("write_file", "filelink", ctx).type, "ask");
      assert.equal(matchPermissionRule(
        { source: "session", behavior: "allow", toolName: "write_file" },
        "write_file", { file_path: "filelink" }, ctx.permissionContext,
      ), false);
      await assert.rejects(
        createWriteFileTool().execute({ file_path: "filelink", content: "outside\n" }, ctx),
        /outside the PilotDeck workspace/,
      );
      await assert.rejects(readFile(join(outside, "created.txt")), { code: "ENOENT" });
    });
  });
}

for (const permissionMode of ["default", "bypassPermissions"] as const) {
  test(`write_file denies a dangling symlink into .git through an intermediate symlink and .. (${permissionMode})`, async () => {
    await withTempDirs(async (workspace) => {
      await mkdir(join(workspace, ".git", "subdir"), { recursive: true });
      await symlink(join(".git", "subdir"), join(workspace, "dirlink"));
      await symlink("dirlink/../config", join(workspace, "filelink"));
      const ctx = context(workspace, permissionMode);
      assert.equal(checkFilesystemWritePermission("write_file", "filelink", ctx).type, "deny");
      await assert.rejects(
        createWriteFileTool().execute({ file_path: "filelink", content: "clobbered\n" }, ctx),
        /not allowed/,
      );
      await assert.rejects(readFile(join(workspace, ".git", "config")), { code: "ENOENT" });
    });
  });
}

test("write_file allows a dangling symlink with .. that stays inside the workspace", async () => {
  await withTempDirs(async (workspace) => {
    await mkdir(join(workspace, "real", "subdir"), { recursive: true });
    await symlink(join("real", "subdir"), join(workspace, "dirlink"));
    await symlink("dirlink/../created.txt", join(workspace, "filelink"));
    const ctx = context(workspace);
    assert.equal(resolveRealWritePath(join(workspace, "filelink")), join(await realpath(workspace), "real", "created.txt"));
    assert.equal(checkFilesystemWritePermission("write_file", "filelink", ctx).type, "passthrough");
    await createWriteFileTool().execute({ file_path: "filelink", content: "inside\n" }, ctx);
    assert.equal(await readFile(join(workspace, "real", "created.txt"), "utf8"), "inside\n");
  });
});

for (const toolName of ["write_file", "edit_file"] as const) {
  for (const permissionMode of ["default", "bypassPermissions"] as const) {
    for (const cyclicDirectory of [".git", "node_modules", "dist"]) {
      test(`${toolName} can write an unrelated file with a cyclic ${cyclicDirectory} link (${permissionMode})`, async () => {
        await withTempDirs(async (workspace) => {
          await symlink(cyclicDirectory, join(workspace, cyclicDirectory));
          const ctx = context(workspace, permissionMode);
          const tool = toolName === "write_file" ? createWriteFileTool() : createEditFileTool();
          const input = { file_path: "src/new.txt", content: "inside\n", old_string: "", new_string: "inside\n" };

          assert.equal(checkFilesystemWritePermission(toolName, input.file_path, ctx).type, "passthrough");
          assert.equal((await tool.validateInput!(input, ctx)).ok, true);
          await tool.execute(input, ctx);
          assert.equal(await readFile(join(workspace, "src", "new.txt"), "utf8"), "inside\n");
        });
      });
    }

    test(`${toolName} denies a cyclic write target without throwing (${permissionMode})`, async () => {
      await withTempDirs(async (workspace) => {
        await symlink("loop-b", join(workspace, "loop-a"));
        await symlink("loop-a", join(workspace, "loop-b"));
        const ctx = context(workspace, permissionMode);
        const tool = toolName === "write_file" ? createWriteFileTool() : createEditFileTool();
        const input = { file_path: "loop-a/new.txt", content: "blocked\n", old_string: "", new_string: "blocked\n" };
        ctx.permissionContext.rules.allow = [{ source: "session", behavior: "allow", toolName }];

        assert.equal(resolveRealWritePath(join(workspace, input.file_path)), undefined);
        assert.equal(matchPermissionRule(ctx.permissionContext.rules.allow[0]!, toolName, input, ctx.permissionContext), false);
        assert.equal(checkFilesystemWritePermission(toolName, input.file_path, ctx).type, "deny");
        assert.equal((await new PermissionRuntime().decide(tool, input, ctx, "call")).type, "deny");
        assert.equal((await tool.validateInput!(input, ctx)).ok, false);
        await assert.rejects(tool.execute(input, ctx), /too many symbolic links/);
      });
    });

    for (const protectedDirectory of [".git", "node_modules", "dist"]) {
      for (const linkKind of ["directory", "dangling-file"] as const) {
        test(`${toolName} denies a new file through a differently cased ${protectedDirectory} ${linkKind} link (${permissionMode})`, async (t) => {
          await withTempDirs(async (workspace) => {
            const protectedRoot = join(workspace, protectedDirectory);
            await mkdir(protectedRoot);
            const differentlyCasedDirectory = protectedDirectory.toUpperCase();
            try {
              await realpath(join(workspace, differentlyCasedDirectory));
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
              t.skip("Requires a case-insensitive filesystem.");
              return;
            }
            await symlink(
              linkKind === "directory" ? differentlyCasedDirectory : join(differentlyCasedDirectory, "new.txt"),
              join(workspace, "alias"),
            );
            const ctx = context(workspace, permissionMode);
            const input = {
              file_path: linkKind === "directory" ? "alias/new.txt" : "alias",
              content: "clobbered\n",
              old_string: "",
              new_string: "clobbered\n",
            };
            const tool = toolName === "write_file" ? createWriteFileTool() : createEditFileTool();

            assert.equal(resolveRealWritePath(join(workspace, input.file_path)), join(await realpath(protectedRoot), "new.txt"));
            assert.equal(checkFilesystemWritePermission(toolName, input.file_path, ctx).type, "deny");
            assert.equal((await new PermissionRuntime().decide(tool, input, ctx, "call")).type, "deny");
            assert.equal((await tool.validateInput!(input, ctx)).ok, false);
            await assert.rejects(tool.execute(input, {
              ...ctx,
              currentPermissionDecision: {
                type: "allow",
                reason: { type: "mode", mode: permissionMode, message: "Explicitly allowed for this test." },
              },
            }), /not allowed/);
            await assert.rejects(readFile(join(protectedRoot, "new.txt")), { code: "ENOENT" });
          });
        });
      }

      test(`${toolName} denies a nonexistent target of a ${protectedDirectory} symlink (${permissionMode})`, async () => {
        await withTempDirs(async (workspace, outside) => {
          const ctx = context(workspace, permissionMode);
          ctx.permissionContext.additionalWorkingDirectories = [outside];
          const protectedTarget = join(outside, "metadata");
          await symlink(protectedTarget, join(workspace, protectedDirectory));
          const input = {
            file_path: join(protectedTarget, "new.txt"),
            content: "clobbered\n",
            old_string: "",
            new_string: "clobbered\n",
          };
          const tool = toolName === "write_file" ? createWriteFileTool() : createEditFileTool();

          assert.equal(checkFilesystemWritePermission(toolName, input.file_path, ctx).type, "deny");
          assert.equal((await new PermissionRuntime().decide(tool, input, ctx, "call")).type, "deny");
          assert.equal((await tool.validateInput!(input, ctx)).ok, false);
          await assert.rejects(tool.execute(input, {
            ...ctx,
            currentPermissionDecision: {
              type: "allow",
              reason: { type: "mode", mode: permissionMode, message: "Explicitly allowed for this test." },
            },
          }), /not allowed/);
          await assert.rejects(readFile(join(workspace, protectedDirectory, "new.txt")), { code: "ENOENT" });
        });
      });

      for (const targetKind of ["additional-root", "external-protected-symlink"] as const) {
        test(`${toolName} denies ${protectedDirectory} via an alias to ${targetKind} (${permissionMode})`, async () => {
          await withTempDirs(async (workspace, outside) => {
            const ctx = context(workspace, permissionMode);
            let protectedTarget: string;
            if (targetKind === "additional-root") {
              ctx.permissionContext.additionalWorkingDirectories = [outside];
              protectedTarget = join(outside, protectedDirectory);
              await mkdir(protectedTarget);
              await symlink(protectedTarget, join(workspace, "alias"));
            } else {
              protectedTarget = outside;
              await symlink(outside, join(workspace, protectedDirectory));
              await symlink(protectedDirectory, join(workspace, "alias"));
            }
            const input = { file_path: "alias/new.txt", content: "clobbered\n", old_string: "", new_string: "clobbered\n" };
            const tool = toolName === "write_file" ? createWriteFileTool() : createEditFileTool();

            assert.equal(checkFilesystemWritePermission(toolName, input.file_path, ctx).type, "deny");
            assert.equal((await new PermissionRuntime().decide(tool, input, ctx, "call")).type, "deny");
            await assert.rejects(tool.execute(input, {
              ...ctx,
              currentPermissionDecision: {
                type: "allow",
                reason: { type: "mode", mode: permissionMode, message: "Explicitly allowed for this test." },
              },
            }), /not allowed/);
            await assert.rejects(readFile(join(protectedTarget, "new.txt")), { code: "ENOENT" });
          });
        });
      }
    }

    test(`${toolName} denies an alias through a dangling protected-directory symlink (${permissionMode})`, async () => {
      await withTempDirs(async (workspace) => {
        await symlink("metadata", join(workspace, ".git"));
        await symlink(".git", join(workspace, "alias"));
        const ctx = context(workspace, permissionMode);
        const input = { file_path: "alias", content: "clobbered\n", old_string: "", new_string: "clobbered\n" };
        const tool = toolName === "write_file" ? createWriteFileTool() : createEditFileTool();

        assert.equal(checkFilesystemWritePermission(toolName, input.file_path, ctx).type, "deny");
        await assert.rejects(tool.execute(input, ctx), /not allowed/);
        await assert.rejects(readFile(join(workspace, "metadata")), { code: "ENOENT" });
      });
    });
  }

  for (const behavior of ["deny", "ask"] as const) {
    const permissionMode = behavior === "deny" ? "bypassPermissions" : "default";
    test(`${toolName} retains ${behavior} rules for a workspace symlink escape (${permissionMode})`, async () => {
      await withTempDirs(async (workspace, outside) => {
        await symlink(outside, join(workspace, "escape"));
        const ctx = context(workspace, permissionMode);
        const rule = { source: "user" as const, behavior, toolName };
        const input = { file_path: "escape/new.txt", content: "outside\n", old_string: "", new_string: "outside\n" };
        assert.equal(matchPermissionRule(rule, toolName, input, ctx.permissionContext), true);
        const rules = { allow: [], deny: behavior === "deny" ? [rule] : [], ask: behavior === "ask" ? [rule] : [] };
        const tool = toolName === "write_file" ? createWriteFileTool() : createEditFileTool();
        const decision = await new PermissionRuntime().decide(tool, input, {
          ...ctx, permissionContext: { ...ctx.permissionContext, rules },
        }, "call");
        assert.equal(decision.type, behavior);
        assert.equal(decision.reason.type, "rule");
      });
    });
  }
}
