/**
 * A1 — 任何用户消息上 hover 出现「分叉」入口
 *
 * Plan ref: chat-forking.md §1.2 A1, fork-browser-testing.md §2 A1.
 *
 * Strategy:
 *  - Load a session known to have N >= 3 user messages.
 *  - On each user message row, hover and assert fork button becomes visible.
 *  - Negative assertion: on assistant rows, fork button MUST NOT appear.
 *
 * Selector: the fork button is rendered with aria-label="Fork this conversation".
 * See helpers/selectors.ts.
 */

import { test, expect } from '@playwright/test';
import { SEL } from '../helpers/selectors.ts';
import { waitForSessionReady, readUserMessageTexts } from '../helpers/session.ts';
import { refreshSourceSession } from '../helpers/refresh.ts';

// Session ID and project are environment-injected so this suite is hermetic.
// In CI: set PILOT_E2E_SESSION_URL to e.g. http://localhost:5173/p/<project>/c/<id>.
const SESSION_URL = process.env.PILOT_E2E_SESSION_URL;
test.skip(!SESSION_URL, 'PILOT_E2E_SESSION_URL not set — skip A1');

test.beforeAll(() => {
  refreshSourceSession();
});

test.describe('A1 — fork button on user messages', () => {
  test('user messages 1, mid, last all show fork button on hover', async ({ page }) => {
    await page.goto(SESSION_URL!);
    await waitForSessionReady(page);

    const userTexts = await readUserMessageTexts(page);
    expect(userTexts.length).toBeGreaterThanOrEqual(3);

    // Each user row renders a fork button. Hover the row and confirm it shows.
    const userRows = page.locator(SEL.userMessageRow);
    const count = await userRows.count();
    expect(count).toBeGreaterThanOrEqual(3);

    for (const idx of [0, Math.floor(count / 2), count - 1]) {
      await userRows.nth(idx).hover();
      // The fork button is inside the user row's action area.
      const btn = userRows.nth(idx).locator(SEL.forkButton);
      await expect(btn, `fork button on user row #${idx}`).toBeVisible();
    }
  });

  test('assistant messages do NOT show a fork button (negative assertion)', async ({ page }) => {
    await page.goto(SESSION_URL!);
    await waitForSessionReady(page);

    // A more robust negative check: count fork buttons visible vs. user-row count.
    // If fork buttons > user-row count, something on assistant rows is rendering the button.
    const userRows = page.locator(SEL.userMessageRow);
    const userCount = await userRows.count();
    const forkButtons = page.locator(SEL.forkButton);
    const forkCount = await forkButtons.count();

    expect(
      forkCount,
      `expected ${userCount} fork buttons (one per user row), got ${forkCount}`,
    ).toBe(userCount);
  });
});