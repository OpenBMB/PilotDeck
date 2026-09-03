import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import {
  ensureWritableDirectory,
  isDesktopRuntimeProjectRoot,
  isVirtualProjectRoot,
  resolveRuntimeArtifactFallbackDir,
} from "../../src/pilot/index.js";

test("isDesktopRuntimeProjectRoot recognizes desktop resources/runtime only in desktop mode", () => {
  const root = join("C:\\Program Files", "PilotDeck", "resources", "runtime");

  assert.equal(
    isDesktopRuntimeProjectRoot({
      projectRoot: root,
      env: { PILOTDECK_DESKTOP: "1" },
    }),
    true,
  );
  assert.equal(
    isDesktopRuntimeProjectRoot({
      projectRoot: root,
      env: {},
    }),
    false,
  );
});

test("isVirtualProjectRoot treats pilotHome and desktop runtime roots as non-projects", () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-virtual-root-"));
  try {
    const pilotHome = join(root, "pilot-home");
    const runtimeRoot = join(root, "Program Files", "PilotDeck", "resources", "runtime");

    assert.equal(isVirtualProjectRoot({ projectRoot: pilotHome, pilotHome }), true);
    assert.equal(
      isVirtualProjectRoot({
        projectRoot: runtimeRoot,
        pilotHome,
        env: { PILOTDECK_DESKTOP: "1" },
      }),
      true,
    );
    assert.equal(
      isVirtualProjectRoot({
        projectRoot: join(root, "repo"),
        pilotHome,
        env: { PILOTDECK_DESKTOP: "1" },
      }),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureWritableDirectory falls back when preferred directory is not writable", () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-writable-dir-"));
  const lockedParent = join(root, "locked");
  const preferredDir = join(lockedParent, "artifact");
  const fallbackDir = resolveRuntimeArtifactFallbackDir({
    pilotHome: join(root, "pilot-home"),
    purpose: "plans",
    key: "chat/id",
  });
  try {
    chmodSync(root, 0o700);
    mkdirSync(lockedParent);
    chmodSync(lockedParent, 0o500);
    const result = ensureWritableDirectory({
      preferredDir,
      fallbackDir,
      purpose: "plans",
    });

    assert.equal(result.usedFallback, true);
    assert.equal(result.dir, resolve(fallbackDir));
    assert.ok(!relative(join(root, "pilot-home"), result.dir).startsWith(".."));
  } finally {
    chmodSync(root, 0o700);
    try {
      chmodSync(lockedParent, 0o700);
    } catch {
      // The locked parent may not exist if setup failed early.
    }
    rmSync(root, { recursive: true, force: true });
  }
});
