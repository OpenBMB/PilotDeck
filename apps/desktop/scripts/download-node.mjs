#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, rmSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { downloadToFile, resolveDownloadSource } from "./download-sources.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const version = process.env.PILOTDECK_DESKTOP_NODE_VERSION || "22.23.1";
const targetDir = resolve(desktopRoot, "resources", "node");
const tmpDir = resolve(desktopRoot, "resources", ".node-download");
const requestedArch = (process.env.PILOTDECK_DESKTOP_NODE_ARCH || process.arch).trim().toLowerCase();

const platformMap = {
  darwin: "darwin",
  linux: "linux",
  win32: "win",
};
const archMap = {
  arm64: "arm64",
  x64: "x64",
};

const nodePlatform = platformMap[process.platform];
const nodeArch = archMap[requestedArch];
if (!nodePlatform || !nodeArch) {
  throw new Error(`Unsupported platform for bundled Node: ${process.platform}/${requestedArch}`);
}

const nodeBinary = process.platform === "win32"
  ? join(targetDir, "node.exe")
  : join(targetDir, "bin", "node");

function pruneNodeDistribution() {
  const removable = process.platform === "win32"
    ? [
        "CHANGELOG.md",
        "README.md",
        "corepack",
        "corepack.cmd",
        "install_tools.bat",
        "node_etw_provider.man",
        "node_modules",
        "npm",
        "npm.cmd",
        "npx",
        "npx.cmd",
      ]
    : [
        "CHANGELOG.md",
        "README.md",
        "bin/corepack",
        "bin/npm",
        "bin/npx",
        "include",
        "lib",
        "share",
      ];
  for (const entry of removable) {
    rmSync(join(targetDir, entry), { recursive: true, force: true });
  }
}

function runChecked(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

function bundledNodeMatchesRequest() {
  if (!existsSync(nodeBinary)) return false;
  const versionCheck = spawnSync(nodeBinary, ["--version"], { encoding: "utf8" });
  if (versionCheck.stdout.trim() !== `v${version}`) return false;
  if (process.platform !== "darwin") return true;

  const archCheck = spawnSync("lipo", ["-archs", nodeBinary], { encoding: "utf8" });
  if (archCheck.status !== 0) return false;
  const expectedArch = nodeArch === "x64" ? "x86_64" : nodeArch;
  return archCheck.stdout.trim() === expectedArch;
}

function downloadSourceForArchive(archiveName) {
  return resolveDownloadSource({
    archiveEnv: "PILOTDECK_DESKTOP_NODE_ARCHIVE",
    urlEnv: "PILOTDECK_DESKTOP_NODE_URL",
    baseEnv: "PILOTDECK_DESKTOP_NODE_BASE_URL",
    chinaBaseUrl: "https://mirrors.aliyun.com/nodejs-release",
    officialBaseUrl: "https://nodejs.org/dist",
    relativePath: `v${version}/${archiveName}`,
  });
}

async function resolveArchive(archiveName) {
  const source = downloadSourceForArchive(archiveName);
  if (source.type === "archive") {
    if (!existsSync(source.path)) {
      throw new Error(`Bundled Node archive not found: ${source.path}`);
    }
    console.log(`[desktop] using bundled Node archive from ${source.source}: ${source.path}`);
    return source.path;
  }

  const archivePath = join(tmpDir, archiveName);
  await downloadToFile(source.url, archivePath);
  return archivePath;
}

async function extractNodeArchive(arch, destinationRoot) {
  const name = `node-v${version}-${nodePlatform}-${arch}`;
  const ext = process.platform === "win32" ? "zip" : "tar.gz";
  const archiveName = `${name}.${ext}`;
  const archivePath = await resolveArchive(archiveName);

  console.log(`[desktop] extracting ${archivePath}`);
  runChecked("tar", ["-xf", archivePath, "-C", tmpDir]);
  renameSync(join(tmpDir, name), destinationRoot);
}

async function installSingleArchNode(arch) {
  await extractNodeArchive(arch, targetDir);
}

if (bundledNodeMatchesRequest()) {
  pruneNodeDistribution();
  console.log(`[desktop] bundled Node already present: v${version} (${nodeArch})`);
  process.exit(0);
}

rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });

rmSync(targetDir, { recursive: true, force: true });

await installSingleArchNode(nodeArch);

rmSync(tmpDir, { recursive: true, force: true });
if (process.platform !== "win32") chmodSync(nodeBinary, 0o755);
pruneNodeDistribution();
console.log(`[desktop] bundled Node ready: ${nodeBinary}`);
