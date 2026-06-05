#!/usr/bin/env node
import { createWriteStream, existsSync, mkdirSync, rmSync, renameSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const version = process.env.PILOTDECK_DESKTOP_NODE_VERSION || "24.14.0";
const targetDir = resolve(desktopRoot, "resources", "node");
const tmpDir = resolve(desktopRoot, "resources", ".node-download");

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
const nodeArch = archMap[process.arch];
if (!nodePlatform || !nodeArch) {
  throw new Error(`Unsupported platform for bundled Node: ${process.platform}/${process.arch}`);
}

const nodeBinary = process.platform === "win32"
  ? join(targetDir, "node.exe")
  : join(targetDir, "bin", "node");

if (existsSync(nodeBinary)) {
  const result = spawnSync(nodeBinary, ["--version"], { encoding: "utf8" });
  if (result.stdout.trim() === `v${version}`) {
    console.log(`[desktop] bundled Node already present: ${result.stdout.trim()}`);
    process.exit(0);
  }
}

mkdirSync(tmpDir, { recursive: true });
rmSync(targetDir, { recursive: true, force: true });

const name = `node-v${version}-${nodePlatform}-${nodeArch}`;
const ext = process.platform === "win32" ? "zip" : "tar.gz";
const archivePath = join(tmpDir, `${name}.${ext}`);
const url = `https://nodejs.org/dist/v${version}/${name}.${ext}`;

console.log(`[desktop] downloading ${url}`);
const response = await fetch(url);
if (!response.ok || !response.body) {
  throw new Error(`Failed to download Node ${version}: ${response.status} ${response.statusText}`);
}
await pipeline(response.body, createWriteStream(archivePath));

console.log(`[desktop] extracting ${archivePath}`);
const extract = spawnSync("tar", ["-xf", archivePath, "-C", tmpDir], { stdio: "inherit" });
if (extract.status !== 0) {
  throw new Error("Failed to extract Node archive with tar");
}

renameSync(join(tmpDir, name), targetDir);
rmSync(tmpDir, { recursive: true, force: true });
if (process.platform !== "win32") chmodSync(nodeBinary, 0o755);
console.log(`[desktop] bundled Node ready: ${nodeBinary}`);
