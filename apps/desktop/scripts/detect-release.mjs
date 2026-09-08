#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { buildDateVersion, buildReleaseTag, formatReleaseDate, parseRevision } from "./release-version.mjs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const releaseDate = process.env.PILOTDECK_RELEASE_DATE || formatReleaseDate(new Date());
const tags = git("tag", "--list", "v*", "--sort=-version:refname").split("\n");
const published = tags.flatMap(tag => {
  const match = /^v(\d{4})\.(\d{2})\.(\d{2})(?:-r([2-9]\d*|1\d+))?$/.exec(tag);
  if (!match) return [];
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const revision = match[4] ? Number(match[4]) - 1 : 0;
  try { buildDateVersion(date, revision); return [{ tag, date, revision }]; } catch { return []; }
}).sort((a, b) => b.date.localeCompare(a.date) || b.revision - a.revision);
const latestTag = published[0]?.tag;
const sourceSha = git("rev-parse", "HEAD");
const productionPaths = [
  "src", "ui", "skills", "apps/desktop", "scripts",
  "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json",
  "Dockerfile", "docker-entrypoint.sh", ".dockerignore",
  ".github/workflows/desktop-build.yml", ".github/workflows/release.yml",
];

const shouldBuild = process.env.FORCE_RELEASE === "true"
  || !latestTag
  || git("diff", "--name-only", `refs/tags/${latestTag}^{commit}`, sourceSha, "--", ...productionPaths) !== "";

const requestedRevision = process.env.REQUESTED_REVISION?.trim();
let revision = parseRevision(requestedRevision);
if (requestedRevision) {
  const tag = buildReleaseTag(releaseDate, revision);
  if (tags.includes(tag)) throw new Error(`Release tag already exists: ${tag}`);
} else {
  revision = Math.max(-1, ...published.filter(item => item.date === releaseDate).map(item => item.revision)) + 1;
}

buildDateVersion(releaseDate, revision);
if (published[0] && (releaseDate < published[0].date || (releaseDate === published[0].date && revision <= published[0].revision))) {
  throw new Error(`Release version must be newer than ${published[0].tag}`);
}

const output = {
  should_build: shouldBuild,
  release_date: releaseDate,
  revision,
  source_sha: sourceSha,
};
const lines = Object.entries(output).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines);
process.stdout.write(lines);
