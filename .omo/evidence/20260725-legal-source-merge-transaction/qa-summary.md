# Legal source merge transaction QA

Date: 2026-07-25 (Asia/Shanghai)

## What was tested

- Ran the legal-coverage product suite directly with
  `node --test --import tsx tests/products/legal-coverage.spec.ts`.
- Ran the repository build and complete test suite with `npm test`.
- Replayed the two preserved v13 Case 09 worker fragments in an isolated `/tmp`
  workspace. Reset only the copied canonical source/fact ledgers to their
  pending state, drove the real Legal Plugin hook through proposal and apply
  work groups, and executed the exact injected `sourceMergeApplyCommand`.
- Exercised invalid locator, unexpanded template placeholder, changed proposal
  bytes, and stale proposal replay paths before checking canonical ledgers.

## What was observed

- Legal product tests: 33/33 passed.
- Full repository tests: 246/246 passed after a clean TypeScript build.
- Invalid proposal files exposed no apply command. Their diagnostics were
  injected for bounded correction while the opaque convergence hash remained
  unchanged, so invalid work did not renew the Core lease.
- A valid proposal changed the dynamic work group from
  `source-fragment-merge` to `source-fragment-apply` and exposed one exact,
  receipt-hash-bound apply command.
- Proposal mutation after hook validation failed with
  `source_merge_proposal_changed`; replay after canonical progress failed with
  `stale_state_hash`. Neither path changed `sources.json` or `facts.json`.
- Successful apply created deterministic fact IDs, populated canonical fact
  rows, set reviewed source `extractionMethod`, preserved source lineage,
  carried conflicts into unresolved items, and generated reciprocal source/fact
  links.
- The real-fragment replay selected 4 sources and 16 facts. The proposal was
  10,429 serialized bytes; the complete projected source/fact transaction was
  14,171 bytes, below the 24,576-byte limit. All 4 sources became reviewed and
  every reciprocal link was verified.
- Replay workspace:
  `/tmp/pd-v14-source-merge-replay.u3Q6VK`.

## Why it is enough

The tests cover each state transition in the new Legal Plugin protocol, the
failure paths that must not count as progress, the two canonical ledger
projections, and replay/tamper resistance. The isolated replay uses the exact
worker artifacts that exposed the v13 defect, so it verifies that the proposed
repair handles the observed field shapes and payload sizes without changing
Core lease, validator, editor, worker ownership, or artifact behavior.

## What was omitted

- No real model or external network call is part of this QA artifact. That is
  deferred to a fresh frozen campaign after commit and deployment assembly.
- Process termination between the two filesystem renames is not injected. The
  command writes facts first and rolls them back if the source write reports an
  error; a machine crash at that exact boundary remains a small residual risk.
- No secrets, environment dumps, auth headers, or raw provider logs were
  recorded.
