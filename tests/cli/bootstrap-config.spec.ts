import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("config bootstrap does not copy bundled skills into user storage", () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-bootstrap-"));
  try {
    const result = spawnSync(process.execPath, [join(process.cwd(), "scripts", "bootstrap-pilotdeck-config.mjs")], {
      cwd: process.cwd(),
      env: { ...process.env, PILOT_HOME: pilotHome },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(join(pilotHome, "pilotdeck.yaml")), true);
    assert.equal(existsSync(join(pilotHome, "skills")), false);
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});
