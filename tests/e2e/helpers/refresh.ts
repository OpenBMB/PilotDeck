/**
 * Helper: refresh source session mtime so it stays in the API's top-5 list
 * even after previous tests have created forks.
 *
 * The PilotDeck /api/projects endpoint returns only the first 5 sessions
 * sorted by mtime desc. After a test creates 1+ forks, the source's mtime
 * is no longer the freshest, and subsequent tests can't deep-link to it.
 *
 * Specs should call `refreshSourceSession()` in `test.beforeAll()`.
 */
import { execSync } from 'node:child_process';

const PILOT_HOME = process.env.PILOT_HOME ?? '/Users/macmini-01/.pilotdeck';
const PROJECT_DIR = `${PILOT_HOME}/projects/Users-macmini-01-.pilotdeck/chats`;

export function refreshSourceSession(): void {
  const id = process.env.PILOT_E2E_REFRESH_SESSION_ID;
  if (!id) return;
  // Use `touch -t` to set the mtime to a far-future date so the file wins
  // the "top 5" sort against any real-time forks created during the run.
  // Year 2099: long enough to outlast a 10-minute test suite.
  const file = `${PROJECT_DIR}/${id}.jsonl`;
  try {
    execSync(`touch -t 209901010000 "${file}"`, { stdio: 'pipe' });
  } catch (err) {
    console.warn(`[refreshSourceSession] failed to touch ${file}: ${err}`);
  }
}
