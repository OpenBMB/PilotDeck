# Matrix pending evidence handoff v1 QA

Date: 2026-07-26 (Asia/Shanghai)
Branch: `codex/matrix-pending-evidence-handoff-v1`
Base: `006d5e68a18cc6f22a1d253bdbb27739c69a1a52`
Triggering run: v22 candidate Case 09 `20260726_022237_edaa9e40`

## What Was Tested

- Replaced the unbounded initial `matrix_pending` instruction with a finite
  fact-index selection -> selected-fact rehydration -> one-matrix proposal ->
  SHA-bound apply protocol.
- Kept selection and legal classification owned by the main Agent while the
  Legal Plugin supplies only canonical evidence and transaction enforcement.
- Tested single-page and multi-page selection, exact envelope validation,
  stable invalid-revision convergence, selected-fact and byte limits, stale
  state, changed proposal bytes, exhaustive `not-applicable`, and preservation
  of every non-target matrix.
- Tested oversized index records and oversized selected evidence fail closed
  before an immutable selection receipt can advance the workflow.
- Replayed the settled v22 Case 09 workspace from an isolated `/private/tmp`
  copy through the changed real Legal Plugin hook and CLI.
- Replayed the earlier v19 relation-closure snapshot to confirm the existing
  post-construction path remains unchanged.
- Ran Node syntax checks, the focused Legal Plugin suite, the complete
  PilotDeck build/test suite, and `git diff --check`.

Commands:

```text
node --check products/legal/plugins/legal-coverage/hook.mjs
node --check products/legal/plugins/legal-coverage/scripts/legal-coverage.mjs
node --check products/legal/plugins/legal-coverage/scripts/lib/legal-coverage.mjs
npm run build
node --test --test-force-exit --test-timeout 60000 dist/tests/products/legal-coverage.spec.js
npm test
git diff --check
```

## What Was Observed

- Focused Legal Plugin suite: 38/38 passed.
- Complete `npm test`: 251/251 passed, with no failures, skips,
  cancellations, or TODO tests.
- The v22 snapshot entered `matrix-pending-selection` for
  `equity-capital-timeline` instead of instructing a full `facts.json` read.
- Initial dynamic context was 17,602 bytes. The first deterministic page
  contained 28 of 107 fact-index records and measured 7,961 bytes.
- After the Agent-owned selection file was validated, the apply context was
  6,864 bytes and no longer contained the full evidence page.
- Proposal context was 7,745 bytes. It rehydrated exactly one selected
  canonical fact in a 539-byte prepared slice. Apply context was 7,579 bytes.
- The apply replaced only matrix index 0. Validator errors decreased from 246
  to 244; the other six matrices remained pending and byte-preserved.
- Canonical source and fact ledgers were unchanged through the replay:
  - `sources.json`: `3900977f30860f1d2332463b40d9f32af7e4905383b769829a08739ee99137c7`
  - `facts.json`: `518f001525d2eae9c97ec3cb2450dd5eacdb5fa6131c49f83aa8245a5fcf4fa5`
- The v19 replay still entered `material-fact-matrix-closure` with 12 facts in
  6,501 bytes and no instruction to reread the complete fact ledger.

Final isolated replay copy:
`/private/tmp/pd-v23-final-matrix-replay.in7wFI`

## Why It Is Enough

The focused tests cover every state transition and the main fail-closed paths;
the complete suite covers the shared runtime and pre-existing Legal Plugin
behavior. The settled real-workspace replay proves the exact v22 blocker now
receives bounded evidence, reaches a validated proposal, and changes exactly
one canonical matrix without touching sources or facts. The v19 replay proves
the new initial-construction protocol does not replace or regress later
relation closure.

This evidence is sufficient to freeze a candidate and run one fresh,
non-retried Case 09 experiment. It is not evidence that the model will make
correct legal selections or finish all later issue, authority, coverage, and
deliverable stages.

## Boundary Audit

Unchanged:

- Core AgentLoop, compaction, and cold/steady progress lease `8/2`
- Legal validator semantics, required matrix IDs, and materiality rules
- Source workers, source proposal/apply, canonical facts, and reciprocal links
- Existing material-fact relation closure after pending matrices are resolved
- Issue, authority, coverage, and deliverable schemas and validation
- Legal Plugin activation scope and inactive legal-question behavior
- Runner, model, corpus, Router, Memory, and campaign controls
- Case-specific facts, expected answers, and benchmark identifiers

The plugin does not select facts automatically, assign a legal matrix, write
legal prose, change materiality, or mutate more than the one pending target
matrix accepted by the Agent-owned proposal.

## What Was Omitted

- No real provider call was made during product QA.
- The v22 and v19 workspaces were replayed from isolated copies; neither live
  run was resumed or retried.
- The offline replay entry proves transaction mechanics only and is not a
  semantic legal-quality claim.
- The fresh v23 campaign, dual authenticated smoke, inactive Case 05 control,
  and one candidate Case 09 remain the next experimental gate.
- No API key, token, authorization header, environment dump, private source
  text, or secret-bearing model log is stored here.
