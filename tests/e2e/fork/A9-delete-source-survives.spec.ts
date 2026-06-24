/**
 * A9 — fork 之后删除源会话，新会话仍能正常加载
 *
 * Plan ref: chat-forking.md §1.2 A9.
 *
 * Strategy:
 *  - Pick a *sacrificial* source session (one we don't share with A1-A7).
 *    This test DELETES the source via the same DELETE endpoint the UI uses,
 *    which empties the JSONL file and removes it from the sidebar. We don't
 *    want that to break the canonical test session used by other specs.
 *  - Fork it once via UI to capture a known-good fork URL.
 *  - Delete the source via the API.
 *  - Navigate to the fork URL — must still load.
 *
 * The sacrificial source is identified by PILOT_E2E_SACRIFICE_SESSION_URL.
 * If unset, we fall back to PILOT_E2E_SESSION_URL (legacy behavior), but
 * note this will break subsequent runs.
 */

import { test, expect, request } from '@playwright/test';
import { waitForSessionReady, assertIsSessionUrl } from '../helpers/session.ts';
import { SEL } from '../helpers/selectors.ts';
import { refreshSourceSession } from '../helpers/refresh.ts';
import { execSync } from 'node:child_process';

const SESSION_URL = process.env.PILOT_E2E_SESSION_URL;
const SACRIFICE_URL = process.env.PILOT_E2E_SACRIFICE_SESSION_URL;
test.skip(!SESSION_URL, 'PILOT_E2E_SESSION_URL not set — skip A9');

test.beforeAll(() => {
  refreshSourceSession();
  // Bootstrap a fresh sacrificial session for THIS run. The previous run
  // deleted the prior sacrifice, so we always create a new one here. The
  // script writes to /Users/macmini-01/.pilotdeck/projects/.../chats and
  // prints the new session ID to stdout.
  const out = execSync(
    'cd ~/.pilotdeck/app && NODE_OPTIONS=--import\\ tsx npx tsx tests/e2e/create-test-source.ts',
    { shell: '/bin/zsh', encoding: 'utf-8', env: { ...process.env, PATH: '/opt/homebrew/bin:' + (process.env.PATH ?? '') } },
  );
  const newId = out.trim().split('\n').pop()!;
  process.env.PILOT_E2E_SACRIFICE_SESSION_URL = `http://127.0.0.1:5173/p/general/c/${newId}`;
  console.log('[A9] sacrifice session:', newId);
});

test('A9 — fork survives source deletion', async ({ page }) => {
  // Prefer the sacrificial URL so we don't kill the canonical test session.
  const sourceUrl = process.env.PILOT_E2E_SACRIFICE_SESSION_URL ?? SACRIFICE_URL ?? SESSION_URL!;
  const baseURL = process.env.PILOT_E2E_BASE_URL ?? 'http://127.0.0.1:5173';

  // 1. Fork the source via UI to capture a known-good fork URL.
  await page.goto(sourceUrl);
  await waitForSessionReady(page);
  const beforeUrl = page.url();
  await page.locator('button[aria-label="Fork this conversation"]').first().click();
  // Wait for URL to actually change (loose pattern matches source too).
  await page.waitForFunction(
    (src: string) => window.location.href !== src,
    beforeUrl,
    { timeout: 5_000 },
  );
  const forkUrl = page.url();
  const forkParsed = assertIsSessionUrl(forkUrl);
  const sourceParsed = assertIsSessionUrl(sourceUrl);

  // 2. Delete the source session via the same API the UI uses.
  // Endpoint per server/index.js:715:
  //   DELETE /api/projects/:projectName/sessions/:sessionId
  const ctx = await request.newContext({ baseURL });
  const delRes = await ctx.delete(
    `/api/projects/${encodeURIComponent(sourceParsed.projectName)}/sessions/${encodeURIComponent(sourceParsed.sessionId)}`,
  );
  expect(delRes.status(), 'source delete HTTP status').toBeLessThan(400);

  // 3. Navigate to fork URL — must still load.
  const resp = await page.goto(forkUrl);
  expect(resp, 'fork page HTTP response').not.toBeNull();
  expect(resp!.status(), 'fork HTTP status').toBe(200);

  // 4. First message still rendered.
  const firstText = (
    await page.locator(SEL.userMessageRow).first().textContent({ timeout: 10_000 })
  )?.trim();
  expect(firstText, 'fork first message text').toBeTruthy();
});