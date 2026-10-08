import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const installer = fileURLToPath(new URL("../../../src/extension/plugins/builtin/browser-use/scripts/install-browser.mjs", import.meta.url));

for (const arch of ["x64", "arm64"]) {
  test(`lazy Windows ${arch} browser install reaches the official installer and reuses its cache`, () => {
    const root = mkdtempSync(join(tmpdir(), "pilotdeck-browser-install-"));
    try {
      const runtime = join(root, "runtime");
      const browsers = join(root, "browsers");
      const mcp = join(runtime, "node_modules", "@playwright", "mcp");
      const core = join(runtime, "node_modules", "playwright-core");
      mkdirSync(mcp, { recursive: true });
      mkdirSync(core, { recursive: true });
      mkdirSync(join(runtime, "dist", "src", "cli"), { recursive: true });
      writeFileSync(join(runtime, "dist", "src", "cli", "pilotdeck.js"), "");
      writeFileSync(join(core, "browsers.json"), JSON.stringify({ browsers: [{name: "chromium", revision: "1224", browserVersion: "149.0.7827.3"}] }));
      const calls = join(root, "calls.json");
      writeFileSync(join(mcp, "cli.js"), `
        const fs = require('node:fs'), path = require('node:path');
        fs.writeFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)));
        const directory = path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium-1224');
        fs.mkdirSync(directory, {recursive:true});
        fs.writeFileSync(path.join(directory, 'INSTALLATION_COMPLETE'), '');
      `);
      const preload = join(root, "platform.cjs");
      writeFileSync(preload, `Object.defineProperty(process, 'platform', {value:'win32'}); Object.defineProperty(process, 'arch', {value:${JSON.stringify(arch)}});`);
      const options = {
        encoding: "utf8",
        timeout: 20000,
        windowsHide: true,
        env: {...process.env, PILOTDECK_RUNTIME_ROOT: runtime, PLAYWRIGHT_BROWSERS_PATH: browsers,
          PILOTDECK_DESKTOP_PLAYWRIGHT_MIRROR: "official", PILOTDECK_DESKTOP_PLAYWRIGHT_ARCHIVE_DIR: "",
          PILOTDECK_DESKTOP_PLAYWRIGHT_BROWSER_SET: "browser-only"},
      };
      const first = spawnSync(process.execPath, ["--require", preload, installer], options);
      assert.equal(first.status, 0, first.stderr);
      assert.deepEqual(JSON.parse(readFileSync(calls, "utf8")), ["install-browser", "chrome-for-testing", "--no-shell"]);
      const second = spawnSync(process.execPath, ["--require", preload, installer], options);
      assert.equal(second.status, 0, second.stderr);
      assert.match(second.stdout, /already installed/);
      rmSync(calls);
      const mirroredCache = spawnSync(process.execPath, ["--require", preload, installer], {
        ...options, env: {...options.env, PILOTDECK_DESKTOP_PLAYWRIGHT_MIRROR: "npmmirror"},
      });
      assert.equal(mirroredCache.status, 0, mirroredCache.stderr);
      assert.match(mirroredCache.stdout, /already installed/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
