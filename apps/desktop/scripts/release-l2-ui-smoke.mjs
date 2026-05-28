#!/usr/bin/env node
/**
 * L2 UI smoke — Playwright against the packaged UI server (same surface Electron loads).
 * Requires PD_UI_URL (e.g. http://127.0.0.1:28790) and a running Gateway + bridge.
 */
import { chromium } from "playwright";

const baseUrl = (process.env.PD_UI_URL || "http://127.0.0.1:18790").replace(/\/$/, "");
const tabLabels = (process.env.PD_UI_TABS || "Agent,Files,Skills,Routing,Memory")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const failures = [];

async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ✗ ${name}: ${msg}`);
    failures.push(name);
  }
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();
const page = await context.newPage();

page.on("pageerror", (e) => {
  console.error(`  ⚠ pageerror: ${e.message}`);
});

await check("GET /health", async () => {
  const res = await page.request.get(`${baseUrl}/health`);
  if (!res.ok()) throw new Error(`HTTP ${res.status()}: ${await res.text()}`);
  const body = await res.json();
  if (body?.status !== "ok") throw new Error(JSON.stringify(body));
});

await check("SPA shell loads", async () => {
  const res = await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
  if (!res || !res.ok()) throw new Error(`navigation failed: ${res?.status()}`);
  await page.waitForSelector('[role="tablist"]', { timeout: 60_000 });
});

await check("WebSocket / API projects", async () => {
  const res = await page.request.get(`${baseUrl}/api/projects`);
  if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
});

for (const label of tabLabels) {
  await check(`Tab: ${label}`, async () => {
    const tab = page.getByRole("tab", { name: label, exact: true });
    await tab.click({ timeout: 15_000 });
    await page.waitForTimeout(400);
    const selected = await tab.getAttribute("aria-selected");
    if (selected !== "true") throw new Error(`tab not selected after click`);
  });
}

await check("Settings entry reachable", async () => {
  const settings = page.getByRole("button", { name: "Settings" });
  if ((await settings.count()) === 0) return;
  await settings.first().click({ timeout: 10_000 });
  await page.waitForTimeout(500);
});

await browser.close();

if (failures.length > 0) {
  console.error(`\nL2 UI smoke FAILED (${failures.length}): ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nL2 UI smoke PASSED");
