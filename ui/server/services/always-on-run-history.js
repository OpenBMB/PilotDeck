/**
 * Thin adapter — delegates run-history append logic to
 * `src/always-on/web/AlwaysOnRunHistoryService.ts`.
 */

import { getAlwaysOnRoot } from './always-on-paths.js';
import { AlwaysOnRunHistoryService } from '../../../src/always-on/web/AlwaysOnRunHistoryService.js';

function getService() {
  return new AlwaysOnRunHistoryService({
    paths: { getAlwaysOnRoot },
  });
}

export async function appendAlwaysOnRunEvent(projectRoot, event) {
  return getService().appendRunEvent(projectRoot, event);
}
