import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { LRUMap } from "./LRUMap.js";

const cache = new LRUMap<string, string>(50);

/**
 * Resolve a git root directory (containing `.git` file or dir) to the
 * canonical main-repository working directory.
 *
 * For a regular repo (`.git` is a directory) → returns `gitRoot` as-is.
 * For a git worktree (`.git` is a file containing `gitdir: <path>`) →
 * follows the chain to the main repo:
 *   `.git` file → gitdir → commondir → realpath validation → main repo root
 *
 * Behaviour mirrors the legacy upstream git worktree resolver,
 * including the SECURITY validations:
 *   1. layout check: `dirname(worktreeGitDir)` must equal
 *      `<commonDir>/worktrees`. Without this, a malicious repo could write a
 *      `.git` file pointing commondir at the victim's trusted dir.
 *   2. back-link: `realpath(<worktreeGitDir>/gitdir)` must equal
 *      `realpath(gitRoot)/.git`. Prevents an attacker from borrowing a
 *      victim's existing worktree entry by guessing its path.
 *
 * Bare-repo worktree (commondir does not end in `.git`) → returns commondir
 * itself as identity (legacy line 173-176).
 *
 * Submodules have no `commondir` file → readFile throws ENOENT and we
 * gracefully fall through to returning `gitRoot` (legacy line 137-138).
 *
 * Failures (any thrown error) → return `gitRoot` (graceful fallback). PilotDeck
 * never throws from this function: callers always have *some* canonical root.
 */
export async function resolveCanonicalRoot(gitRoot: string): Promise<string> {
  const cached = cache.get(gitRoot);
  if (cached !== undefined) {
    return cached;
  }

  const result = await resolveImpl(gitRoot);
  cache.set(gitRoot, result);
  return result;
}

async function resolveImpl(gitRoot: string): Promise<string> {
  let gitContent: string;
  try {
    // In a worktree, `.git` is a file containing `gitdir: <path>`.
    // In a regular repo, `.git` is a directory: readFile throws EISDIR.
    gitContent = (await readFile(join(gitRoot, ".git"), "utf-8")).trim();
  } catch {
    // Regular repo: realpath the answer so worktree and main both produce
    // the same canonical form on hosts where /tmp -> /private/tmp.
    return canonicalize(gitRoot);
  }
  if (!gitContent.startsWith("gitdir:")) {
    return canonicalize(gitRoot);
  }
  const worktreeGitDir = resolve(gitRoot, gitContent.slice("gitdir:".length).trim());

  let commonDirRaw: string;
  try {
    commonDirRaw = (await readFile(join(worktreeGitDir, "commondir"), "utf-8")).trim();
  } catch {
    // Submodules: `.git` file but no commondir → not a worktree.
    return canonicalize(gitRoot);
  }
  const commonDir = resolve(worktreeGitDir, commonDirRaw);

  // SECURITY validation #1: layout match.
  // worktreeGitDir must be a direct child of `<commonDir>/worktrees`. This
  // ensures the commondir we read lives inside the resolved common dir,
  // not somewhere the attacker controls.
  if (resolve(dirname(worktreeGitDir)) !== join(commonDir, "worktrees")) {
    return canonicalize(gitRoot);
  }

  // SECURITY validation #2: back-link match.
  // `<worktreeGitDir>/gitdir` records the worktree's filesystem path. We
  // realpath both sides because git writes this with realpath, but
  // `gitRoot` from findGitRoot is only lexically resolved. realpath the
  // *directory* (not `.git` itself) to avoid following a symlinked .git.
  let backlinkRaw: string;
  try {
    backlinkRaw = (await readFile(join(worktreeGitDir, "gitdir"), "utf-8")).trim();
  } catch {
    return canonicalize(gitRoot);
  }
  let backlinkResolved: string;
  let gitRootResolved: string;
  try {
    backlinkResolved = await realpath(backlinkRaw);
    gitRootResolved = await realpath(gitRoot);
  } catch {
    return canonicalize(gitRoot);
  }
  if (backlinkResolved !== join(gitRootResolved, ".git")) {
    return canonicalize(gitRoot);
  }

  // Bare-repo worktree: the common dir is not inside a working directory.
  // Use the common dir itself as the stable identity.
  // Bare-repo worktree identity: use the common dir when it is not a `.git` directory.
  if (basename(commonDir) !== ".git") {
    return canonicalize(commonDir);
  }
  return canonicalize(dirname(commonDir));
}

/**
 * Canonicalize a directory path: realpath (resolves symlinks like
 * `/tmp -> /private/tmp` on macOS) + NFC unicode normalization.
 *
 * Why both sides realpath: regular repos return `gitRoot` (lexical), but
 * worktrees return paths derived from git's own `gitdir:` content (which git
 * writes with `strbuf_realpath()`). Without normalizing both, two worktrees
 * of the same repo on macOS would yield different project IDs.
 *
 * Falls back to the lexical NFC-normalized path on realpath failure (e.g.
 * dangling symlink or permission error).
 */
async function canonicalize(p: string): Promise<string> {
  try {
    const real = await realpath(p);
    return real.normalize("NFC");
  } catch {
    return p.normalize("NFC");
  }
}

/** Test-only: clear LRU. Match the helper in findGitRoot.ts so test fixtures
 * can reset both caches between cases. */
export function __clearResolveCanonicalRootCacheForTesting(): void {
  cache.clear();
}
