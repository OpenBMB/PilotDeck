#!/usr/bin/env node
/**
 * L2c Electron smoke (Windows) — launches packaged PilotDeck.exe with an isolated
 * PILOT_HOME and stub V2 config, then asserts the main window loads the local UI URL.
 *
 * Usage:
 *   node scripts/release-l2c-electron-smoke-win.mjs
 *   PD_APP=C:\...\win-unpacked node scripts/release-l2c-electron-smoke-win.mjs
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { _electron as electron } from "playwright";

function killPackagedPilotDeck() {
  try {
    execSync('taskkill /F /IM PilotDeck.exe /T 2>NUL', { stdio: "ignore", shell: "cmd.exe" });
  } catch { /* ignore */ }
}

const appPath = process.env.PD_APP;
if (!appPath) {
  console.error("PD_APP must point to the win-unpacked directory");
  process.exit(2);
}

const execPath = path.join(appPath, "PilotDeck.exe");
if (!fs.existsSync(execPath)) {
  console.error(`Missing executable: ${execPath}`);
  process.exit(2);
}

const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "pilotdeck-e2e-home-"));
const pilotHome = path.join(sandboxHome, ".pilotdeck");
fs.mkdirSync(pilotHome, { recursive: true });

const stubYaml = `schemaVersion: 1
agent:
  model: pilotdeck/claude-sonnet-4-5-20250929
model:
  providers:
    pilotdeck:
      protocol: anthropic
      url: "https://api.anthropic.com"
      apiKey: "smoke-test-not-real"
      models:
        claude-sonnet-4-5-20250929: {}
`;
fs.writeFileSync(path.join(pilotHome, "pilotdeck.yaml"), stubYaml);

console.log(`  PD_APP: ${appPath}`);
console.log(`  Exec:   ${execPath}`);
console.log(`  Home:   ${sandboxHome}`);

let electronApp;
try {
  electronApp = await electron.launch({
    executablePath: execPath,
    env: {
      ...process.env,
      HOME: sandboxHome,
      USERPROFILE: sandboxHome,
      PILOT_HOME: pilotHome,
      PILOTDECK_E2E: "1",
    },
    timeout: 120_000,
  });

  const deadline = Date.now() + 120_000;
  let mainPage = null;
  while (Date.now() < deadline) {
    for (const w of electronApp.windows()) {
      const url = w.url();
      if (url.includes("127.0.0.1")) {
        mainPage = w;
        break;
      }
    }
    if (mainPage) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!mainPage) {
    const urls = electronApp.windows().map((w) => w.url());
    throw new Error(
      `Main UI window did not appear within 120s (windows: ${urls.join(", ") || "none"})`,
    );
  }
  await mainPage.waitForLoadState("domcontentloaded", { timeout: 60_000 });
  console.log(`  ✓ Electron main window loaded: ${mainPage.url()}`);

  await mainPage.waitForSelector('[role="tablist"]', { timeout: 90_000 });
  console.log("  ✓ Main shell tablist visible");
} finally {
  if (electronApp) await electronApp.close().catch(() => {});
  killPackagedPilotDeck();
  await new Promise((r) => setTimeout(r, 1500));
  try {
    fs.rmSync(sandboxHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch { /* ignore cleanup races */ }
}

console.log("\nL2c Electron smoke PASSED (Windows)");
