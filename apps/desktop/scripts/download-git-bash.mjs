#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { downloadToFile, resolveDownloadSource } from "./download-sources.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const version = process.env.PILOTDECK_DESKTOP_GIT_VERSION || "2.51.2";
const releaseTag = process.env.PILOTDECK_DESKTOP_GIT_RELEASE_TAG || `v${version}.windows.1`;
const targetDir = resolve(desktopRoot, "resources", "git");
const tmpDir = resolve(desktopRoot, "resources", ".git-download");

if (process.platform !== "win32") {
  mkdirSync(targetDir, { recursive: true });
  console.log("[desktop] bundled Git Bash is only prepared for Windows builds");
  process.exit(0);
}

if (process.arch !== "x64") {
  throw new Error(`Unsupported platform for bundled Git Bash: ${process.platform}/${process.arch}`);
}

const gitBinary = join(targetDir, "cmd", "git.exe");
const bashBinary = join(targetDir, "bin", "bash.exe");

function writePlaceholder() {
  writeFileSync(join(targetDir, ".gitkeep"), "\n");
}

function verifyExistingGit() {
  if (!existsSync(gitBinary) || !existsSync(bashBinary)) return false;
  const result = spawnSync(gitBinary, ["--version"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const output = `${result.stdout}${result.stderr}`.trim();
  if (result.status === 0 && output.includes(version)) {
    console.log(`[desktop] bundled Git Bash already present: ${output}`);
    return true;
  }
  return false;
}

if (verifyExistingGit()) {
  process.exit(0);
}

const archiveName = `PortableGit-${version}-64-bit.7z.exe`;
const source = resolveDownloadSource({
  archiveEnv: "PILOTDECK_DESKTOP_GIT_ARCHIVE",
  urlEnv: "PILOTDECK_DESKTOP_GIT_URL",
  baseEnv: "PILOTDECK_DESKTOP_GIT_BASE_URL",
  chinaBaseUrl: "https://mirrors.huaweicloud.com/git-for-windows",
  officialBaseUrl: "https://github.com/git-for-windows/git/releases/download",
  relativePath: `${releaseTag}/${archiveName}`,
});

rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });

let archivePath;
if (source.type === "archive") {
  archivePath = source.path;
  if (!existsSync(archivePath)) {
    throw new Error(`Bundled Git Bash archive not found: ${archivePath}`);
  }
  console.log(`[desktop] using bundled Git Bash archive from ${source.source}: ${archivePath}`);
} else {
  archivePath = join(tmpDir, archiveName);
  await downloadToFile(source.url, archivePath);
}

rmSync(targetDir, { recursive: true, force: true });
mkdirSync(targetDir, { recursive: true });
writePlaceholder();

console.log(`[desktop] extracting ${archivePath}`);
const extract = spawnSync(archivePath, ["-y", `-o${targetDir}`], {
  stdio: "inherit",
  windowsHide: true,
});
if (extract.error) {
  throw extract.error;
}
if (extract.status !== 0) {
  throw new Error("Failed to extract Portable Git for Windows");
}

rmSync(tmpDir, { recursive: true, force: true });
writePlaceholder();

if (!existsSync(gitBinary) || !existsSync(bashBinary)) {
  throw new Error(`Portable Git extraction did not create expected binaries under ${targetDir}`);
}

const versionCheck = spawnSync(gitBinary, ["--version"], {
  encoding: "utf8",
  windowsHide: true,
});
if (versionCheck.status !== 0) {
  throw new Error(`Bundled Git failed version check: ${versionCheck.stderr || versionCheck.stdout}`);
}

console.log(`[desktop] bundled Git Bash ready: ${versionCheck.stdout.trim()}`);
