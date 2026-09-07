#!/usr/bin/env node
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const DEFAULT_CHROME_BASE_URL = "https://cdn.npmmirror.com/binaries/chrome-for-testing";
const DEFAULT_PLAYWRIGHT_BROWSER = "chrome-for-testing";
const DEFAULT_BROWSER_SET = "browser-only";

const __dirname = dirname(fileURLToPath(import.meta.url));

function findRuntimeRoot() {
  const explicit = process.env.PILOTDECK_RUNTIME_ROOT?.trim();
  if (explicit) return assertRuntimeRoot(resolve(explicit), "PILOTDECK_RUNTIME_ROOT");

  const candidates = [
    resolve(__dirname, "..", "..", "..", "..", "..", "..", ".."),
    process.cwd(),
  ];
  for (const candidate of candidates) {
    if (isRuntimeRoot(candidate)) return candidate;
  }
  throw new Error("PilotDeck runtime root not found. Set PILOTDECK_RUNTIME_ROOT and retry.");
}

function assertRuntimeRoot(candidate, source) {
  if (isRuntimeRoot(candidate)) return candidate;
  throw new Error(
    `PilotDeck runtime root from ${source} is incomplete: ${candidate}. ` +
      "Expected node_modules/@playwright/mcp/cli.js, node_modules/playwright-core/browsers.json, " +
      "and dist/src/cli/pilotdeck.js.",
  );
}

function isRuntimeRoot(candidate) {
  return existsSync(resolve(candidate, "node_modules", "@playwright", "mcp", "cli.js")) &&
    existsSync(resolve(candidate, "node_modules", "playwright-core", "browsers.json")) &&
    existsSync(resolve(candidate, "dist", "src", "cli", "pilotdeck.js"));
}

function resolveBrowsersPath(runtimeRoot) {
  const explicit = process.env.PLAYWRIGHT_BROWSERS_PATH?.trim();
  if (explicit && explicit !== "0") return resolve(expandHome(explicit));
  const bundledBrowsersPath = resolve(runtimeRoot, "node_modules", "playwright-core", ".local-browsers");
  if (explicit === "0" && hasInstalledBrowserMarker(bundledBrowsersPath)) return bundledBrowsersPath;

  if (process.env.APPDATA) {
    return resolve(process.env.APPDATA, "PilotDeck", "playwright-browsers");
  }
  return resolve(homedir(), ".pilotdeck", "playwright-browsers");
}

function hasInstalledBrowserMarker(browsersPath) {
  let entries;
  try {
    entries = readdirSync(browsersPath, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some((entry) =>
    entry.isDirectory() &&
    /^chromium(?:-|_)/u.test(entry.name) &&
    existsSync(resolve(browsersPath, entry.name, "INSTALLATION_COMPLETE")),
  );
}

function expandHome(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

function resolveMirrorMode(env = process.env) {
  if (env.PILOTDECK_DESKTOP_PLAYWRIGHT_ARCHIVE_DIR?.trim()) return "npmmirror";
  const explicit = env.PILOTDECK_DESKTOP_PLAYWRIGHT_MIRROR?.trim().toLowerCase();
  if (explicit) return explicit;
  return env.PILOTDECK_DESKTOP_DOWNLOAD_MIRROR?.trim().toLowerCase() === "china" ? "npmmirror" : "official";
}

function resolveBrowserSet(env = process.env) {
  const explicit = env.PILOTDECK_DESKTOP_PLAYWRIGHT_BROWSER_SET?.trim().toLowerCase();
  if (!explicit) return DEFAULT_BROWSER_SET;
  if (explicit === "minimal" || explicit === "browser" || explicit === "browser-only") return "browser-only";
  if (explicit === "full") return "full";
  throw new Error(`Unsupported desktop Playwright browser set: ${explicit}`);
}

function resolveHostPlatform() {
  if (process.platform === "win32" && process.arch === "x64") return "win64";
  if (process.platform === "darwin" && (process.arch === "arm64" || process.arch === "x64")) {
    const suffix = process.arch === "arm64" ? "-arm64" : "";
    return `mac${readMacMajorVersion()}${suffix}`;
  }
  if (process.platform === "linux" && process.arch === "x64") return "linux-x64";
  throw new Error(`Unsupported platform for Playwright browser install: ${process.platform}/${process.arch}`);
}

function buildBrowserPlan(runtimeRoot) {
  const playwrightCoreRoot = resolve(runtimeRoot, "node_modules", "playwright-core");
  const browsersJson = JSON.parse(readFileSync(resolve(playwrightCoreRoot, "browsers.json"), "utf8"));
  const hostPlatform = resolveHostPlatform();
  const chromium = getBrowserDescriptor(browsersJson, "chromium", hostPlatform);
  const chromePlatform = resolveChromeForTestingPlatform(hostPlatform);
  const chromeBaseUrl = trimUrlBase(
    process.env.PILOTDECK_DESKTOP_PLAYWRIGHT_CHROME_BASE_URL || DEFAULT_CHROME_BASE_URL,
  );
  const plan = [
    {
      name: "chromium",
      directoryName: getBrowserDirectoryName(chromium, hostPlatform),
      archiveName: `chrome-${chromePlatform}.zip`,
      url: joinUrl(chromeBaseUrl, chromium.browserVersion, chromePlatform, `chrome-${chromePlatform}.zip`),
    },
  ];

  if (resolveBrowserSet() === "browser-only") return plan;
  throw new Error("Lazy browser-use install only supports browser-only mode. Use the desktop preinstall build for full mode.");
}

function getBrowserDescriptor(browsersJson, name, hostPlatform) {
  const descriptor = browsersJson.browsers?.find((browser) => browser.name === name);
  if (!descriptor) throw new Error(`Missing Playwright browser descriptor: ${name}`);
  const revision = descriptor.revisionOverrides?.[hostPlatform] || descriptor.revision;
  if (!revision) throw new Error(`Missing Playwright browser revision for ${name}`);
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

function readMacMajorVersion() {
  if (process.platform !== "darwin") return 15;
  const result = spawnSync("sw_vers", ["-productVersion"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const major = Number.parseInt(result.stdout.split(".")[0] || "", 10);
  return Number.isFinite(major) && major > 0 ? major : 15;
}

function trimUrlBase(baseUrl) {
  return baseUrl.replace(/\/+$/g, "");
}

function joinUrl(baseUrl, ...parts) {
  const cleaned = parts
    .filter((part) => part !== undefined && part !== null && String(part).length > 0)
    .map((part) => String(part).replace(/^\/+|\/+$/g, ""));
  return [trimUrlBase(baseUrl), ...cleaned].join("/");
}

function isInstalled(browsersPath, plan) {
  return plan.every((item) => existsSync(resolve(browsersPath, item.directoryName, "INSTALLATION_COMPLETE")));
}

async function installFromMirror(runtimeRoot, browsersPath) {
  const plan = buildBrowserPlan(runtimeRoot);
  if (isInstalled(browsersPath, plan)) {
    console.log(`[browser-use] Playwright browser already installed: ${browsersPath}`);
    return;
  }

  const archiveDir = process.env.PILOTDECK_DESKTOP_PLAYWRIGHT_ARCHIVE_DIR?.trim();
  const tmpDir = resolve(browsersPath, ".download");
  mkdirSync(browsersPath, { recursive: true });
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });

  try {
    for (const item of plan) {
      const browserDir = resolve(browsersPath, item.directoryName);
      const markerFile = resolve(browserDir, "INSTALLATION_COMPLETE");
      if (existsSync(markerFile)) {
        console.log(`[browser-use] ${item.name} already installed: ${browserDir}`);
        continue;
      }

      let archivePath;
      if (archiveDir) {
        archivePath = resolve(archiveDir, item.archiveName);
        if (!existsSync(archivePath)) throw new Error(`Playwright archive not found: ${archivePath}`);
        console.log(`[browser-use] using archive: ${archivePath}`);
      } else {
        archivePath = resolve(tmpDir, item.archiveName);
        await downloadToFile(item.url, archivePath);
      }

      rmSync(browserDir, { recursive: true, force: true });
      mkdirSync(browserDir, { recursive: true });
      extractZip(archivePath, browserDir);
      writeFileSync(markerFile, "");
      console.log(`[browser-use] installed ${item.name}: ${browserDir}`);
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function downloadToFile(url, path) {
  console.log(`[browser-use] downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  await pipeline(response.body, createWriteStream(path));
}

function extractZip(archivePath, targetDir) {
  console.log(`[browser-use] extracting ${archivePath}`);
  const extract = spawnSync("tar", ["-xf", archivePath, "-C", targetDir], {
    stdio: "inherit",
    windowsHide: process.platform === "win32",
    env: { ...process.env, LANG: "C", LC_ALL: "C" },
  });
  if (extract.error) throw extract.error;
  if (extract.status !== 0) throw new Error(`Failed to extract Playwright archive: ${archivePath}`);
}

function installOfficial(runtimeRoot, browsersPath) {
  const cli = resolve(runtimeRoot, "node_modules", "@playwright", "mcp", "cli.js");
  if (!existsSync(cli)) throw new Error(`Playwright MCP CLI not found: ${cli}`);

  mkdirSync(browsersPath, { recursive: true });
  const result = spawnSync(
    process.execPath,
    [cli, "install-browser", DEFAULT_PLAYWRIGHT_BROWSER, "--no-shell"],
    {
      cwd: runtimeRoot,
      stdio: "inherit",
      windowsHide: process.platform === "win32",
      env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: browsersPath,
      },
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Playwright browser install failed with exit code ${result.status}`);
  }
}

async function main() {
  const runtimeRoot = findRuntimeRoot();
  const browsersPath = resolveBrowsersPath(runtimeRoot);
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  console.log(`[browser-use] runtime: ${runtimeRoot}`);
  console.log(`[browser-use] browsers: ${browsersPath}`);
  console.log(`[browser-use] platform: ${osPlatform()} ${process.arch}`);

  const plan = buildBrowserPlan(runtimeRoot);
  if (isInstalled(browsersPath, plan)) {
    console.log("[browser-use] Playwright browser is already installed.");
    return;
  }

  const mirrorMode = resolveMirrorMode();
  if (mirrorMode === "official") {
    installOfficial(runtimeRoot, browsersPath);
    return;
  }
  if (mirrorMode === "npmmirror") {
    await installFromMirror(runtimeRoot, browsersPath);
    return;
  }
  throw new Error(`Unsupported Playwright browser mirror: ${mirrorMode}`);
}

await main();
