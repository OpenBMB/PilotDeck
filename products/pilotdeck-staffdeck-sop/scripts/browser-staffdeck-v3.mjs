import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
const { chromium } = createRequire(new URL("../../../ui/package.json", import.meta.url))("@playwright/test");
const root = process.env.SOP_ACCEPTANCE_ROOT;
assert.ok(root);
const credentials = JSON.parse(await readFile(join(root, "credentials.json"), "utf8"));
const host = process.env.SOP_ACCEPTANCE_HOST ?? "http://127.0.0.1:26390";
const web = process.env.SOP_ACCEPTANCE_WEB ?? "http://127.0.0.1:26394";
await mkdir(root, { recursive: true });
const results = [];
async function call(path, body) {
  const response = await fetch(host + path, { method: body ? "POST" : "GET", headers: {
    authorization: `Bearer ${credentials["sop-actor"].token}`, "content-type": "application/json",
  }, body: body ? JSON.stringify(body) : undefined });
  const value = await response.json();
  assert.ok(response.ok, JSON.stringify(value));
  return value;
}
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  for (const width of [1440, 390]) {
    const marker = `BROWSER_${width}_${Date.now()}`;
    const session = await call("/api/chat/sessions", { tenant_id: "sop-acceptance", agent_id: credentials.agentId, title: `Browser approval ${width}` });
    await call("/api/chat/turn", { tenant_id: "sop-acceptance", agent_id: credentials.agentId,
      session_id: session.id, model_config_id: credentials.modelConfigId,
      message: `/sop release_acceptance The release ticket is SOP-1014. Request operator approval. Reference ${marker}.` });
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 960 } });
    const reviewer = { token: credentials["sop-reviewer"].token, user: { id: "sop-reviewer", tenant_id: "sop-acceptance", username: "sop-reviewer", role: "admin", source: "web" } };
    await context.addInitScript(value => {
      localStorage.setItem("ultrarag_auth", JSON.stringify(value));
      localStorage.setItem("staffdeck_onboarding_guide_seen", "1");
      localStorage.setItem("staffdeck_quick_start_guide_seen", "1");
    }, reviewer);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("response", response => {
      if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`);
    });
    await page.goto(web + "/workspace/chat");
    const skip = page.getByRole("button", { name: "跳过", exact: true });
    if (await skip.isVisible({ timeout: 5000 }).catch(() => false)) await skip.click();
    await page.screenshot({ path: join(root, `sd-inbox-before-${width}.png`), fullPage: true });
    const inbox = page.getByRole("button", { name: /待回答/ }).first();
    try {
      await inbox.click({ timeout: 30000 });
    } catch (error) {
      await page.screenshot({ path: join(root, `sd-inbox-failed-${width}.png`), fullPage: true });
      throw new Error(`${error.message}; URL=${page.url()}; ${errors.join("; ")}`);
    }
    const dialog = page.getByRole("dialog");
    const article = dialog.locator("article").filter({ hasText: marker });
    await article.locator("textarea").fill(`Approved SOP-1014 at ${width}px. Complete the procedure.`);
    const [response] = await Promise.all([
      page.waitForResponse(value => value.url().includes("/handoffs/") && value.url().endsWith("/reply")),
      article.getByRole("button", { name: "回复并恢复", exact: true }).click(),
    ]);
    assert.ok(response.ok(), await response.text());
    const reply = await response.json();
    assert.equal(reply.session_id, session.id);
    await page.screenshot({ path: join(root, `sd-inbox-after-${width}.png`), fullPage: true });
    const overflow = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      elements: [...document.querySelectorAll("body *")].filter(element => element.getBoundingClientRect().right > innerWidth + 1)
        .slice(0, 8).map(element => ({ tag: element.tagName, class: element.className })) }));
    assert.ok(overflow.scrollWidth <= overflow.width, JSON.stringify(overflow));
    results.push({ width, sessionId: session.id, status: "PASS", reply, pageErrors: errors });
    await context.close();
  }
} catch (error) {
  results.push({ status: "FAIL", error: error.message });
  process.exitCode = 1;
} finally {
  await writeFile(join(root, "browser-staffdeck.json"), JSON.stringify(results, null, 2));
  await browser.close();
}
console.log(JSON.stringify(results.map(({ width, status, error }) => ({ width, status, error }))));
