import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const template = readFileSync(new URL(`../${packageJson.build.rpm.afterRemove}`, import.meta.url), "utf8");

for (const alternatives of [false, true]) {
  for (const remaining of ["0", "1"]) {
    test(`RPM postun with ${remaining} remaining packages ${alternatives ? "uses alternatives" : "uses a symlink"}`, {skip: process.platform === "win32"}, () => {
      const root = mkdtempSync(join(tmpdir(), "pilotdeck-rpm-scriptlet-"));
      try {
        const bin = join(root, "bin");
        mkdirSync(bin);
        const calls = join(root, "calls.txt");
        const executable = "pilotdeck-scriptlet-test";
        const script = join(root, "postun.sh");
        writeFileSync(script, template.replaceAll("${executable}", executable).replaceAll("${sanitizedProductName}", "PilotDeck"));
        for (const tool of alternatives ? ["rm", "update-alternatives"] : ["rm"]) {
          writeFileSync(join(bin, tool), `#!/bin/sh\nprintf '%s\\n' "${tool} $*" >> "$SCRIPTLET_CALLS"\n`, { mode: 0o755 });
        }
        const result = spawnSync("/bin/sh", [script, remaining], {
          encoding: "utf8", env: {...process.env, PATH: bin, SCRIPTLET_CALLS: calls},
        });
        assert.equal(result.status, 0, result.stderr);
        const actual = (() => {try {return readFileSync(calls, "utf8");} catch {return "";}})();
        const expected = remaining === "1" ? "" : alternatives
          ? `update-alternatives --remove ${executable} /opt/PilotDeck/${executable}\n`
          : `rm -f /usr/bin/${executable}\n`;
        assert.equal(actual, expected);
      } finally {
        rmSync(root, {recursive: true, force: true});
      }
    });
  }
}
