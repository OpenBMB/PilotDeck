/**
 * A2 — 点击分叉后 0.5s 内浏览器跳转到新会话 URL
 *
 * Plan ref: chat-forking.md §1.2 A2.
 *
 * Strategy:
 *  - Load session, hover + click the first user message's fork button.
 *  - Use page.evaluate(performance.now) to bracket click → URL change.
 *  - Assert durationMs < 500.
 */

import { test, expect } from '@playwright/test';
import { timeForkClick } from '../helpers/timing.ts';
import { assertIsSessionUrl } from '../helpers/session.ts';
import { refreshSourceSession } from '../helpers/refresh.ts';

const SESSION_URL = process.env.PILOT_E2E_SESSION_URL;
test.skip(!SESSION_URL, 'PILOT_E2E_SESSION_URL not set — skip A2');

test.beforeAll(() => {
  refreshSourceSession();
});

test('A2 — fork click navigates to a new session URL within 500ms', async ({ page }) => {
  await page.goto(SESSION_URL!);
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('button[aria-label="Fork this conversation"]', { timeout: 10_000 });

  const result = await timeForkClick(page, 0);

  // Hard timing assertion: < 500ms.
  expect(result.durationMs, `click→nav took ${result.durationMs}ms`).toBeLessThan(500);

  // URL must be a session URL with a different sessionId from the source.
  const parsed = assertIsSessionUrl(result.url);
  // New session IDs are plain UUIDs (no `web:s_` prefix from server-side forks).
  expect(parsed.sessionId).toMatch(/^[a-f0-9-]{8,}$/i);
  expect(result.url).not.toBe(SESSION_URL);
});