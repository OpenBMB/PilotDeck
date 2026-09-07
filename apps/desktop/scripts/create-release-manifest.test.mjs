import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptsRoot = dirname(fileURLToPath(import.meta.url));

test("release manifest records separate macOS architecture installers", () => {
  const assetsDir = mkdtempSync(join(tmpdir(), "pilotdeck-release-assets-"));
  try {
    for (const name of [
      "PilotDeck-2026.903.0-mac-arm64.dmg",
      "PilotDeck-2026.903.0-mac-x64.dmg",
      "PilotDeck-2026.903.0-win-x64-setup.exe",
    ]) {
      writeFileSync(resolve(assetsDir, name), name);
    }

    const result = spawnSync(
      process.execPath,
      [resolve(scriptsRoot, "create-release-manifest.mjs"), assetsDir],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PILOTDECK_DESKTOP_VERSION: "2026.903.0",
          PILOTDECK_DESKTOP_RELEASE_TAG: "desktop-v2026.09.03",
          PILOTDECK_DESKTOP_RELEASE_DATE: "2026-09-03",
          PILOTDECK_DESKTOP_BUILD_TIME: "2026-09-03T02:00:00+08:00",
          PILOTDECK_COMMIT_SHA: "0123456789abcdef",
          PILOTDECK_UPDATE_REPOSITORY: "OpenBMB/PilotDeck",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const manifest = JSON.parse(readFileSync(resolve(assetsDir, "desktop-release.json"), "utf8"));
    assert.deepEqual(
      manifest.assets
        .map(({ name, platform, arch }) => ({ name, platform, arch }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      [
        { name: "PilotDeck-2026.903.0-mac-arm64.dmg", platform: "darwin", arch: "arm64" },
        { name: "PilotDeck-2026.903.0-mac-x64.dmg", platform: "darwin", arch: "x64" },
        { name: "PilotDeck-2026.903.0-win-x64-setup.exe", platform: "win32", arch: "x64" },
      ],
    );
  } finally {
    rmSync(assetsDir, { recursive: true, force: true });
  }
});
