# Source proposal batch diagnostics v1 QA

Date: 2026-07-26 (Asia/Shanghai)
Branch: `codex/source-proposal-batch-diagnostics-v1`
Base: `dfabca1351f62da9e3ce590d07b17924bb3e6d48`
Triggering run: v21 candidate Case 09 `20260726_012705_775aa800`

## What Was Tested

- Added bounded multi-row diagnostics to invalid source-merge proposal
  receipts while retaining the original primary `validationError`.
- Kept invalid revisions on one stable convergence repair marker.
- Kept basic envelope validation and the canonical apply path fail-fast.
- Tested two simultaneous fact-row errors and the complete bounded maximum of
  36 diagnostics (32 fact rows plus four no-material rows).
- Replayed the preserved v21 failed Case 09 workspace from an isolated
  `/private/tmp` copy through the changed Legal Plugin hook.
- Ran offline install, Node syntax check, a clean TypeScript build, focused
  Legal Plugin tests, the complete PilotDeck suite, and `git diff --check`.

Commands:

```text
pnpm install --offline --frozen-lockfile
node --check products/legal/plugins/legal-coverage/scripts/lib/legal-coverage.mjs
pnpm build
node --test --test-force-exit --test-timeout 60000 dist/tests/products/legal-coverage.spec.js
pnpm test
git diff --check
```

## What Was Observed

- Offline install reused 1,125 cached packages with zero downloads.
- Node syntax check and TypeScript build passed.
- Focused Legal Plugin suite: 34/34 passed.
- Complete `pnpm test`: 247/247 passed with no failures or skipped tests.
- The v21 replay stayed in `source-fragment-propose` /
  `main-agent-propose` with the same four prepared source IDs.
- `preparedSlice` remained 7,629 serialized bytes. Complete dynamic context was
  16,828 bytes and the non-duplicating `nextAction` was 619 bytes.
- The changed receipt returned all three remaining errors from the preserved
  final proposal in one request:
  - facts 11 and 12: `source_merge_fact_evidence_mismatch`
  - fact 19: `source_merge_fact_locator_unverified`
- Diagnostics measured 486 bytes; `total=3`, `returned=3`, `hasMore=false`.
- Canonical and proposal bytes were unchanged before and after replay:
  - `sources.json`: `97a22bffb41d0486f0a4f0922ca20b6a5347a327c410349c73f691d99b9f0144`
  - `facts.json`: `7c436ea43c4aff3d0a2c76e494ccb9265d835fc019b2b605fc28472282c9606a`
  - final proposal: `d36cd8afe3155fbbe8868cff5506b4fbd2862dd431d8fabc453c7835a1eedc90`

## Why It Is Enough

The live failure demonstrated that dynamic evidence delivery now works and
that the remaining source-stage blocker is serial error disclosure. The tests
cover multi-error, the complete 36-row diagnostic bound, stable-repair,
valid-apply, and real-snapshot paths. Replay proves the changed hook exposes
information already enforced by the validator without mutating evidence or
canonical state.

This is sufficient for an immutable commit and one fresh v22 campaign. It is
not evidence that the model will fix every diagnostic, avoid redundant reads,
finish all six source cycles, or reach matrix closure.

## Boundary Audit

Unchanged:

- Core AgentLoop, progress lease, and compaction behavior
- Legal validation rules and canonical schemas
- Agent ownership of proposal content and legal judgment
- Readiness/prepared-slice transaction and SHA checks
- Four-source / 24 KiB proposal and apply limits
- Matrix, issue, authority, coverage, and deliverable behavior
- Runner, baseline, model, Skills, corpus, and evaluation controls
- Case-specific facts, expected answers, and benchmark identifiers

## What Was Omitted

- No real provider call was made during product QA.
- The v21 run was replayed from a temporary copy; it was not resumed or retried.
- Private corpus rows and secret-bearing model logs are summarized, not copied.
- No token, API key, auth header, or environment dump is stored here.
