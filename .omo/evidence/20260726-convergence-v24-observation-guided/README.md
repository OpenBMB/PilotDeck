# V24 Observation-Guided Convergence Evidence

## What Was Tested

- `pnpm build`: TypeScript build, generated memory package, and bundled plugin
  copy.
- Focused Node test gate covering Progress Lease, real CompactionEngine
  planning, DefaultContextRuntime propagation, AgentLoop fail-closed control,
  and the Legal Plugin hook process.
- Full repository Node test gate over every compiled `*.test.js` and
  `*.spec.js` file.
- `git diff --check` and a scan of this evidence directory for credential and
  authorization markers.

## What Was Observed

- Build completed with exit code 0.
- Focused gate: 60 tests passed, 0 failed.
- Full gate: 269 tests passed, 0 failed.
- `no_summarizable_messages` produced zero summary model calls and propagated
  without claiming summary success.
- Old protected `agent` turns became summarizable after the bounded retention
  window; summarized and retained sides both preserved exact tool pairs.
- Opaque hash churn, equal ordinals, stale ordinals, and ordinal rollback did
  not renew the lease.
- Legal invalid-revision churn kept one ordinal; genuine bounded workflow
  progress increased it; a later user prompt preserved it.
- A simulated legal observation with increased remaining work and a new digest
  kept the prior ordinal, covering the `36 -> 57 -> 76 -> 121` failure class.
- The evidence credential scan matched only test names containing the literal
  configuration field `apiKey`; it found no credential values, authorization
  headers, bearer values, refresh tokens, access tokens, or private keys.
- The first focused run caught a top-level hook constant initialization bug.
  The constant was moved before hook execution and the complete focused gate
  then passed.

Exact test output:

- `focused-tests.tap`
- `full-tests.tap`

## Why It Is Enough For Commit

The tests cover both contract-level counterexamples and the real integration
surfaces changed by V24. The full gate includes the local Gateway, lifecycle
hooks, O1 recorder/verifier, legal validator, and unrelated product surfaces.
This supports committing a V24 candidate for live evaluation.

It does not prove Case 09 is solved. That requires a new isolated campaign with
O1 Bundle verification and live Case 05/09 runs.

## What Was Omitted

- No real model prompts, tool-result bodies, legal source material, Judge
  material, expected answers, credentials, environment dumps, or private
  chain-of-thought were captured.
- The initial dependency installation failure was environment-only: the new
  worktree had no dependencies, and the local `file:` memory package needed a
  frozen reinstall after its generated `lib` was built. No lockfile or product
  dependency change resulted.
