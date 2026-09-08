import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./detect-release.mjs", import.meta.url));

function repository(t) {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-release-detect-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  git("init", "--quiet");
  git("config", "user.name", "Release Test");
  git("config", "user.email", "release-test@example.com");
  git("config", "commit.gpgSign", "false");
  const commit = (file, content = "initial") => {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
    git("add", "--", file);
    git("commit", "--quiet", "-m", `Update ${file}`);
    return git("rev-parse", "HEAD");
  };
  const detect = (env = {}) => {
    const outputFile = join(root, "github-output");
    writeFileSync(outputFile, "");
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PILOTDECK_RELEASE_DATE: "2026-09-07",
        FORCE_RELEASE: "false",
        REQUESTED_REVISION: "",
        GITHUB_OUTPUT: outputFile,
        ...env,
      },
    });
    const output = Object.fromEntries(readFileSync(outputFile, "utf8").trim().split("\n")
      .filter(Boolean).map((line) => line.split("=")));
    return { ...result, output };
  };
  const sha = commit("ui/app.js");
  return { git, commit, detect, sha };
}

test("the first unified release builds from HEAD, ignoring legacy and unrelated tags", (t) => {
  const { git, detect, sha } = repository(t);
  git("tag", "desktop-v2026.09.07");
  git("tag", "v9999.0.0");
  git("tag", "v2026.09.07-preview");
  const result = detect();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.output, {
    should_build: "true", release_date: "2026-09-07", revision: "0", source_sha: sha,
  });
});

test("unchanged and documentation-only commits skip unless forced", (t) => {
  const { git, commit, detect } = repository(t);
  git("tag", "v2026.09.06");
  assert.equal(detect().output.should_build, "false");
  const sha = commit("docs/guide.md");
  assert.equal(detect().output.should_build, "false");
  const forced = detect({ FORCE_RELEASE: "true" });
  assert.equal(forced.output.should_build, "true");
  assert.equal(forced.output.source_sha, sha);
});

for (const file of ["ui/app.js", "apps/desktop/src/main.ts", "Dockerfile", ".github/workflows/release.yml"]) {
  test(`production changes trigger a release: ${file}`, (t) => {
    const { git, commit, detect } = repository(t);
    git("tag", "v2026.09.06");
    const sha = commit(file, "changed");
    const result = detect();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output.should_build, "true");
    assert.equal(result.output.source_sha, sha);
  });
}

test("same-day revisions use the latest baseline and select the next free tag", (t) => {
  const { git, commit, detect } = repository(t);
  git("tag", "v2026.09.07");
  for (let number = 2; number <= 10; number += 1) git("tag", `v2026.09.07-r${number}`);
  commit("ui/app.js", "released");
  git("tag", "v2026.09.07-r11");
  const result = detect();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output.should_build, "false");
  assert.equal(result.output.revision, "11");
});

test("manual revisions are validated and existing tags cannot be reused", (t) => {
  const { git, detect } = repository(t);
  git("tag", "v2026.09.07");
  const collision = detect({ REQUESTED_REVISION: "0" });
  assert.notEqual(collision.status, 0);
  assert.match(collision.stderr, /Release tag already exists: v2026\.09\.07/);
  assert.notEqual(detect({ REQUESTED_REVISION: "1x" }).status, 0);
  assert.notEqual(detect({ PILOTDECK_RELEASE_DATE: "2026-02-30" }).status, 0);
  assert.equal(detect({ REQUESTED_REVISION: "2" }).output.revision, "2");
});

test("automatic release advances past manual gaps instead of filling them", (t) => {
  const { git, commit, detect } = repository(t);
  git("tag", "v2026.09.07");
  git("tag", "v2026.09.07-r3");
  commit("ui/app.js", "new code");
  const result = detect();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output.should_build, "true");
  assert.equal(result.output.revision, "3"); // v2026.09.07-r4
  assert.notEqual(detect({ REQUESTED_REVISION: "1" }).status, 0);
  assert.equal(detect({ REQUESTED_REVISION: "4" }).status, 0);
});

test("neither automatic nor forced release can go backwards in date", (t) => {
  const { git, commit, detect } = repository(t);
  git("tag", "v2026.09.08");
  commit("ui/app.js", "new code");
  for (const env of [{}, { FORCE_RELEASE: "true", REQUESTED_REVISION: "100" }]) {
    const result = detect(env);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must be newer than v2026.09.08/);
  }
});
