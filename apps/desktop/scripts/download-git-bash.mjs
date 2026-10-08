#!/usr/bin/env node
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { downloadToFile, resolveDownloadSource } from "./download-sources.mjs";
import architecture from "./windows-architecture.cjs";

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

const requestedArch = process.env.PILOTDECK_DESKTOP_NODE_ARCH || process.arch;
if (!["x64", "arm64"].includes(requestedArch) || process.arch !== requestedArch) {
  throw new Error(`Unsupported platform for bundled Git Bash: ${process.platform}/${process.arch}`);
}

const gitBinary = join(targetDir, "cmd", "git.exe");
const bashBinary = join(targetDir, "bin", "bash.exe");

function writePlaceholder() {
  writeFileSync(join(targetDir, ".gitkeep"), "\n");
}

function verifyExistingGit() {
  if (!existsSync(gitBinary) || !existsSync(bashBinary)) return false;
  if (architecture.executableArchitecture(gitBinary) !== requestedArch) return false;
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

const archiveName = architecture.portableGitArchive(version, requestedArch);
const source = resolveDownloadSource({
  archiveEnv: "PILOTDECK_DESKTOP_GIT_ARCHIVE",
  urlEnv: "PILOTDECK_DESKTOP_GIT_URL",
  baseEnv: "PILOTDECK_DESKTOP_GIT_BASE_URL",
  chinaBaseUrl: "https://mirrors.huaweicloud.com/git-for-windows",
  officialBaseUrl: "https://github.com/git-for-windows/git/releases/download",
  relativePath: `${releaseTag}/${archiveName}`,
});

rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
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

// Portable Git's self-extractor can return while its child still holds the
// archive open. Use the same checksum-verified synchronous decoder as NSIS.
const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder"));
const { getPath7za } = builderRequire("app-builder-lib/out/toolsets/7zip.js");
const decoder = await getPath7za();
console.log(`[desktop] extracting ${archivePath}`);
const extract = spawnSync(decoder, ["x", "-y", `-o${targetDir}`, archivePath], {
  stdio: "inherit",
  windowsHide: true,
});
if (extract.error) {
  throw extract.error;
}
if (extract.status !== 0) {
  throw new Error("Failed to extract Portable Git for Windows");
}

rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
writePlaceholder();

if (!existsSync(gitBinary) || !existsSync(bashBinary)) {
  throw new Error(`Portable Git extraction did not create expected binaries under ${targetDir}`);
}

const versionCheck = spawnSync(gitBinary, ["--version"], {
  encoding: "utf8",
  windowsHide: true,
});
if (architecture.executableArchitecture(gitBinary) !== requestedArch) {
  throw new Error(`Bundled Git architecture does not match ${requestedArch}`);
}
if (versionCheck.status !== 0) {
  throw new Error(`Bundled Git failed version check: ${versionCheck.stderr || versionCheck.stdout}`);
}

console.log(`[desktop] bundled Git Bash ready: ${versionCheck.stdout.trim()}`);
