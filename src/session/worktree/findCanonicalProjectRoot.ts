import { resolve } from "node:path";
import {
  __clearFindGitRootCacheForTesting,
  findGitRoot,
} from "./findGitRoot.js";
import {
  __clearResolveCanonicalRootCacheForTesting,
  resolveCanonicalRoot,
} from "./resolveCanonicalRoot.js";

/**
 * Compose `findGitRoot` + `resolveCanonicalRoot` so two worktrees of the same
 * repository map to the same canonical project root.
 *
 * Mirrors the legacy upstream `findCanonicalGitRoot` composition.
 *
 * Behaviour difference from legacy: when the cwd has no git root at all,
 * legacy returns `null` and the caller decides what to do. PilotDeck always
 * needs *some* project identity (every session must belong to a project), so
 * we fall back to `path.resolve(cwd)`. Tagged `intentional_difference` in the
 * dual-parity table.
 */
export async function findCanonicalProjectRoot(cwd: string): Promise<string> {
  const root = await findGitRoot(cwd);
  if (!root) {
    return resolve(cwd);
  }
  return resolveCanonicalRoot(root);
}

/** Test helper: clear both caches in one call. */
export function __clearWorktreeCachesForTesting(): void {
  __clearFindGitRootCacheForTesting();
  __clearResolveCanonicalRootCacheForTesting();
}
