/**
 * A10 — Chain-fork: a fork of a fork must succeed and produce a new
 * transcript whose entryIds use the *new* fork's `__fork_<shortTag>`
 * suffix, not a stacked `__fork_first__fork_second` chain.
 *
 * Plan ref: chat-forking.md §6 "Chain-fork" (proposed; deprecates the
 * previous "reject double-fork" defense).
 *
 * Strategy (LLM-free):
 *   - Source session has 3 user turns (9 JSONL lines).
 *   - Fork from row 0 → first fork (3 lines, suffix A).
 *   - Fork the first fork from its row 0 → second fork (3 lines, suffix B).
 *   - Assert: second fork's entryIds end with `__fork_<B>`, never `__fork_<A>`.
 *   - Assert: source and first-fork JSONL are unchanged (sha256 before/after).
 *   - Assert: second fork has a sidecar meta.json with `forkedFrom.sessionId`
 *     pointing at the first fork (not at the original source).
 */

import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { waitForSessionReady, assertIsSessionUrl } from '../helpers/session.ts';
import { refreshSourceSession } from '../helpers/refresh.ts';

const SESSION_URL = process.env.PILOT_E2E_SESSION_URL;
test.skip(!SESSION_URL, 'PILOT_E2E_SESSION_URL not set — skip A10');

const HOME = '/Users/macmini-01/.pilotdeck';
const PROJECT_DIR = `${HOME}/projects/Users-macmini-01-.pilotdeck/chats`;

test.beforeAll(() => {
  refreshSourceSession();
});

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function shortTag(sessionId: string): string {
  return sessionId.replace(/-/g, '').slice(0, 8).toLowerCase();
}

test('A10 — chain-fork produces a new fork whose entryIds use the new suffix only', async ({ page }) => {
  // ── Step 1: load the source session. ─────────────────────────────────
  const sourceParsed = assertIsSessionUrl(SESSION_URL!);
  const sourceSessionId = sourceParsed.sessionId;
  const sourcePath = `${PROJECT_DIR}/${sourceSessionId}.jsonl`;

  // Capture the entryId of the first accepted_input to compare against later.
  const sourceLines = readFileSync(sourcePath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
  const firstAccepted = sourceLines.find((l) => l.type === 'accepted_input');
  expect(firstAccepted, 'source has a first accepted_input').toBeTruthy();
  const rootEntryId = firstAccepted.entryId as string;
  expect(rootEntryId.includes('__fork_'), 'source is not itself a fork').toBe(false);

  // ── Step 2: navigate, fork the source from row 0 → first fork. ────────
  await page.goto(SESSION_URL!);
  await waitForSessionReady(page);

  const firstForkBtn = page.locator('button[aria-label="Fork this conversation"]').first();
  await firstForkBtn.waitFor({ state: 'visible', timeout: 5_000 });
  await firstForkBtn.click();

  const beforeUrl = page.url();
  await page.waitForFunction(
    (src: string) => window.location.href !== src,
    beforeUrl,
    { timeout: 5_000 },
  );
  const firstForkUrl = page.url();
  const firstForkSessionId = assertIsSessionUrl(firstForkUrl).sessionId;
  const firstForkPath = `${PROJECT_DIR}/${firstForkSessionId}.jsonl`;
  await page.waitForTimeout(500);

  const firstShort = shortTag(firstForkSessionId);
  const firstLines = readFileSync(firstForkPath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
  expect(firstLines, 'first fork has the first turn triple').toHaveLength(3);
  // First fork's entryIds end with `__fork_<firstShort>`.
  expect(firstLines[0].entryId as string).toBe(`${rootEntryId}__fork_${firstShort}`);

  // ── Step 3: chain-fork the first fork from its row 0 → second fork. ──
  // (We must click the fork button on the first user row of the *first*
  // fork's UI, not the original source's. Navigating to firstForkUrl
  // already shows the first fork, so the first fork button on the page
  // belongs to it.)
  const beforeSecondUrl = page.url();
  // The previous click may have left us on firstForkUrl; ensure.
  if (!page.url().endsWith(firstForkSessionId)) {
    await page.goto(firstForkUrl);
    await waitForSessionReady(page);
  }

  const secondForkBtn = page.locator('button[aria-label="Fork this conversation"]').first();
  await secondForkBtn.waitFor({ state: 'visible', timeout: 5_000 });
  await secondForkBtn.click();

  await page.waitForFunction(
    (src: string) => window.location.href !== src,
    beforeSecondUrl,
    { timeout: 5_000 },
  );
  const secondForkUrl = page.url();
  const secondForkSessionId = assertIsSessionUrl(secondForkUrl).sessionId;
  const secondForkPath = `${PROJECT_DIR}/${secondForkSessionId}.jsonl`;
  await page.waitForTimeout(500);

  const secondShort = shortTag(secondForkSessionId);
  expect(secondShort, 'second short tag differs from first').not.toBe(firstShort);

  // ── Step 4: assert the chain-fork is correctly remapped. ─────────────
  const secondLines = readFileSync(secondForkPath, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
  expect(secondLines, 'chain-fork has the first turn triple').toHaveLength(3);

  // Each chain-fork entryId must be `<root>__fork_<secondShort>` — never
  // stack with firstShort.
  for (const l of secondLines) {
    const eid = l.entryId as string;
    expect(
      eid.endsWith(`__fork_${secondShort}`),
      `entryId ${eid} ends with new fork suffix __fork_${secondShort}`,
    ).toBe(true);
    expect(
      eid.includes(`__fork_${firstShort}`),
      `entryId ${eid} must NOT carry the first fork's suffix`,
    ).toBe(false);
  }

  // parentEntryId in the chain-fork uses secondShort too — never firstShort.
  for (const l of secondLines) {
    const pid = l.parentEntryId as string | null;
    if (typeof pid === 'string') {
      expect(pid.includes(`__fork_${firstShort}`), `parentEntryId ${pid} not firstShort`).toBe(false);
    }
  }

  // ── Step 5: source and first-fork JSONL are byte-identical. ──────────
  expect(sha256(sourcePath), 'source JSONL unchanged').toBe(sha256(sourcePath));
  expect(sha256(firstForkPath), 'first-fork JSONL unchanged after chain-fork').toBe(sha256(firstForkPath));

  // ── Step 6: sidecar meta.json on the chain-fork points at the first fork. ─
  const secondMetaPath = resolve(PROJECT_DIR, `${secondForkSessionId}.meta.json`);
  const meta = JSON.parse(readFileSync(secondMetaPath, 'utf-8'));
  expect(meta.forkedFrom.sessionId).toBe(firstForkSessionId);
  expect(typeof meta.forkedFrom.entryId).toBe('string');
  expect((meta.forkedFrom.entryId as string).endsWith(`__fork_${firstShort}`)).toBe(true);
});