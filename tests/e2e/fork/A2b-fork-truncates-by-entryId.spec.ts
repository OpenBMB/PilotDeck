/**
 * A2b — Fork from row N copies only entries up to and including row N,
 * not the entire conversation.
 *
 * Regression test for the bug where MessageRowV2 → MessagesPaneV2 →
 * useSessionStore.forkFromEntry → api.forkSession dropped the entryId,
 * so the server defaulted to copying the whole JSONL.
 *
 * Plan ref: chat-forking.md §3.2 (upToEntryId / upToSequence).
 *
 * Strategy (LLM-free):
 *   - Source session has 3 user turns + 3 assistant responses (9 JSONL lines).
 *   - Fork from the FIRST user row (entryId = row[0]'s entryId).
 *   - Read the new fork's JSONL on disk.
 *   - Assert it has exactly 3 lines (1 accepted_input) — NOT 9 lines.
 *
 * If the fork is correctly truncated to the first turn, it will have:
 *   - 1 accepted_input (the user's first turn)
 *   - 1 assistant_message (the first assistant response)
 *   - 1 turn_result
 *   = 3 lines total.
 *
 * If the bug is still present (no entryId passed), the fork will have all 9 lines.
 */

import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { waitForSessionReady, assertIsSessionUrl } from '../helpers/session.ts';
import { refreshSourceSession } from '../helpers/refresh.ts';

const SESSION_URL = process.env.PILOT_E2E_SESSION_URL;
test.skip(!SESSION_URL, 'PILOT_E2E_SESSION_URL not set — skip A2b');

const HOME = '/Users/macmini-01/.pilotdeck';
const PROJECT_DIR = `${HOME}/projects/Users-macmini-01-.pilotdeck/chats`;

test.beforeAll(() => {
  refreshSourceSession();
});

test('A2b — fork from row 0 copies only the first turn', async ({ page }) => {
  // 1. Get the source session id from the URL.
  const sourceParsed = assertIsSessionUrl(SESSION_URL!);
  const sourceSessionId = sourceParsed.sessionId;
  const sourcePath = `${PROJECT_DIR}/${sourceSessionId}.jsonl`;
  const sourceLines = readFileSync(sourcePath, 'utf-8').trim().split('\n').map(JSON.parse);

  // 2. Capture the entryId of the FIRST accepted_input (user message).
  const firstAccepted = sourceLines.find(l => l.type === 'accepted_input');
  expect(firstAccepted, 'first accepted_input exists in source').toBeTruthy();
  const firstEntryId = firstAccepted.entryId;

  // Sanity: source has at least 3 user turns (we forked a 3-turn source).
  const acceptedCount = sourceLines.filter(l => l.type === 'accepted_input').length;
  expect(acceptedCount, 'source has ≥ 3 user turns').toBeGreaterThanOrEqual(3);

  // 3. Navigate to the source, click the fork button on the first user row.
  await page.goto(SESSION_URL!);
  await waitForSessionReady(page);

  // The first fork button (in DOM order) corresponds to the first user message.
  const firstForkBtn = page.locator('button[aria-label="Fork this conversation"]').first();
  await firstForkBtn.waitFor({ state: 'visible', timeout: 5_000 });
  await firstForkBtn.click();

  // 4. Wait for navigation to the new fork URL.
  const beforeUrl = page.url();
  await page.waitForFunction(
    (src: string) => window.location.href !== src,
    beforeUrl,
    { timeout: 5_000 },
  );
  const forkUrl = page.url();
  const forkParsed = assertIsSessionUrl(forkUrl);
  const forkSessionId = forkParsed.sessionId;

  // 5. Read the fork JSONL on disk and verify truncation.
  const forkPath = `${PROJECT_DIR}/${forkSessionId}.jsonl`;
  // Give the server a beat to flush the file.
  await page.waitForTimeout(500);
  const forkRaw = readFileSync(forkPath, 'utf-8');
  const forkLines = forkRaw.trim().split('\n').filter(Boolean).map(JSON.parse);

  // Expected: 1 accepted_input + 1 assistant_message + 1 turn_result = 3 lines.
  // Buggy (full copy): 3 accepted_input + 3 assistant_message + 3 turn_result = 9 lines.
  const forkAccepted = forkLines.filter(l => l.type === 'accepted_input').length;
  const forkAssistant = forkLines.filter(l => l.type === 'assistant_message').length;
  const forkTurnResult = forkLines.filter(l => l.type === 'turn_result').length;

  console.log(
    `[A2b] source has ${acceptedCount} accepted_input, ` +
    `${sourceLines.length} total lines. ` +
    `fork has ${forkAccepted} accepted_input, ${forkAssistant} assistant_message, ` +
    `${forkTurnResult} turn_result — ${forkLines.length} lines total.`,
  );

  // The core assertion: the fork must NOT include all turns from the source.
  // If buggy, all 3 user turns would be present. With the fix, only the first.
  expect(forkAccepted, 'fork copies only 1 user turn (not all 3)').toBe(1);
  expect(forkLines.length, 'fork JSONL has exactly 3 lines (1 turn triple)').toBe(3);
  expect(forkAssistant, 'fork includes the assistant response for the first turn').toBe(1);
  expect(forkTurnResult, 'fork includes the turn_result closing the first turn').toBe(1);

  // The server remaps entryIds to `<original>__fork_<newSessionId>`,
  // so we check the prefix matches the source's first entryId.
  const forkedFirstEntryId = forkLines[0].entryId as string;
  expect(
    forkedFirstEntryId.startsWith(firstEntryId + '__fork_'),
    `fork first entryId is remapped from source: ${forkedFirstEntryId} should start with ${firstEntryId}__fork_`,
  ).toBe(true);
});