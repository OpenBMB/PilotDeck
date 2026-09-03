#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildDateVersion,
  buildReleaseTag,
  formatReleaseDate,
  parseRevision,
} from "./release-version.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const desktopRoot = path.resolve(__dirname, "..");
const packageJsonPath = path.join(desktopRoot, "package.json");
const metadataPath = path.join(desktopRoot, "resources", "build-metadata.json");

const releaseDate = process.env.PILOTDECK_DESKTOP_RELEASE_DATE || formatReleaseDate(new Date());
const revision = parseRevision(process.env.PILOTDECK_DESKTOP_REVISION);
const version = process.env.PILOTDECK_DESKTOP_VERSION || buildDateVersion(releaseDate, revision);
const releaseTag = process.env.PILOTDECK_DESKTOP_RELEASE_TAG || buildReleaseTag(releaseDate, revision);
const buildTime = process.env.PILOTDECK_DESKTOP_BUILD_TIME || new Date().toISOString();
const commitSha = process.env.PILOTDECK_COMMIT_SHA || process.env.GITHUB_SHA || resolveGitCommit();
const repository = process.env.PILOTDECK_UPDATE_REPOSITORY || process.env.GITHUB_REPOSITORY || "OpenBMB/PilotDeck";

const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
packageJson.version = version;
writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
writeFileSync(metadataPath, `${JSON.stringify({
  version,
  buildTime,
  releaseDate,
  commitSha,
  repository,
}, null, 2)}\n`);

exportGitHubEnv({
  PILOTDECK_DESKTOP_VERSION: version,
  PILOTDECK_DESKTOP_RELEASE_DATE: releaseDate,
  PILOTDECK_DESKTOP_RELEASE_TAG: releaseTag,
  PILOTDECK_COMMIT_SHA: commitSha,
  PILOTDECK_DESKTOP_BUILD_TIME: buildTime,
  PILOTDECK_UPDATE_REPOSITORY: repository,
});
exportGitHubOutput({ version, release_date: releaseDate, release_tag: releaseTag, commit_sha: commitSha });

console.log(`PilotDeck desktop version set to ${version}`);
console.log(`PilotDeck desktop release tag set to ${releaseTag}`);
console.log(`PilotDeck desktop commit set to ${commitSha}`);
console.log(`PilotDeck desktop build time set to ${buildTime}`);

function resolveGitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: path.resolve(desktopRoot, "..", ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function exportGitHubEnv(values) {
  if (!process.env.GITHUB_ENV) return;

  const lines = Object.entries(values)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}=${String(value).replace(/\r?\n/g, " ")}`);
  if (lines.length > 0) {
    appendFileSync(process.env.GITHUB_ENV, `${lines.join("\n")}\n`);
  }
}

function exportGitHubOutput(values) {
  appendKeyValueFile(process.env.GITHUB_OUTPUT, values);
}

function appendKeyValueFile(file, values) {
  if (!file) return;
  const lines = Object.entries(values)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${String(value).replace(/\r?\n/g, " ")}`);
  if (lines.length > 0) appendFileSync(file, `${lines.join("\n")}\n`);
}
