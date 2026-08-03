import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";

const scriptPath = join(process.cwd(), "scripts", "check-node-runtime.mjs");

function runRuntimeCheck(nodeVersion: string) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PILOTDECK_RUNTIME_CHECK_TEST_MODE: "1",
      PILOTDECK_TEST_NODE_VERSION: nodeVersion,
      PILOTDECK_TEST_SKIP_SQLITE: "1",
    },
    encoding: "utf8",
  });
}

test("runtime check accepts the supported Node 22 range", () => {
  assert.equal(runRuntimeCheck("22.13.0").status, 0);
  assert.equal(runRuntimeCheck("22.22.0").status, 0);
});

test("runtime check rejects Node versions outside the supported range", () => {
  const tooOld = runRuntimeCheck("22.12.0");
  assert.equal(tooOld.status, 1);
  assert.match(tooOld.stderr, />=22\.13\.0 and <23/);

  const tooNew = runRuntimeCheck("25.5.0");
  assert.equal(tooNew.status, 1);
  assert.match(tooNew.stderr, />=22\.13\.0 and <23/);
  assert.match(tooNew.stderr, /native packages are built for Node\.js 22/);
});
