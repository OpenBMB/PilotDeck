import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("CI metadata keeps the unified tag, desktop version and source commit aligned", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-ci-metadata-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "resources"));
  for (const script of ["set-ci-version.mjs", "release-version.mjs"]) {
    copyFileSync(new URL(`./${script}`, import.meta.url), join(root, "scripts", script));
  }
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pilotdeck-desktop", version: "0.1.0" }));
  const envFile = join(root, "github-env");
  const outputFile = join(root, "github-output");
  const sha = "1234567890abcdef1234567890abcdef12345678";
  const result = spawnSync(process.execPath, [join(root, "scripts", "set-ci-version.mjs")], {
    encoding: "utf8",
    env: {
      ...process.env,
      PILOTDECK_RELEASE_DATE: "2026-09-07",
      PILOTDECK_RELEASE_REVISION: "1",
      PILOTDECK_RELEASE_VERSION: "",
      PILOTDECK_RELEASE_TAG: "",
      PILOTDECK_RELEASE_BUILD_TIME: "2026-09-06T18:00:00.000Z",
      PILOTDECK_COMMIT_SHA: sha,
      PILOTDECK_UPDATE_REPOSITORY: "example/PilotDeck",
      GITHUB_SHA: "a-different-workflow-sha",
      GITHUB_ENV: envFile,
      GITHUB_OUTPUT: outputFile,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, "2026.907.1");
  assert.deepEqual(JSON.parse(readFileSync(join(root, "resources", "build-metadata.json"), "utf8")), {
    version: "2026.907.1",
    buildTime: "2026-09-06T18:00:00.000Z",
    releaseDate: "2026-09-07",
    releaseTag: "v2026.09.07-r2",
    commitSha: sha,
    repository: "example/PilotDeck",
  });
  const parseEnv = (file) => Object.fromEntries(readFileSync(file, "utf8").trim().split("\n")
    .map((line) => line.split("=")));
  const env = parseEnv(envFile);
  assert.equal(env.PILOTDECK_RELEASE_TAG, "v2026.09.07-r2");
  assert.equal(env.PILOTDECK_RELEASE_VERSION, "2026.907.1");
  assert.equal(env.PILOTDECK_RELEASE_BUILD_TIME, "2026-09-06T18:00:00.000Z");
  assert.equal(env.PILOTDECK_COMMIT_SHA, sha);
  assert.deepEqual(parseEnv(outputFile), {
    version: "2026.907.1", release_date: "2026-09-07", release_tag: "v2026.09.07-r2", commit_sha: sha,
  });
});
