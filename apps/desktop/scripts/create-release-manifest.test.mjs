import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptsRoot = dirname(fileURLToPath(import.meta.url));

test("unified release manifest links the source tag and checksummed installers", () => {
  const assetsDir = mkdtempSync(join(tmpdir(), "pilotdeck-release-assets-"));
  try {
    for (const name of [
      "PilotDeck-2026.903.0-mac-arm64.dmg",
      "PilotDeck-2026.903.0-mac-x64.dmg",
      "PilotDeck-2026.903.0-mac-arm64.zip",
      "PilotDeck-2026.903.0-mac-x64.zip",
      "latest-arm64-mac.yml",
      "latest-x64-mac.yml",
      "latest-x64.yml",
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
          PILOTDECK_RELEASE_VERSION: "2026.903.0",
          PILOTDECK_RELEASE_TAG: "v2026.09.03",
          PILOTDECK_RELEASE_DATE: "2026-09-03",
          PILOTDECK_RELEASE_BUILD_TIME: "2026-09-03T02:00:00+08:00",
          PILOTDECK_COMMIT_SHA: "0123456789abcdef",
          PILOTDECK_UPDATE_REPOSITORY: "OpenBMB/PilotDeck",
        },
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const manifest = JSON.parse(readFileSync(resolve(assetsDir, "release.json"), "utf8"));
    assert.equal(manifest.tag, "v2026.09.03");
    assert.equal(manifest.version, "2026.903.0");
    assert.equal(manifest.sourceSha, "0123456789abcdef");
    assert.equal(manifest.repository, "OpenBMB/PilotDeck");
    assert.equal(manifest.date, "2026-09-03");
    const checksums = readFileSync(resolve(assetsDir, "SHA256SUMS.txt"), "utf8");
    for (const asset of manifest.assets) {
      const contents = readFileSync(resolve(assetsDir, asset.name));
      const hash = createHash("sha256").update(contents).digest("hex");
      assert.equal(asset.sha256, hash);
      assert.equal(asset.sha512, createHash("sha512").update(contents).digest("base64"));
      assert.equal(asset.size, contents.length);
      assert.ok(checksums.includes(`${hash}  ${asset.name}\n`));
    }
    assert.deepEqual(
      manifest.assets
        .map(({ name, platform, arch }) => ({ name, platform, arch }))
        .sort((left, right) => left.name.localeCompare(right.name)),
      [
        { name: "latest-arm64-mac.yml", platform: "darwin", arch: "arm64" },
        { name: "latest-x64-mac.yml", platform: "darwin", arch: "x64" },
        { name: "latest-x64.yml", platform: "unknown", arch: "x64" },
        { name: "PilotDeck-2026.903.0-mac-arm64.zip", platform: "darwin", arch: "arm64" },
        { name: "PilotDeck-2026.903.0-mac-x64.zip", platform: "darwin", arch: "x64" },
        { name: "PilotDeck-2026.903.0-mac-arm64.dmg", platform: "darwin", arch: "arm64" },
        { name: "PilotDeck-2026.903.0-mac-x64.dmg", platform: "darwin", arch: "x64" },
        { name: "PilotDeck-2026.903.0-win-x64-setup.exe", platform: "win32", arch: "x64" },
      ].sort((left, right) => left.name.localeCompare(right.name)),
    );
  } finally {
    rmSync(assetsDir, { recursive: true, force: true });
  }
});
