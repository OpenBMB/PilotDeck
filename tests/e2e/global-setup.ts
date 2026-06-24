/**
 * Playwright global-setup: keeps the canonical fork test session fresh.
 *
 * The PilotDeck projects API returns the first 5 sessions sorted by mtime desc.
 * After each test creates a new fork, the source session's mtime is no longer
 * in the top 5, so subsequent tests can't deep-link to it.
 *
 * We touch the source JSONL before every spec run so it always wins the
 * "top 5" sort, plus we expose a helper for spec files to re-touch in
 * beforeAll() if they're going to create forks.
 */
import { utimesSync } from 'node:fs';
import { execSync } from 'node:child_process';

const TARGET_SESSION = process.env.PILOT_E2E_REFRESH_SESSION_ID;
const PILOT_HOME = process.env.PILOT_HOME ?? '/Users/macmini-01/.pilotdeck';
const PROJECT_DIR = `${PILOT_HOME}/projects/Users-macmini-01-.pilotdeck/chats`;

function touchSession(sessionId: string): void {
  // `touch -t` lets us set an explicit mtime; the API sorts by mtime desc.
  // We pick a future-ish timestamp so the session stays in the top 5.
  const future = new Date(Date.now() + 60_000).toISOString().replace(/[-:T.Z]/g, '').slice(0, 12);
  const yyyy = future.slice(0, 4);
  const mm = future.slice(4, 6);
  const dd = future.slice(6, 8);
  const hh = future.slice(8, 10);
  const mi = future.slice(10, 12);
  const file = `${PROJECT_DIR}/${sessionId}.jsonl`;
  try {
    execSync(`touch -t ${yyyy}${mm}${dd}${hh}${mi} "${file}"`, { stdio: 'pipe' });
  } catch {
    // File may not exist; not fatal here. The beforeEach hook in spec
    // files handles the more reliable case.
    try { utimesSync(file, new Date(), new Date(Date.now() + 60_000)); } catch { /* ignore */ }
  }
}

export default async function globalSetup(): Promise<void> {
  if (!TARGET_SESSION) {
    console.log('[globalSetup] PILOT_E2E_REFRESH_SESSION_ID not set — skipping refresh');
    return;
  }
  touchSession(TARGET_SESSION);
  console.log(`[globalSetup] touched ${TARGET_SESSION}`);
}