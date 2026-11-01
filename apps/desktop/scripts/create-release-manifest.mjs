#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { describeReleaseAsset, compatibilityFeeds } from "../../../ui/shared/releaseArtifacts.js";

const assetsDir = resolve(process.argv[2] || "release-assets");
const files = listFiles(assetsDir)
  .filter((file) => !["release.json", "SHA256SUMS.txt"].includes(basename(file)) && !file.endsWith('.yml'));

if (files.length === 0) throw new Error(`No desktop release assets found under ${assetsDir}`);

const record = (file) => ({
  name: basename(file),
  size: statSync(file).size,
  sha256: digest(file, "sha256", "hex"),
  sha512: digest(file, "sha512", "base64"),
  ...describeReleaseAsset(basename(file)),
});
const assets = files.map(record);

const manifest = {
  schemaVersion: 1,
  artifactSchemaVersion: 1,
  version: requiredEnv("PILOTDECK_RELEASE_VERSION"),
  tag: requiredEnv("PILOTDECK_RELEASE_TAG"),
  date: requiredEnv("PILOTDECK_RELEASE_DATE"),
  buildTime: requiredEnv("PILOTDECK_RELEASE_BUILD_TIME"),
  sourceSha: requiredEnv("PILOTDECK_COMMIT_SHA"),
  repository: requiredEnv("PILOTDECK_UPDATE_REPOSITORY"),
  assets,
};

for (const feed of compatibilityFeeds(manifest)) {
  const file = resolve(assetsDir, feed.name);
  writeFileSync(file, feed.text);
  assets.push(record(file));
}
assets.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(resolve(assetsDir, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`);
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

function digest(file, algorithm, encoding) {
  return createHash(algorithm).update(readFileSync(file)).digest(encoding);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required release environment variable: ${name}`);
  return value;
}
