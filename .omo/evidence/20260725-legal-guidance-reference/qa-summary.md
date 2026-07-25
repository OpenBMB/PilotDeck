# Legal guidance reference QA

Date: 2026-07-25
Branch: `codex/convergence-hardening-v1`
Base commit: `7d514f900457b7ec47972d261655d8bec5731440`

## Triggering evidence

Candidate-only Case 09 in campaign
`20260725-e2-elite-convergence-v7-root-path`, run
`20260725_180438_29a6525c`, proved the root-level deliverable fix: the legal
initializer succeeded, created non-empty `担保人主体审查报告.md`, and advanced
the opaque convergence state from `configuration/jurisdiction_missing` to
`sources/source_not_inventoried`.

The next model request interpreted the Skill's relative
`references/data-contracts.txt` as a path under
`.pilotdeck/work/legal-coverage/`. That read failed because the resource is
bundled with the installed plugin Skill. The model found the actual plugin path
on the following request, but neither path discovery step changed canonical
legal state, so the unchanged steady-state progress lease correctly failed
closed after two observations with `boundary_rejected`. The runner preserved
the skeleton and input lineage and classified the run as failed.

## Change and boundary

The legal CLI now exposes its two bundled guidance documents through a stable,
read-only named interface:

```text
legal-coverage.mjs reference --name data-contracts
legal-coverage.mjs reference --name issue-rules
```

The dynamic legal milestone selects the phase-relevant command and injects it
as `guidanceCommand` and in the single `nextAction`. The Skill now requires the
injected command and explicitly forbids guessing a workspace-relative
`references/` path. Unknown names fail closed.

This changes only the Legal Plugin/Skill. Core progress-lease thresholds,
boundary behavior, runner behavior, activation rules, validator semantics, and
corpus inputs are unchanged. No benchmark-specific path, case name, fact, or
expected answer is present in the implementation.

## Commands and observations

```text
npm run build
node --test --test-force-exit --test-timeout 60000 \
  dist/tests/products/legal-coverage.spec.js \
  dist/tests/agent/legal-coverage-plugin-runtime.spec.js
```

Result: 32 passed, 0 failed. This includes named reference success and invalid
name rejection, legal hook lifecycle behavior, initializer and path boundaries,
and assertions that the dynamic milestone carries the exact data-contract
command without workspace-relative path guessing.

```text
npm test
```

Result: 242 passed, 0 failed. The full suite includes the real local Gateway
lifecycle, legal hook and artifact contract, dynamic context injection,
progress lease and compaction boundaries, tools, server, channels, config, and
history behavior.

## Why this is enough and residual risk

The unit and local Gateway tests prove the stable reference interface and its
dynamic prompt wiring without weakening convergence enforcement. A fresh
external-model campaign is still required to prove that Case 09 consumes the
injected command and performs a canonical source write before the unchanged
steady-state lease expires. The frozen v7 deployment must not be modified in
place; the follow-up belongs in a new campaign.

No API keys, server tokens, auth headers, environment dumps, private corpus
contents, or raw model payloads are stored here.
