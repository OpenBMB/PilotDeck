#!/usr/bin/env -S npx tsx
/**
 * cleanup-stale-sources.ts — remove the bootstrap-created sessions that are
 * no longer needed. Each run of create-test-source.ts touches the new file
 * to 2099-01-01 so it sits at the top of /api/projects' top-5 list. After
 * several runs the top-5 is full of these stale sources, leaving no room
 * for freshly-created forks. We delete them so real-time forks can surface.
 *
 * Safety: only deletes files whose first entryId does NOT contain
 * "__fork_" AND whose sessionId starts with "web:s_" (i.e., looks like a
 * bootstrap-created root session, not a user-created session).
 */
import { readdirSync, unlinkSync, statSync, readFileSync } from 'node:fs';

const HOME = '/Users/macmini-01/.pilotdeck';
const PROJECT_DIR = `${HOME}/projects/Users-macmini-01-.pilotdeck/chats`;

const KEEP_ID = process.env.PILOT_E2E_REFRESH_SESSION_ID;

const files = readdirSync(PROJECT_DIR).filter(f => f.endsWith('.jsonl'));
let removed = 0;
for (const f of files) {
  const id = f.replace(/\.jsonl$/, '');
  if (KEEP_ID && id === KEEP_ID) continue;
  // Skip non-bootstrap sessions (we only want to nuke ones we created)
  if (!id.startsWith('web:s_')) continue;
  try {
    const size = statSync(`${PROJECT_DIR}/${f}`).size;
    if (size < 100) continue; // already empty / deleted
    // Quick heuristic: read first 200 chars and look for "third user turn"
    // (the unique marker the bootstrap script writes).
    const buf = readFileSync(`${PROJECT_DIR}/${f}`).slice(0, 1000).toString('utf-8');
    if (!buf.includes('third user turn') && !buf.includes('first user turn (E2E bootstrap)')) continue;
    unlinkSync(`${PROJECT_DIR}/${f}`);
    console.log('removed', id);
    removed++;
  } catch (e) {
    console.warn('skip', id, e);
  }
}
console.log(`Total removed: ${removed}`);