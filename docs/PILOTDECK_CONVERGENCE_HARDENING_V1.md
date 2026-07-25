# PilotDeck Convergence Hardening V1

## 1. Purpose

This document defines the implementation and experiment contract for fixing the
bounded-convergence failure observed in E2-Elite v6 Case 09. It is deliberately
split by ownership boundary:

- PilotDeck Core owns generic context, progress, compaction, command
  classification, and stop behavior.
- The legal plugin owns legal phases, legal ledgers, source lineage, legal
  coverage batches, and legal completion proof.
- The evaluation runner owns isolation, deadlines, artifact preservation, and
  experiment metadata. It must not teach the Agent how to answer.

The design principle is:

> Dynamic prompts describe the current state. Structured contracts and state
> machines enforce how the Agent may continue.

## 2. Worktree identity and baseline

- Worktree: `/Users/da/Documents/PilotDeck-worktrees/20260725-convergence-hardening-v1`
- Branch: `codex/convergence-hardening-v1`
- Base commit: `d30b328018e539e3b60e8d6cb11fd03a2c290c6b`
- Frozen v6 Candidate: `b885cc008eea3a89641e3731dce187f641dd15ae`
- Frozen baseline: `08527a90cb49479bfdd13c0402205600791c551c`

`d30b328` and `b885cc0` have no product-code differences. Their only diff is
under `.omo/evidence/`; `d30b328` is the linear clean-stack representation.
This worktree therefore preserves the v6 Candidate behavior while giving the
new work a reviewable history.

## 3. Corrected Case 09 diagnosis

The failure is not plugin activation or Gateway routing:

- legal dynamic context activated at the start of the run;
- the Agent processed all 24 staged materials and generated the requested
  report and seven legal ledgers;
- validator errors declined from 56 to 13 and then 4;
- the completion proof appeared about 104 seconds after the declared
  35-minute cutoff.

The failure is bounded convergence:

- baseline: 14 model turns and 211.045 seconds;
- Candidate: 132 model turns and 2208.100 seconds;
- Candidate used 150 tool calls and created 14 repair scripts;
- initial context usage was already 57.1% of the effective window;
- the run entered warning at 81.6% and blocking at 95.5%;
- 107 model requests were recorded in blocking state;
- the final recorded ratio was 265.7% of the effective window.

One prior statement needs refinement. The event stream contains 107
`compact_completed` events with status `success`, but only nine
`turn_continued` events with reason `auto_compact`. In current code,
`CompactionEngine` emits `success` when summary generation succeeds, before
`DefaultContextRuntime` decides whether the post-compact message set is small
enough to apply. Therefore `compact_completed: success` does not prove that a
compaction boundary was accepted. The new observability contract must
distinguish:

1. summary generation succeeded;
2. compacted messages passed the budget check;
3. the Agent loop replaced its active messages;
4. the next request used the accepted compacted messages.

## 4. Non-goals and frozen controls

The following are not changed by convergence hardening:

- model and provider;
- 85-case corpus or Case 09 materials;
- legal validator strictness;
- legal activation predicate;
- Judge, rubric, expected answer, checkpoints, or ground truth;
- 35-minute per-turn observation cap;
- disabled router, Memory, Always-On, cron, telemetry, browser-use, and
  external channels in evaluation deployments.

No evaluator-only material may enter an Agent workspace or prompt.

## 5. Target contracts

### 5.1 Domain convergence report

A domain plugin may attach this generic shape to every `PreModelRequest`:

```json
{
  "schemaVersion": 1,
  "scope": "legal-coverage",
  "phase": "coverage",
  "stateHash": "sha256",
  "blockingCode": "coverage_quote_not_found",
  "remainingCount": 13,
  "nextBatch": {
    "group": "facts",
    "returned": 12,
    "hasMore": true
  },
  "writeBudget": {
    "maxRecords": 12,
    "maxSerializedBytes": 24576
  }
}
```

Core treats the report as opaque progress state. It compares hashes and
counts; it does not interpret legal phases or error codes.

### 5.2 Schema-native legal batch update

The legal CLI will expose four explicit operations:

```text
legal-coverage schema
legal-coverage next-batch
legal-coverage apply-batch
legal-coverage validate
```

`apply-batch` must:

- accept only the group returned by the current `next-batch`;
- reject stale `expectedStateHash` values;
- reject records outside the current batch;
- enforce at most 12 records and 24 KiB serialized input;
- update one canonical array atomically;
- preserve unrelated rows and key order deterministically;
- run validation after the write and return the new state hash and remaining
  count;
- never write `completion-proof.json` directly.

This prevents whole-file JSON rewrites without moving legal schema knowledge
into PilotDeck Core.

### 5.3 Generic progress lease

Core tracks a per-scope lease from domain convergence reports:

- a changed state hash or lower remaining count renews the lease;
- an unchanged blocking report consumes one lease unit;
- after two stagnant observations, Core requires an accepted checkpoint and
  compaction boundary;
- if compaction is rejected or the compacted state remains stagnant, evaluation
  mode fails closed;
- production mode may persist a checkpoint and start a bounded continuation,
  but it must not silently reuse the same oversized message set.

The default production behavior remains backward compatible until the new
policy is explicitly enabled. Evaluation campaigns freeze the selected mode in
deployment metadata.

The current Core implementation uses the explicit opt-in config below:

```yaml
agent:
  progressLease:
    enabled: true
    mode: evaluation
    maxStagnantObservations: 2
    maxInitialStagnantObservations: 8
```

The initial limit applies only until the first changed state hash or lower
remaining count for a scope. This gives bounded room for skill loading, source
inventory, and other cold-start work without teaching Core about tool names or
domain phases. After the first progress renewal, the stricter steady-state
limit applies. Omitting `maxInitialStagnantObservations` preserves the previous
behavior by defaulting it to `maxStagnantObservations`.

PreModelRequest milestones are model-only request context, not persisted
conversation messages. Active domain plugins must therefore reinject the same
short current milestone on every request until the state changes. Digest-based
deduplication may avoid redundant session-state writes, but it must not suppress
the request-local next action.

The report is read from the opaque `pilotdeckConvergence` model-request
metadata field. Core does not inspect `scope`, `phase`, or `blockingCode`; it
only compares `stateHash` and `remainingCount`. Once one unchanged observation
has been seen, the next request asks the context runtime for a full compaction
boundary. A rejected or unavailable boundary fails the evaluation before the
next model call. An accepted boundary gives exactly one model turn to make
progress; an unchanged report after that boundary fails closed. This ordering
matches the AgentLoop lifecycle, where compaction runs before `PreModelRequest`
and the report describes the previous tool turn.

The policy emits a `progress_lease_evaluated` event with the decision and
boundary outcome. The event contains no legal content and is safe for runner
metadata and replay fixtures.

### 5.4 Source lineage

Legal completion proof must bind this chain:

```text
original file SHA-256
  -> extraction method and version
  -> derived artifact SHA-256
  -> source/fact locator
  -> coverage row
  -> deliverable SHA-256
```

PilotDeck Core should eventually expose a stable attachment manifest. Until
that generic contract exists, the legal plugin may validate a project-local
lineage ledger, but it must not guess that Agent-created `.txt` files are the
original inputs.

## 6. Implementation sequence and atomic commits

Each behavioral commit receives its own diagnostic deployment. Telemetry-only
changes may accompany a behavioral commit only when they cannot alter model
inputs or control flow.

### Iteration A: command classification

Hypothesis: token-aware command classification will allow the existing
`legal-coverage next-batch` command without weakening detection of the Next.js
CLI or long-running server commands.

Implementation:

- replace the bare `next` matcher with command-token-aware framework matching;
- add positive cases for `next dev`, `npx next`, and package scripts;
- add negative cases for `next-batch`, filenames, and quoted text.

Gate: focused Bash tests and full build/test. No LLM run is required to prove
the classifier fix, but the event must not recur in the later Case 09 run.

### Iteration B: compaction observability

Hypothesis: distinguishing summary success from accepted compaction will make
blocking loops machine-detectable and replayable without changing semantic
behavior.

Implementation:

- emit tier, pre/post budget, acceptance, and rejection reason;
- assert that an accepted boundary is followed by a request using the accepted
  message set;
- keep existing `compact_started` and `compact_completed` compatibility.

Gate: context unit tests plus the sanitized Case 09 replay.

### Iteration C: legal schema-native batches

Hypothesis: atomic bounded updates will reduce write failures, full-ledger
rewrites, and quote/hash repair churn while preserving validator strictness.

Gate: legal plugin unit tests, hook runtime test, synthetic coverage repair
fixture, and no change to validator pass/fail outcomes for existing fixtures.

### Iteration D: source lineage

Hypothesis: binding originals and derived artifacts will close the evidence gap
without exposing source contents or moving legal logic into Core.

Gate: synthetic DOCX/XLSX byte fixtures, changed-original rejection,
changed-derived rejection, traversal/symlink rejection, and proof-manifest
assertions.

### Iteration E: generic progress lease

Hypothesis: an explicit lease will stop stagnant blocking loops before the
35-minute deadline without reducing completion on progressing tasks.

Gate: pure policy tests, historical replay, three non-activation short cases,
then one fresh Candidate-only Case 09 run.

## 7. Experiment ladder

Do not reuse v6 as a writable campaign. Every live deployment uses the pushed
commit under test and a new campaign directory.

1. Offline replay and synthetic fixtures.
2. Three short cases where the legal plugin must remain inactive.
3. One new Candidate-only Case 09 run with `workers=1`.
4. If Case 09 produces an on-time fresh proof with clean lineage, run three
   reviewed paired A/B blocks.
5. Run the frozen Judge pass only after both arms complete.
6. Enter the 85-case campaign only after critical paired results improve and
   safety, completion, cost, and latency do not materially regress.

The live Case 09 acceptance criteria are:

- hook-owned activation occurs before substantive work;
- no command-classification rejection for `next-batch`;
- every compaction attempt has a machine-readable applied/rejected outcome;
- no more than two consecutive stagnant batches before an enforced boundary;
- original and derived source hashes are both represented in lineage;
- a fresh validator-owned proof exists before 2100 seconds;
- root deliverable and proof remain at their validated paths and are also
  exported non-destructively;
- no input mutation, out-of-workspace write, secret leakage, 401, 429,
  `session_busy`, or Gateway failure.

## 8. Evidence and stop rules

Write reviewer-readable evidence under:

```text
.omo/evidence/20260725-convergence-hardening-v1/
```

Evidence contains commands, hashes, counts, state transitions, decisions, and
sanitized output summaries. It does not contain API keys, auth headers, raw
legal materials, raw model messages, final legal answers, Judge prompts,
rubrics, expected answers, ground truth, or checkpoints.

Stop before a live experiment if:

- attribution crosses the Core/legal/runner boundary;
- replay or synthetic gates fail;
- the candidate worktree is dirty at deployment time;
- the runner commit is not `e79aa3a66d549025e373a29927264fb7c3e21b55`
  or a reviewed descendant;
- deployment controls differ between baseline and Candidate;
- the corpus lock changes.
