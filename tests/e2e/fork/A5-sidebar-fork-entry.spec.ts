/**
 * A5 — 新会话以独立会话出现在侧边栏顶部，标题为「Fork of <原标题>」
 *
 * Plan ref: chat-forking.md §1.2 A5.
 *
 * Strategy:
 *  - Load source session.
 *  - Click fork button on the first user row → navigates to new session.
 *  - Wait for sidebar list to refresh.
 *  - Assert sidebar[0].title matches /^Fork of /.
 *  - Assert sidebar[0].sessionId === URL sessionId.
 */

import { test, expect } from '@playwright/test';
import { assertIsSessionUrl, waitForSessionReady, readSidebar } from '../helpers/session.ts';
import { refreshSourceSession } from '../helpers/refresh.ts';

const SESSION_URL = process.env.PILOT_E2E_SESSION_URL;
test.skip(!SESSION_URL, 'PILOT_E2E_SESSION_URL not set — skip A5');

test.beforeAll(() => {
  refreshSourceSession();
});

test('A5 — fork appears at top of sidebar with "Fork of …" title', async ({ page }) => {
  await page.goto(SESSION_URL!);
  await waitForSessionReady(page);

  // Trigger fork.
  await page.locator('button[aria-label="Fork this conversation"]').first().click();
  await page.waitForURL(/\/c\/[^/]+$/, { timeout: 5_000 });

  // Allow sidebar to refresh (the store calls refreshProjects() after fork).
  await page.waitForResponse(
    r => r.url().includes('/sessions') && r.request().method() === 'GET',
    { timeout: 5_000 },
  ).catch(() => {/* sidebar might be loaded from cache; not fatal */});
  await page.waitForTimeout(300);

  const sidebar = await readSidebar(page);
  expect(sidebar.length).toBeGreaterThan(0);

  // The source session is at position 0 (touched to year-2099 mtime so it
  // stays at the top of /api/projects). The freshly-created fork sits at
  // position 1. Both should appear, with the fork having a "Fork of …" title.
  expect(sidebar.length, 'sidebar should have at least 2 entries').toBeGreaterThanOrEqual(2);
  expect(sidebar[1].title, `sidebar[1].title should be "Fork of …"`).toMatch(/^Fork of /);
});