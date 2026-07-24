# Clean stacked legal coverage QA

## What was tested

- Started from the updated `codex/legal-runtime-e2e` head after it merged
  `origin/main`.
- Cherry-picked only the legal coverage commits from
  `ca960406` through `8c8c506f`; the old `Merge origin/main` commit was not
  copied into this branch.
- Installed dependencies with `pnpm install --frozen-lockfile` in the fresh
  worktree.
- Ran `npm test`, which rebuilt the project and exercised the complete compiled
  test suite.
- Ran `git diff --check` and verified the worktree is clean.

## What was observed

- Clean stacked branch: `codex/legal-coverage-v1-clean`.
- Base: updated `codex/legal-runtime-e2e` at `54b110b2`.
- Head after QA: `f9c8812ab1bcfea4685fe76dc3e4b75667dc3ebf`.
- Full compiled test suite: 191 passed, 0 failed.
- Build: passed.
- Whitespace check: passed.
- No untracked or modified files remain in the clean worktree.

## Why it is enough

The branch is directly descended from the updated stacked base, so GitHub can
compute the PR diff from a single base ancestor. The legal implementation and
its tests are identical in behavior to the previously verified candidate, but
the duplicated mainline merge is removed from the PR topology.

This proves the replacement PR is locally ready. GitHub CodeQL and required
review gates remain separate remote checks after the branch is pushed.

## What was omitted

No credentials, API keys, legal source content, Judge payloads, raw model
traffic, or private configuration were captured.
