#!/usr/bin/env node
/**
 * L2 onboarding smoke — Playwright drives onboarding.html with a mocked IPC bridge.
 * Verifies form flow + V2 YAML shape via onboarding-config (no Electron required).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const { buildConfigYaml } = require("../dist/onboarding-config.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(__dirname, "..");
const htmlPath = path.join(desktopRoot, "onboarding", "onboarding.html");

if (!fs.existsSync(htmlPath)) {
  console.error(`Onboarding HTML missing: ${htmlPath}`);
  console.error("Run: (cd apps/desktop && npm run build)");
  process.exit(2);
}

const savedPayloads = [];

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();

await page.addInitScript(() => {
  window.pilotdeckOnboarding = {
    testProvider: async () => ({
      overall: "ok",
      checks: [{ name: "mock", status: "ok" }],
      durationMs: 1,
    }),
    save: async (payload) => {
      window.__onboardingSaved = payload;
      return { ok: true };
    },
    cancel: () => {
      window.__onboardingCancelled = true;
    },
  };
});

await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "domcontentloaded" });

await page.locator("#base-url").fill("https://api.anthropic.com");
await page.locator("#api-key").fill("sk-smoke-test-not-real");
await page.locator("#model-name").fill("claude-sonnet-4-5-20250929");

await page.locator("#test-btn").click();
await page.waitForSelector(".status.success, .status.info", { timeout: 15_000 });

await page.locator("#save-btn").click();
await page.waitForFunction(() => window.__onboardingSaved != null, null, { timeout: 15_000 });

const payload = await page.evaluate(() => window.__onboardingSaved);
savedPayloads.push(payload);

await browser.close();

const yaml = buildConfigYaml(payload);
if (!yaml.includes("schemaVersion: 1")) {
  console.error("✗ buildConfigYaml missing schemaVersion: 1");
  process.exit(1);
}
if (!yaml.includes("agent:") || !yaml.includes("model:")) {
  console.error("✗ buildConfigYaml missing agent/model sections");
  process.exit(1);
}
if (!yaml.includes("pilotdeck/claude-sonnet-4-5-20250929")) {
  console.error("✗ buildConfigYaml missing agent.model ref");
  process.exit(1);
}

console.log("  ✓ onboarding form → save payload");
console.log("  ✓ buildConfigYaml produces V2 YAML");
console.log("\nL2 onboarding smoke PASSED");
