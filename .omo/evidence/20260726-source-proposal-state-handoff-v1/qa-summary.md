# Source proposal state handoff v1 QA

Date: 2026-07-26 (Asia/Shanghai)
Branch: `codex/source-proposal-state-handoff-v1`
Base: `bd52b144711639f7c7f1da8be957468ddf454f33`
Triggering run: v20 candidate Case 09 `20260726_010230_22b2120c`

## What was tested

- Carried the exact readiness-validated bounded source slice into
  `source-fragment-propose` as `workItems.preparedSlice`.
- Kept proposal writing, fact normalization, materiality, conflicts, and legal
  judgment owned by the Agent.
- Removed the prepared slice when the workflow advances to apply.
- Proved a tampered checkpoint does not expose a prepared slice and falls back
  to preparation.
- Proved invalid-proposal repair retains the same verified slice.
- Replayed the preserved v20 failed Case 09 workspace from an isolated `/tmp`
  copy through the real changed Legal Plugin hook.
- Ran Node syntax checks, a clean TypeScript build, the focused Legal Plugin
  suite, the complete PilotDeck suite, and `git diff --check`.

## What was observed

- Offline install reused 1,125 cached packages with zero downloads.
- Node syntax check and TypeScript build passed.
- The first focused run was 33/34 because one pre-existing assertion still
  expected the old prompt wording. The emitted state already contained the new
  prepared slice. After updating that stale assertion and adding repair-path
  coverage, the focused suite passed 34/34.
- Complete `pnpm test`: 247/247 passed, with no failures or skipped tests.
- In the v20 failed-snapshot replay, the hook entered
  `source-fragment-propose` / `main-agent-propose`.
- `preparedSlice` contained exactly the four proposal source IDs and measured
  7,906 serialized bytes. Complete dynamic context measured 15,738 bytes.
- The injected slice SHA-256 exactly matched the readiness checkpoint:
  `dd8f946620fcba545b1fae36cbee6009dc5451f221432d0c9c0bbb5dad40e608`.
- The next action treated `workItems.preparedSlice` as the complete current
  evidence interface and prohibited rereading checkpoint, fragment, canonical
  ledgers, or raw sources.
- Canonical ledgers were byte-identical before and after replay:
  - `sources.json`: `ed148d4d610a306d8dc28f9acece1fa9af24ec556d8ddd6c7267065b4cc89a68`
  - `facts.json`: `30e36876249653732d4e593273c79142db18606cb674b260ab6826e05bf604bc`

Replay copy:
`/tmp/pilotdeck-v20-case09-source-replay.th7ZUP`

## Why it is enough

The source receipt and readiness checkpoint already require the plugin to
reconstruct the bounded slice and verify its SHA. Reusing that in-memory object
does not create a new source of truth or weaken validation. Tests cover valid,
tampered, repair, and apply transitions, while the failed real snapshot proves
the exact evidence the model previously reopened is now present in the current
dynamic state envelope.

This is state assembly, not automatic legal analysis. A fresh live campaign is
still required to determine whether the model writes a valid proposal and
eventually reaches the matrix relation-closure stage.

## Boundary audit

Unchanged:

- Core AgentLoop and progress lease thresholds (cold 8, steady 2)
- Legal validator and canonical source/fact schemas
- Worker ownership and disjoint fragments
- Readiness checkpoint shape, 4 KiB cap, and SHA binding
- Proposal validation and SHA-bound atomic apply
- Proposal write budget (four sources / 24 KiB)
- Matrix relation-closure, issue, authority, coverage, and deliverable rules
- Model, corpus, Skills, runner, router/memory settings, and evaluation controls
- Case-specific legal facts, expected answers, and benchmark IDs

## What was omitted

- No real provider call was made during product QA.
- The preserved v20 run was replayed read-only; it was not resumed or retried.
- No assertion is made that dynamic state alone guarantees model compliance.
- Live behavior must be measured in one fresh immutable campaign, with later
  blockers attributed separately.
- No token, API key, auth header, environment dump, raw private corpus content,
  or secret-bearing model log is stored here.
