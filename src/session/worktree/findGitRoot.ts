import { stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { LRUMap } from "./LRUMap.js";

const NOT_FOUND = Symbol("findGitRoot.NOT_FOUND");

/**
 * LRU-cached filesystem walk that finds the directory containing `.git`
 * (regular repo: `.git` is a directory; worktree/submodule: `.git` is a file).
 *
 * Behaviour mirrors the legacy upstream git-root walk:
 *   - walk parent → stat `<dir>/.git`; both file and directory count as a hit
 *   - return path NFC-normalized (`.normalize('NFC')`) so macOS UTF-8 forms fold
 *   - LRU cap 50 entries (cwd → resolved root) to keep hot paths in memory
 *
 * Differences from legacy:
 *   - async (uses `node:fs/promises`); legacy is sync `statSync` for hot path
 *     speed. PilotDeck callers are already async, so async fits naturally.
 *   - logging is intentionally omitted (no diagnostics infra in PilotDeck).
 */
const cache = new LRUMap<string, string | typeof NOT_FOUND>(50);

export async function findGitRoot(startPath: string): Promise<string | null> {
  const cwd = resolve(startPath);
  const cached = cache.get(cwd);
  if (cached === NOT_FOUND) {
    return null;
  }
  if (typeof cached === "string") {
    return cached;
  }

  let current = cwd;
  // Same logic as legacy: drive root on Windows, "/" on POSIX.
  const root = current.substring(0, current.indexOf(sep) + 1) || sep;

  while (current !== root) {
    if (await hasGit(current)) {
      const resolved = current.normalize("NFC");
      cache.set(cwd, resolved);
      return resolved;
    }
    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  // Check the filesystem root itself.
  if (await hasGit(root)) {
    const resolved = root.normalize("NFC");
    cache.set(cwd, resolved);
    return resolved;
  }

  cache.set(cwd, NOT_FOUND);
  return null;
}

async function hasGit(dir: string): Promise<boolean> {
  try {
    const stats = await stat(join(dir, ".git"));
    return stats.isDirectory() || stats.isFile();
  } catch {
    return false;
  }
}

/**
 * Test-only: clears the LRU cache. Call from worktree fixtures after each test
 * so cwd reuse across tests does not leak resolved paths.
 */
export function __clearFindGitRootCacheForTesting(): void {
  cache.clear();
}
