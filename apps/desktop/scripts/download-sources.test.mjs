import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  isChinaMirrorPreset,
  joinUrl,
  resolveDownloadSource,
} from "./download-sources.mjs";
import {
  buildPlaywrightBrowserPlan,
  installMirroredPlaywrightBrowsers,
  resolvePlaywrightBrowserSet,
  resolvePlaywrightInstallMode,
  resolvePlaywrightMirrorMode,
} from "./download-playwright-browsers.mjs";

const fakeBrowsersJson = {
  browsers: [
    {
      name: "chromium",
      revision: "1224",
      browserVersion: "149.0.7827.3",
    },
    {
      name: "chromium-headless-shell",
      revision: "1224",
      browserVersion: "149.0.7827.3",
    },
    {
      name: "ffmpeg",
      revision: "1011",
    },
  ],
};

test("joinUrl trims duplicate separators", () => {
  assert.equal(joinUrl("https://example.test/root/", "/a/", "b.zip"), "https://example.test/root/a/b.zip");
});

test("resolveDownloadSource prefers archive over explicit URL and base URL", () => {
  const source = resolveDownloadSource({
    env: {
      PILOTDECK_DESKTOP_DOWNLOAD_MIRROR: "china",
      ARCHIVE: "/cache/pkg.zip",
      URL: "https://example.test/pkg.zip",
      BASE: "https://mirror.test",
    },
    archiveEnv: "ARCHIVE",
    urlEnv: "URL",
    baseEnv: "BASE",
    chinaBaseUrl: "https://china.test",
    officialBaseUrl: "https://official.test",
    relativePath: "v1/pkg.zip",
  });

  assert.equal(source.type, "archive");
  assert.equal(source.path, "/cache/pkg.zip");
  assert.equal(source.source, "ARCHIVE");
});

test("resolveDownloadSource falls back to china preset base", () => {
  const source = resolveDownloadSource({
    env: { PILOTDECK_DESKTOP_DOWNLOAD_MIRROR: "china" },
    archiveEnv: "ARCHIVE",
    urlEnv: "URL",
    baseEnv: "BASE",
    chinaBaseUrl: "https://china.test/downloads",
    officialBaseUrl: "https://official.test/downloads",
    relativePath: "v1/pkg.zip",
  });

  assert.equal(isChinaMirrorPreset({ PILOTDECK_DESKTOP_DOWNLOAD_MIRROR: "china" }), true);
  assert.equal(source.type, "url");
  assert.equal(source.url, "https://china.test/downloads/v1/pkg.zip");
  assert.equal(source.source, "china-preset");
});

test("resolveDownloadSource uses explicit base before preset", () => {
  const source = resolveDownloadSource({
    env: {
      PILOTDECK_DESKTOP_DOWNLOAD_MIRROR: "china",
      BASE: "https://internal.test/root/",
    },
    archiveEnv: "ARCHIVE",
    urlEnv: "URL",
    baseEnv: "BASE",
    chinaBaseUrl: "https://china.test",
    officialBaseUrl: "https://official.test",
    relativePath: "/v1/pkg.zip",
  });

  assert.equal(source.url, "https://internal.test/root/v1/pkg.zip");
  assert.equal(source.source, "BASE");
});

test("resolvePlaywrightMirrorMode follows explicit mirror and china preset", () => {
  assert.equal(resolvePlaywrightMirrorMode({}), "official");
  assert.equal(resolvePlaywrightMirrorMode({ PILOTDECK_DESKTOP_DOWNLOAD_MIRROR: "china" }), "npmmirror");
  assert.equal(resolvePlaywrightMirrorMode({ PILOTDECK_DESKTOP_PLAYWRIGHT_MIRROR: "npmmirror" }), "npmmirror");
  assert.equal(resolvePlaywrightMirrorMode({ PILOTDECK_DESKTOP_PLAYWRIGHT_ARCHIVE_DIR: "/cache" }), "npmmirror");
});

test("resolvePlaywrightBrowserSet defaults to browser-only and accepts full", () => {
  assert.equal(resolvePlaywrightBrowserSet({}), "browser-only");
  assert.equal(resolvePlaywrightBrowserSet({ PILOTDECK_DESKTOP_PLAYWRIGHT_BROWSER_SET: "minimal" }), "browser-only");
  assert.equal(resolvePlaywrightBrowserSet({ PILOTDECK_DESKTOP_PLAYWRIGHT_BROWSER_SET: "browser" }), "browser-only");
  assert.equal(resolvePlaywrightBrowserSet({ PILOTDECK_DESKTOP_PLAYWRIGHT_BROWSER_SET: "full" }), "full");
  assert.throws(
    () => resolvePlaywrightBrowserSet({ PILOTDECK_DESKTOP_PLAYWRIGHT_BROWSER_SET: "everything" }),
    /Unsupported desktop Playwright browser set/,
  );
});

test("resolvePlaywrightInstallMode defaults to lazy and accepts preinstall", () => {
  assert.equal(resolvePlaywrightInstallMode({}), "lazy");
  assert.equal(resolvePlaywrightInstallMode({ PILOTDECK_DESKTOP_PLAYWRIGHT_INSTALL_MODE: "lazy" }), "lazy");
  assert.equal(resolvePlaywrightInstallMode({ PILOTDECK_DESKTOP_PLAYWRIGHT_INSTALL_MODE: "preinstall" }), "preinstall");
  assert.throws(
    () => resolvePlaywrightInstallMode({ PILOTDECK_DESKTOP_PLAYWRIGHT_INSTALL_MODE: "always" }),
    /Unsupported desktop Playwright install mode/,
  );
});

test("buildPlaywrightBrowserPlan defaults to lazy with no browser archives", () => {
  const plan = buildPlaywrightBrowserPlan({
    browsersJson: fakeBrowsersJson,
    platform: "darwin",
    arch: "arm64",
    macMajor: 15,
    env: {},
  });

  assert.deepEqual(plan, []);
});

test("buildPlaywrightBrowserPlan maps preinstall mac arm64 browser-only archive", () => {
  const plan = buildPlaywrightBrowserPlan({
    browsersJson: fakeBrowsersJson,
    platform: "darwin",
    arch: "arm64",
    macMajor: 15,
    env: { PILOTDECK_DESKTOP_PLAYWRIGHT_INSTALL_MODE: "preinstall" },
  });

  assert.deepEqual(plan.map((item) => item.directoryName), [
    "chromium-1224",
  ]);
  assert.equal(
    plan[0].url,
    "https://cdn.npmmirror.com/binaries/chrome-for-testing/149.0.7827.3/mac-arm64/chrome-mac-arm64.zip",
  );
});

test("buildPlaywrightBrowserPlan maps full mac arm64 npmmirror archives", () => {
  const plan = buildPlaywrightBrowserPlan({
    browsersJson: fakeBrowsersJson,
    platform: "darwin",
    arch: "arm64",
    macMajor: 15,
    env: {
      PILOTDECK_DESKTOP_PLAYWRIGHT_INSTALL_MODE: "preinstall",
      PILOTDECK_DESKTOP_PLAYWRIGHT_BROWSER_SET: "full",
    },
  });

  assert.deepEqual(plan.map((item) => item.directoryName), [
    "chromium-1224",
    "chromium_headless_shell-1224",
    "ffmpeg-1011",
  ]);
  assert.equal(
    plan[1].url,
    "https://cdn.npmmirror.com/binaries/chrome-for-testing/149.0.7827.3/mac-arm64/chrome-headless-shell-mac-arm64.zip",
  );
  assert.equal(
    plan[2].url,
    "https://cdn.npmmirror.com/binaries/playwright/builds/ffmpeg/1011/ffmpeg-mac-arm64.zip",
  );
});

test("buildPlaywrightBrowserPlan maps preinstall Windows x64 browser-only archive", () => {
  const plan = buildPlaywrightBrowserPlan({
    browsersJson: fakeBrowsersJson,
    platform: "win32",
    arch: "x64",
    env: { PILOTDECK_DESKTOP_PLAYWRIGHT_INSTALL_MODE: "preinstall" },
  });

  assert.equal(
    plan[0].url,
    "https://cdn.npmmirror.com/binaries/chrome-for-testing/149.0.7827.3/win64/chrome-win64.zip",
  );
  assert.deepEqual(plan.map((item) => item.archiveName), ["chrome-win64.zip"]);
});

test("installMirroredPlaywrightBrowsers installs from local archive dir", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-playwright-archives-"));
  try {
    const runtimeRoot = resolve(root, "runtime");
    const playwrightCoreRoot = resolve(runtimeRoot, "node_modules", "playwright-core");
    const archiveDir = resolve(root, "archives");
    mkdirSync(playwrightCoreRoot, { recursive: true });
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(
      resolve(playwrightCoreRoot, "browsers.json"),
      `${JSON.stringify(fakeBrowsersJson, null, 2)}\n`,
    );

    const plan = buildPlaywrightBrowserPlan({
      browsersJson: fakeBrowsersJson,
      platform: process.platform,
      arch: process.arch,
      env: { PILOTDECK_DESKTOP_PLAYWRIGHT_INSTALL_MODE: "preinstall" },
    });
    for (const item of plan) {
      createZipArchive(resolve(archiveDir, item.archiveName), item.name);
    }

    await installMirroredPlaywrightBrowsers(runtimeRoot, {
      PILOTDECK_DESKTOP_PLAYWRIGHT_MIRROR: "npmmirror",
      PILOTDECK_DESKTOP_PLAYWRIGHT_ARCHIVE_DIR: archiveDir,
      PILOTDECK_DESKTOP_PLAYWRIGHT_INSTALL_MODE: "preinstall",
    });

    for (const item of plan) {
      assert.equal(
        existsSync(resolve(playwrightCoreRoot, ".local-browsers", item.directoryName, "INSTALLATION_COMPLETE")),
        true,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installMirroredPlaywrightBrowsers skips already installed browsers", async () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-playwright-existing-"));
  try {
    const runtimeRoot = resolve(root, "runtime");
    const playwrightCoreRoot = resolve(runtimeRoot, "node_modules", "playwright-core");
    const browsersRoot = resolve(playwrightCoreRoot, ".local-browsers");
    const archiveDir = resolve(root, "empty-archives");
    mkdirSync(browsersRoot, { recursive: true });
    mkdirSync(archiveDir, { recursive: true });
    writeFileSync(
      resolve(playwrightCoreRoot, "browsers.json"),
      `${JSON.stringify(fakeBrowsersJson, null, 2)}\n`,
    );

    const plan = buildPlaywrightBrowserPlan({
      browsersJson: fakeBrowsersJson,
      platform: process.platform,
      arch: process.arch,
      env: { PILOTDECK_DESKTOP_PLAYWRIGHT_INSTALL_MODE: "preinstall" },
    });
    for (const item of plan) {
      const browserDir = resolve(browsersRoot, item.directoryName);
      mkdirSync(browserDir, { recursive: true });
      writeFileSync(resolve(browserDir, "INSTALLATION_COMPLETE"), "already here");
    }

    await installMirroredPlaywrightBrowsers(runtimeRoot, {
      PILOTDECK_DESKTOP_PLAYWRIGHT_MIRROR: "npmmirror",
      PILOTDECK_DESKTOP_PLAYWRIGHT_ARCHIVE_DIR: archiveDir,
      PILOTDECK_DESKTOP_PLAYWRIGHT_INSTALL_MODE: "preinstall",
    });

    for (const item of plan) {
      assert.equal(
        existsSync(resolve(browsersRoot, item.directoryName, "INSTALLATION_COMPLETE")),
        true,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function createZipArchive(archivePath, label) {
  const payloadDir = mkdtempSync(join(tmpdir(), "pilotdeck-playwright-payload-"));
  try {
    writeFileSync(resolve(payloadDir, `${label}.txt`), label);
    const result = spawnSync("tar", ["-acf", archivePath, "-C", payloadDir, "."], {
      stdio: "ignore",
      windowsHide: process.platform === "win32",
      env: { ...process.env, LANG: "C", LC_ALL: "C" },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`failed to create zip archive: ${archivePath}`);
  } finally {
    rmSync(payloadDir, { recursive: true, force: true });
  }
}
