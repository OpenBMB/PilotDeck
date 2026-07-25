# Legal pending-source worker plan QA

Date: 2026-07-25 (Asia/Shanghai)

Result: PASS

## What changed

The Legal Plugin now turns a large pending source ledger into a deterministic,
action-ready worker plan. Each batch has disjoint stable source IDs, a unique
fragment path, and an `agentInput` object that the main Agent can pass to the
generic `agent` tool verbatim. The same plan is returned by manifest bootstrap
and injected by the PreModelRequest milestone.

This change does not modify Core progress lease or compaction, editor safety,
validator meaning, activation, legal evidence review, or canonical writer
ownership. The plan groups records and assigns output paths; it does not create
facts, materiality decisions, issues, authorities, or legal conclusions.

## What was tested

1. Static checks

   - `node --check` on the Legal Plugin hook, CLI, and validator library.
   - `git diff --check`.

2. Focused product suite

   - Build: `npm run build`.
   - Test: `node --test --test-force-exit --test-timeout 60000 dist/tests/products/legal-coverage.spec.js`.
   - Result: 33 passed, 0 failed.

3. Full repository suite

   - Test: `npm test`.
   - Result: 246 passed, 0 failed.
   - This includes real Gateway lifecycle tests, subagent identity propagation,
     progress lease behavior, compaction, editor freshness, artifact
     preservation, and all Legal Plugin tests.

4. Preserved Case 09 workspace probe

   - Copied the v11 failed run's `.pilotdeck` workspace and root deliverable to
     `/tmp/pilotdeck-worker-plan-probe-20260725-v12/`.
   - Ran the new `bootstrap-sources --from-manifest` against that copy.
   - Invoked the new PreModelRequest hook against the same copied state.
   - Compared `sources.json` SHA-256 before and after.

## What was observed

- The new 24-source test creates two batches of 12 source IDs.
- Source IDs are disjoint across batches and fragment paths are unique.
- Repeating bootstrap returns the byte-equivalent source review plan.
- Each batch contains exactly the supported `agent` input fields:
  `description`, `prompt`, and `subagent_type`.
- Worker prompts restrict each worker to assigned source IDs and one fragment,
  and forbid canonical ledgers, completion proof, and final deliverables.
- Dynamic context contains `pending-source-review`,
  `parallel-same-response`, the same batch data, and an immediate next action
  that forbids re-listing before dispatch.
- On the copied v11 workspace, bootstrap reported `bootstrapped=0`,
  `preserved=24`, mode `delegated`, and batch sizes `[12, 12]`.
- The copied `sources.json` hash was unchanged by the idempotent probe.

## Why it is enough

The focused tests prove plan determinism, idempotence, non-overlap, prompt
injection, and ownership constraints. The full suite covers shared runtime
regression risk. The copied-workspace probe proves the new code handles the
exact 24-row state that failed in v11 without changing canonical source data.
The remaining uncertainty is model compliance with the injected `agentInput`;
that requires a fresh isolated campaign and cannot be proven by unit tests.

## What was omitted

- No API key, server token, auth header, or secret-bearing environment was used
  or captured in these local checks.
- No real model call was made during this pre-commit QA.
- v11 was not retried and its preserved artifacts were not modified; all
  workspace probing used the `/tmp` copy.
