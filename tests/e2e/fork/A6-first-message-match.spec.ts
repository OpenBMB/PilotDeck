/**
 * A6 — 新会话的第一条消息对应源会话的该消息；再发新消息可正常走完一轮 turn
 *
 * Plan ref: chat-forking.md §1.2 A6.
 *
 * Strategy:
 *  - Load source session.
 *  - Read first user-message text.
 *  - Click first fork button → new URL.
 *  - Read first message text on new session — assert equality.
 *  - Type a follow-up message in the composer, send, wait for assistant response.
 *
 * Notes:
 *  - This test is split into two: A6a checks the file-content match (no LLM),
 *    A6b exercises the LLM roundtrip. A6b is skipped when SKIP_LLM=1.
 */

import { test, expect } from '@playwright/test';
import { waitForSessionReady } from '../helpers/session.ts';
import { SEL } from '../helpers/selectors.ts';
import { refreshSourceSession } from '../helpers/refresh.ts';

const SESSION_URL = process.env.PILOT_E2E_SESSION_URL;
const SKIP_LLM = process.env.PILOT_E2E_SKIP_LLM === '1';
test.skip(!SESSION_URL, 'PILOT_E2E_SESSION_URL not set — skip A6');

test.beforeAll(() => {
  refreshSourceSession();
});

test('A6a — first user message matches between source and fork', async ({ page }) => {
  await page.goto(SESSION_URL!);
  await waitForSessionReady(page);

  // Capture source first user-message text.
  const sourceFirst = (
    await page.locator(SEL.userMessageRow).first().textContent()
  )?.trim();
  expect(sourceFirst, 'source first message text').toBeTruthy();

  // Fork.
  await page.locator('button[aria-label="Fork this conversation"]').first().click();
  await page.waitForURL(/\/c\/[^/]+$/, { timeout: 5_000 });
  await page.waitForLoadState('networkidle');

  // Compare first message text.
  const forkFirst = (
    await page.locator(SEL.userMessageRow).first().textContent()
  )?.trim();
  expect(forkFirst).toBe(sourceFirst);
});

test('A6b — fork accepts a new user turn and produces an assistant reply', async ({ page }) => {
  test.skip(SKIP_LLM, 'PILOT_E2E_SKIP_LLM=1, skipping LLM roundtrip');

  await page.goto(SESSION_URL!);
  await waitForSessionReady(page);
  await page.locator('button[aria-label="Fork this conversation"]').first().click();
  await page.waitForURL(/\/c\/[^/]+$/, { timeout: 5_000 });
  await page.waitForLoadState('networkidle');

  const composer = page.locator('textarea').first();
  await expect(composer).toBeVisible();
  const marker = `[e2e-${Date.now()}] hello after fork`;
  await composer.fill(marker);
  await composer.press('Enter');

  // Wait for the marker to appear.
  await page.waitForFunction(
    (m) => Array.from(document.querySelectorAll(SEL.messageRow))
      .some(el => (el.textContent ?? '').includes(m)),
    marker,
    { timeout: 5_000 },
  );
  // Wait for an assistant reply after the marker.
  await page.waitForFunction(
    () => document.querySelectorAll(SEL.assistantMessageRow).length >= 2,
    undefined,
    { timeout: 60_000 },
  );
});