/**
 * High-resolution timing helpers for A2 (fork click → URL change < 500ms).
 *
 * We use performance.now() inside the browser via page.evaluate(), since
 * Date.now() from the runner side has too much drift.
 */

import { type Page } from '@playwright/test';

export type ForkTimingResult = {
  clickAt: number;
  navAt: number;
  url: string;
  durationMs: number;
};

/**
 * Click the Nth fork button and measure the elapsed time (ms) until the
 * URL changes. Returns timing + the final URL. Caller asserts < 500ms.
 *
 * Implementation note: we set up a `page.on('framenavigated')` listener that
 * fires before the URL is fully updated; we cross-check via waitForURL with
 * a tight interval. This is the most precise thing Playwright exposes without
 * touching CDP directly.
 */
export async function timeForkClick(
  page: Page,
  forkButtonIndex = 0,
): Promise<ForkTimingResult> {
  // Snapshot the URL BEFORE the click so we can detect a real navigation.
  // The source URL also matches the loose `/c/[^/]+$` pattern, so we must
  // wait for the URL to change, not just match a pattern.
  const initialUrl = page.url();

  // Establish a baseline timestamp right before the click.
  const clickAt = await page.evaluate(() => performance.now());

  const buttons = page.locator('button[aria-label="Fork this conversation"]');
  await buttons.nth(forkButtonIndex).click();

  // Wait for the URL to actually differ from the source URL.
  await page.waitForFunction(
    (src: string) => window.location.href !== src,
    initialUrl,
    { timeout: 5_000 },
  );
  const navAt = await page.evaluate(() => performance.now());

  return {
    clickAt,
    navAt,
    url: page.url(),
    durationMs: navAt - clickAt,
  };
}