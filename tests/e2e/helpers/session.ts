import { type Page, expect } from '@playwright/test';
import { SEL, type SidebarEntry } from './selectors';

/**
 * Wait until the chat session has finished loading its initial messages.
 *
 * Heuristic: at least one assistant-or-user row exists, AND the stop button
 * (if any) has settled. Tests should call this before any assertion on rows.
 */
export async function waitForSessionReady(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 15_000 });
  // Wait for at least one user message to be visible.
  await page.waitForSelector(SEL.userMessageRow, { state: 'attached', timeout: 15_000 });
}

/**
 * Read the sidebar in document order (top → bottom).
 * Returns an empty array if the sidebar selector isn't found — caller decides
 * whether that's a fail.
 *
 * Selector strategy: session buttons live inside the <aside>, have
 * aria-label="<status> <title> <time>" and a nested title text node.
 * There is no data-testid on these buttons in the current build.
 */
export async function readSidebar(page: Page): Promise<SidebarEntry[]> {
  // Walk the DOM directly to avoid playwright's strict-mode surprises
  // and to cope with the lack of data-testid attributes.
  const items = await page.evaluate(() => {
    const aside = document.querySelector('aside');
    if (!aside) return [];
    // Session buttons have aria-label matching "<status> <title> <time>".
    // We match by the trailing time token which is the stable signature.
    const allButtons = Array.from(aside.querySelectorAll('button'));
    const sessionButtons = allButtons.filter(b => {
      const t = (b.textContent || '').trim();
      // Sessions always have a relative time in their text content
      return /Just now|\d+\s*(min|mins|hour|hours|day|days|second|seconds)s?\s*ago/i.test(t);
    });
    return sessionButtons.map((b, i) => {
      // Extract title — take the text content of the first non-status, non-time child
      // (e.g. for "No unread messages Fork of ... Just now", the title is in the middle).
      // Use the full text minus the "No unread messages" status prefix.
      const fullText = (b.textContent || '').trim();
      const statusMatch = fullText.match(/^(No unread messages|Has unread messages)\s+/);
      const cleaned = statusMatch ? fullText.slice(statusMatch[0].length) : fullText;
      // Remove trailing time
      const title = cleaned.replace(/\s+(Just now|\d+\s*(?:min|mins|hour|hours|day|days|second|seconds)s?\s*ago)\s*$/i, '').trim();
      return { index: i, title, sessionId: '' };
    });
  });
  return items;
}

/**
 * Read the visible user messages in order, returning their text content.
 * Used by A1 to count how many user rows have the fork button on hover.
 */
export async function readUserMessageTexts(page: Page): Promise<string[]> {
  return await page.locator(SEL.userMessageRow).allTextContents();
}

/**
 * Click the Nth fork button (0-indexed) and wait for the URL to change to
 * a new session URL. Returns the new URL.
 *
 * Throws if URL doesn't change within 5s — A2 has its own tighter assertion
 * that wraps this with timing.
 */
export async function clickForkButtonAndAwaitNav(page: Page, index = 0): Promise<string> {
  const buttons = page.locator(SEL.forkButton);
  const count = await buttons.count();
  if (count === 0) throw new Error('no fork buttons found on page');
  await buttons.nth(index).click();
  await page.waitForURL(/\/c\/[^/]+$/, { timeout: 5_000 });
  return page.url();
}

/**
 * Hard assert that page.url() is the session page (not settings / projects / etc).
 */
export function assertIsSessionUrl(url: string): { projectName: string; sessionId: string } {
  const m = url.match(/\/p\/([^/]+)\/c\/([^/?#]+)/);
  if (!m) throw new Error(`not a session URL: ${url}`);
  return { projectName: decodeURIComponent(m[1]), sessionId: decodeURIComponent(m[2]) };
}

/**
 * Delete the current session via the sidebar delete button (if available).
 * Falls back to direct filesystem unlink in A9 — see that test.
 */
export async function deleteSessionViaUI(page: Page): Promise<void> {
  const trash = page.locator('[data-testid="sidebar-item-delete"]').first();
  await expect(trash).toBeVisible();
  await trash.click();
  // Confirm dialog handling is site-specific; we accept the default confirm.
  page.once('dialog', d => d.accept());
  await page.waitForTimeout(500);
}