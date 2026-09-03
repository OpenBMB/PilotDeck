#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { downloadToFile, isChinaMirrorPreset, joinUrl, trimUrlBase } from "./download-sources.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const DEFAULT_CHROME_BASE_URL = "https://cdn.npmmirror.com/binaries/chrome-for-testing";
const DEFAULT_FFMPEG_BASE_URL = "https://cdn.npmmirror.com/binaries/playwright";
const DEFAULT_BROWSER_SET = "browser-only";
const DEFAULT_INSTALL_MODE = "lazy";

export function resolvePlaywrightMirrorMode(env = process.env) {
  if (env.PILOTDECK_DESKTOP_PLAYWRIGHT_ARCHIVE_DIR?.trim()) return "npmmirror";
  const explicit = env.PILOTDECK_DESKTOP_PLAYWRIGHT_MIRROR?.trim().toLowerCase();
  if (explicit) return explicit;
  return isChinaMirrorPreset(env) ? "npmmirror" : "official";
}

export function resolvePlaywrightBrowserSet(env = process.env) {
  const explicit = env.PILOTDECK_DESKTOP_PLAYWRIGHT_BROWSER_SET?.trim().toLowerCase();
  if (!explicit) return DEFAULT_BROWSER_SET;
  if (explicit === "minimal" || explicit === "browser") return "browser-only";
  if (explicit === "browser-only" || explicit === "full") return explicit;
  throw new Error(`Unsupported desktop Playwright browser set: ${explicit}`);
}

export function resolvePlaywrightInstallMode(env = process.env) {
  const explicit = env.PILOTDECK_DESKTOP_PLAYWRIGHT_INSTALL_MODE?.trim().toLowerCase();
  if (!explicit) return DEFAULT_INSTALL_MODE;
  if (explicit === "lazy" || explicit === "preinstall") return explicit;
  throw new Error(`Unsupported desktop Playwright install mode: ${explicit}`);
}

export function resolvePlaywrightHostPlatform({
  platform = process.platform,
  arch = process.arch,
  macMajor = readMacMajorVersion(),
} = {}) {
  if (platform === "win32" && arch === "x64") return "win64";
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) {
    const suffix = arch === "arm64" ? "-arm64" : "";
    return `mac${macMajor}${suffix}`;
  }
  if (platform === "linux" && arch === "x64") return "linux-x64";
  throw new Error(`Unsupported platform for mirrored Playwright browsers: ${platform}/${arch}`);
}

export function buildPlaywrightBrowserPlan({
  browsersJson,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  macMajor = readMacMajorVersion(),
}) {
  if (resolvePlaywrightInstallMode(env) === "lazy") return [];

  const hostPlatform = resolvePlaywrightHostPlatform({ platform, arch, macMajor });
  const chromePlatform = resolveChromeForTestingPlatform(hostPlatform);
  const chromium = getBrowserDescriptor(browsersJson, "chromium", hostPlatform);
  const chromeBaseUrl = trimUrlBase(
    env.PILOTDECK_DESKTOP_PLAYWRIGHT_CHROME_BASE_URL || DEFAULT_CHROME_BASE_URL,
  );
  const plan = [
    {
      name: "chromium",
      directoryName: getBrowserDirectoryName(chromium, hostPlatform),
      archiveName: `chrome-${chromePlatform}.zip`,
      url: joinUrl(chromeBaseUrl, chromium.browserVersion, chromePlatform, `chrome-${chromePlatform}.zip`),
    },
  ];

  if (resolvePlaywrightBrowserSet(env) === "browser-only") return plan;

  const headless = getBrowserDescriptor(browsersJson, "chromium-headless-shell", hostPlatform);
  const ffmpeg = getBrowserDescriptor(browsersJson, "ffmpeg", hostPlatform);
  const ffmpegBaseUrl = trimUrlBase(
    env.PILOTDECK_DESKTOP_PLAYWRIGHT_FFMPEG_BASE_URL || DEFAULT_FFMPEG_BASE_URL,
  );
  const ffmpegArchiveName = resolveFfmpegArchiveName(hostPlatform);

  plan.push(
    {
      name: "chromium-headless-shell",
      directoryName: getBrowserDirectoryName(headless, hostPlatform),
      archiveName: `chrome-headless-shell-${chromePlatform}.zip`,
      url: joinUrl(
        chromeBaseUrl,
        headless.browserVersion,
        chromePlatform,
        `chrome-headless-shell-${chromePlatform}.zip`,
      ),
    },
    {
      name: "ffmpeg",
      directoryName: getBrowserDirectoryName(ffmpeg, hostPlatform),
      archiveName: ffmpegArchiveName,
      url: joinUrl(ffmpegBaseUrl, "builds", "ffmpeg", ffmpeg.revision, ffmpegArchiveName),
    },
  );
  return plan;
}

export async function installMirroredPlaywrightBrowsers(runtimeRoot, env = process.env) {
  const mode = resolvePlaywrightMirrorMode(env);
  if (mode !== "npmmirror") {
    throw new Error(`Unsupported desktop Playwright browser mirror: ${mode}`);
  }

  const playwrightCoreRoot = resolve(runtimeRoot, "node_modules", "playwright-core");
  const browsersJsonPath = resolve(playwrightCoreRoot, "browsers.json");
  if (!existsSync(browsersJsonPath)) {
    throw new Error(`Playwright browsers metadata not found: ${browsersJsonPath}`);
  }
  const browsersJson = JSON.parse(readFileSync(browsersJsonPath, "utf8"));
  const plan = buildPlaywrightBrowserPlan({ browsersJson, env });
  if (plan.length === 0) {
    console.log("[desktop] skipping Playwright browser install (lazy mode)");
    return;
  }
  const browsersRoot = resolve(playwrightCoreRoot, ".local-browsers");
  const tmpDir = resolve(runtimeRoot, ".playwright-download");
  const archiveDir = env.PILOTDECK_DESKTOP_PLAYWRIGHT_ARCHIVE_DIR?.trim();

  mkdirSync(browsersRoot, { recursive: true });
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  try {
    for (const item of plan) {
      const browserDir = resolve(browsersRoot, item.directoryName);
      const markerFile = resolve(browserDir, "INSTALLATION_COMPLETE");
      if (existsSync(markerFile)) {
        console.log(`[desktop] Playwright ${item.name} already present: ${browserDir}`);
        continue;
      }

      let archivePath;
      if (archiveDir) {
        archivePath = resolve(archiveDir, item.archiveName);
        if (!existsSync(archivePath)) {
          throw new Error(`Playwright archive not found: ${archivePath}`);
        }
        console.log(`[desktop] using Playwright ${item.name} archive: ${archivePath}`);
      } else {
        archivePath = resolve(tmpDir, item.archiveName);
        await downloadToFile(item.url, archivePath);
      }

      rmSync(browserDir, { recursive: true, force: true });
      mkdirSync(browserDir, { recursive: true });
      extractZip(archivePath, browserDir);
      writeFileSync(markerFile, "");
      console.log(`[desktop] installed Playwright ${item.name}: ${browserDir}`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function getBrowserDescriptor(browsersJson, name, hostPlatform) {
  const descriptor = browsersJson.browsers?.find((browser) => browser.name === name);
  if (!descriptor) {
    throw new Error(`Missing Playwright browser descriptor: ${name}`);
  }
  const revision = descriptor.revisionOverrides?.[hostPlatform] || descriptor.revision;
  if (!revision) {
    throw new Error(`Missing Playwright browser revision for ${name}`);
  }
  return {
    ...descriptor,
    revision,
    hasRevisionOverride: Boolean(descriptor.revisionOverrides?.[hostPlatform]),
  };
}

function getBrowserDirectoryName(descriptor, hostPlatform) {
  const prefix = descriptor.hasRevisionOverride
    ? `${descriptor.name}_${hostPlatform}_special`
    : descriptor.name;
  return `${prefix.replace(/-/g, "_")}-${descriptor.revision}`;
}

function resolveChromeForTestingPlatform(hostPlatform) {
  if (hostPlatform === "win64") return "win64";
  if (hostPlatform.endsWith("-arm64") && hostPlatform.startsWith("mac")) return "mac-arm64";
  if (hostPlatform.startsWith("mac")) return "mac-x64";
  if (hostPlatform === "linux-x64") return "linux64";
  throw new Error(`Unsupported Chrome for Testing platform: ${hostPlatform}`);
}

function resolveFfmpegArchiveName(hostPlatform) {
  if (hostPlatform === "win64") return "ffmpeg-win64.zip";
  if (hostPlatform.endsWith("-arm64") && hostPlatform.startsWith("mac")) return "ffmpeg-mac-arm64.zip";
  if (hostPlatform.startsWith("mac")) return "ffmpeg-mac.zip";
  if (hostPlatform === "linux-x64") return "ffmpeg-linux.zip";
  throw new Error(`Unsupported FFmpeg platform: ${hostPlatform}`);
}

function readMacMajorVersion() {
  if (process.platform !== "darwin") return 15;
  const result = spawnSync("sw_vers", ["-productVersion"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const major = Number.parseInt(result.stdout.split(".")[0] || "", 10);
  return Number.isFinite(major) && major > 0 ? major : 15;
}

function extractZip(archivePath, targetDir) {
  console.log(`[desktop] extracting ${archivePath}`);
  const extract = spawnSync("tar", ["-xf", archivePath, "-C", targetDir], {
    stdio: "inherit",
    windowsHide: process.platform === "win32",
    env: { ...process.env, LANG: "C", LC_ALL: "C" },
  });
  if (extract.error) {
    throw extract.error;
  }
  if (extract.status !== 0) {
    throw new Error(`Failed to extract Playwright archive: ${archivePath}`);
  }
}

function isMainModule() {
  return process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isMainModule()) {
  const runtimeRoot = process.argv[2]
    ? resolve(process.argv[2])
    : resolve(desktopRoot, ".runtime", "app");
  await installMirroredPlaywrightBrowsers(runtimeRoot);
}
