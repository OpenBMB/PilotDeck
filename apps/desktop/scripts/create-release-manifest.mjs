#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const assetsDir = resolve(process.argv[2] || "release-assets");
const files = listFiles(assetsDir)
  .filter((file) => !["desktop-release.json", "SHA256SUMS.txt"].includes(basename(file)));

if (files.length === 0) throw new Error(`No desktop release assets found under ${assetsDir}`);

const assets = files.map((file) => ({
  name: basename(file),
  size: statSync(file).size,
  sha256: sha256(file),
  platform: inferPlatform(file),
  arch: inferArch(file),
}));

const manifest = {
  schemaVersion: 1,
  version: requiredEnv("PILOTDECK_DESKTOP_VERSION"),
  tag: requiredEnv("PILOTDECK_DESKTOP_RELEASE_TAG"),
  date: requiredEnv("PILOTDECK_DESKTOP_RELEASE_DATE"),
  buildTime: requiredEnv("PILOTDECK_DESKTOP_BUILD_TIME"),
  sourceSha: requiredEnv("PILOTDECK_COMMIT_SHA"),
  repository: requiredEnv("PILOTDECK_UPDATE_REPOSITORY"),
  assets,
};

writeFileSync(resolve(assetsDir, "desktop-release.json"), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(
  resolve(assetsDir, "SHA256SUMS.txt"),
  `${assets.map((asset) => `${asset.sha256}  ${asset.name}`).join("\n")}\n`,
);

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function inferPlatform(file) {
  const name = basename(file).toLowerCase();
  if (name.endsWith(".dmg") || name.includes("mac")) return "darwin";
  if (name.endsWith(".exe") || name.includes("win")) return "win32";
  return "unknown";
}

function inferArch(file) {
  const name = basename(file).toLowerCase();
  if (name.includes("universal")) return "universal";
  if (name.includes("arm64") || name.includes("aarch64")) return "arm64";
  if (name.includes("x64") || name.includes("x86_64") || name.includes("amd64")) return "x64";
  return "unknown";
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required release environment variable: ${name}`);
  return value;
}
