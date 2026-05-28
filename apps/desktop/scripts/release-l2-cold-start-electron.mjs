#!/usr/bin/env node
/**
 * L2 cold-start — Electron first launch with NO pilotdeck.yaml (new user path).
 * Uses an isolated temp HOME; does NOT read or write ~/.pilotdeck on the host.
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { _electron as electron } from "playwright";

function killPackagedPilotDeck() {
  try {
    execSync('pkill -f "PilotDeck.app/Contents/MacOS/PilotDeck" 2>/dev/null || true', {
      stdio: "ignore",
    });
  } catch {
    /* ignore */
  }
}

const appPath = process.env.PD_APP;
if (!appPath) {
  console.error("PD_APP must point to PilotDeck.app");
  process.exit(2);
}

const execPath = path.join(appPath, "Contents/MacOS/PilotDeck");
if (!fs.existsSync(execPath)) {
  console.error(`Missing executable: ${execPath}`);
  process.exit(2);
}

const realPilotHome = path.join(os.homedir(), ".pilotdeck");
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "pilotdeck-coldstart-"));
const pilotHome = path.join(sandboxHome, ".pilotdeck");
fs.mkdirSync(pilotHome, { recursive: true });
// Intentionally no pilotdeck.yaml — triggers desktop onboarding.

console.log(`  isolated HOME: ${sandboxHome}`);
console.log(`  (host ${realPilotHome} is not modified)`);

let electronApp;
try {
  electronApp = await electron.launch({
    executablePath: execPath,
    env: {
      ...process.env,
      HOME: sandboxHome,
      PILOT_HOME: pilotHome,
      PILOTDECK_E2E_MOCK_PROVIDER: "1",
    },
    timeout: 180_000,
  });

  const deadline = Date.now() + 120_000;
  let onboardingPage = null;
  while (Date.now() < deadline) {
    for (const w of electronApp.windows()) {
      const title = await w.title().catch(() => "");
      const url = w.url();
      if (title.includes("初始化") || url.includes("onboarding")) {
        onboardingPage = w;
        break;
      }
    }
    if (onboardingPage) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!onboardingPage) {
    throw new Error("Onboarding window did not appear (expected first-run with empty config)");
  }
  console.log("  ✓ Onboarding window opened");

  await onboardingPage.locator("#base-url").fill("https://api.anthropic.com");
  await onboardingPage.locator("#api-key").fill("sk-smoke-test-not-real");
  await onboardingPage.locator("#model-name").fill("claude-sonnet-4-5-20250929");
  await onboardingPage.locator("#test-btn").click();
  await onboardingPage.waitForSelector(".status.success, .status.info", { timeout: 30_000 });
  await onboardingPage.locator("#save-btn").click();

  const cfgPath = path.join(pilotHome, "pilotdeck.yaml");
  const cfgDeadline = Date.now() + 60_000;
  while (Date.now() < cfgDeadline) {
    if (fs.existsSync(cfgPath)) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  if (!fs.existsSync(cfgPath)) {
    throw new Error(`Config not written under isolated PILOT_HOME: ${cfgPath}`);
  }
  const yaml = fs.readFileSync(cfgPath, "utf8");
  if (!yaml.includes("schemaVersion: 1")) {
    throw new Error("Onboarding wrote non-V2 config (missing schemaVersion: 1)");
  }
  if (!yaml.includes("agent:") || !yaml.includes("model:")) {
    throw new Error("Onboarding config missing agent/model sections");
  }
  console.log("  ✓ Onboarding saved V2 pilotdeck.yaml in isolated home");

  const mainDeadline = Date.now() + 120_000;
  let mainPage = null;
  while (Date.now() < mainDeadline) {
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
    throw new Error("Main UI window did not load after onboarding");
  }
  await mainPage.waitForSelector('[role="tablist"]', { timeout: 90_000 });
  console.log(`  ✓ Main window after onboarding: ${mainPage.url()}`);
} finally {
  if (electronApp) await electronApp.close().catch(() => {});
  killPackagedPilotDeck();
  await new Promise((r) => setTimeout(r, 1500));
  try {
    fs.rmSync(sandboxHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Electron may leave sockets/logs briefly; test result already decided above.
  }
}

console.log("\nL2 cold-start Electron PASSED");
