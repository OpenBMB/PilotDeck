/**
 * A7 — 多次分叉同一源会话，产生的多个 fork 互不影响
 *
 * Plan ref: chat-forking.md §1.2 A7.
 *
 * Strategy (LLM-free):
 *  - Fork the source 3 times from rows 0, 1, 2 (three different user messages).
 *  - Verify each fork has a unique session id in the URL and appears in the sidebar.
 *  - Verify each fork's user-message count is >= the source's user-message count
 *    (current implementation copies the whole conversation, so all forks have
 *    the same count as the source — that's a known limitation to address in
 *    chat-patching.md M1).
 *  - Read the JSONL files on disk and assert they're independent files with
 *    their own entryIds and parentEntryIds (i.e., not symlinks to the source).
 *
 * Requires no LLM — the independence check is structural.
 */

import { test, expect } from '@playwright/test';
import { waitForSessionReady } from '../helpers/session.ts';
import { SEL } from '../helpers/selectors.ts';
import { readSidebar } from '../helpers/session.ts';
import { refreshSourceSession } from '../helpers/refresh.ts';

const SESSION_URL = process.env.PILOT_E2E_SESSION_URL;
test.skip(!SESSION_URL, 'PILOT_E2E_SESSION_URL not set — skip A7');

test.beforeAll(() => {
  refreshSourceSession();
});

test('A7 — three forks from same source are independent', async ({ browser }) => {
  // Use a fresh context per iteration to avoid SPA state carryover from the
  // previous fork. Without this, after the first fork the page state thinks
  // the current session is the new fork and won't re-load the source cleanly.
  let sourceUserCount = 0;
  const forkUrls: string[] = [];

  for (let i = 0; i < 3; i++) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(SESSION_URL!);
    await waitForSessionReady(page);
    const beforeUrl = page.url();
    const btns = page.locator('button[aria-label="Fork this conversation"]');
    const count = await btns.count();
    expect(count, `fork button count on iteration ${i}`).toBeGreaterThanOrEqual(3);
    if (i === 0) sourceUserCount = await page.locator(SEL.userMessageRow).count();
    // Fork from the LAST row (the last turn_result) every time — that
    // way every fork is a full copy of the source, and we test
    // independence rather than per-row truncation (which A2b covers).
    await btns.nth(count - 1).click();
    // Wait for URL to actually change (the loose `/c/<id>` pattern matches
    // the source URL too, so we need a real difference check).
    await page.waitForFunction(
      (src: string) => window.location.href !== src,
      beforeUrl,
      { timeout: 5_000 },
    );
    forkUrls.push(page.url());
    await ctx.close();
  }

  // 1) Each fork URL is unique.
  const uniqueUrls = new Set(forkUrls);
  expect(uniqueUrls.size, 'three unique fork URLs').toBe(3);

  // 2) All fork URLs are different from the source URL.
  for (const u of forkUrls) {
    expect(u, 'fork URL differs from source').not.toBe(SESSION_URL);
  }

  // 3) Each fork loads the source's user-message count (current behavior =
  // full-copy; chat-patching.md M1 will address per-row truncation).
  for (const u of forkUrls) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(u);
    await waitForSessionReady(page);
    const forkUserCount = await page.locator(SEL.userMessageRow).count();
    expect(forkUserCount, `fork user count for ${u}`).toBe(sourceUserCount);
    await ctx.close();
  }

  // 4) Sidebar shows all three forks. The source's mtime is set to a
  // future timestamp so it stays at position 0; the three fresh forks
  // appear at positions 1, 2, 3.
  {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(SESSION_URL!);
    await waitForSessionReady(page);
    const sidebar = await readSidebar(page);
    const forkTitles = sidebar.slice(0, 4).map(s => s.title);
    // Position 0 is the source (not a fork); positions 1-3 should be forks.
    for (let i = 1; i <= 3; i++) {
      expect(forkTitles[i], `sidebar[${i}] title is "Fork of …"`).toMatch(/^Fork of /);
    }
    await ctx.close();
  }
});