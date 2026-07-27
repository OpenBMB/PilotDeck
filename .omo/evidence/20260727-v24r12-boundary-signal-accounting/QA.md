# V24R12 Boundary Signal Accounting QA

## Scope and boundary

V24R12 changes only Progress Lease accounting for opaque repair signals that
are present in an applied-boundary observation. AgentLoop applies the boundary,
derives `PreModelRequest` context and convergence metadata, evaluates Lease,
and then sends that same request. A boundary request therefore delivers every
signal in that observation.

The implementation records a strictly newer `repairOrdinal` as feedback
delivered and a strictly newer `repairPreparationOrdinal` as preparation
delivered. It adds no decision, grace, request, threshold, retry, legal field,
validator rule, or prompt. Limits `8/2`, Router, Memory, model, Skills, corpus,
deadlines, receipts, and completion authority are unchanged.

## Counterexample-first verification

The Lease regression was added before the implementation. Against V24R11, 24
existing/new tests passed and the isolated Case 09 sequence failed exactly at:

```text
actual:   fail_closed
expected: repair_preparation_grace
```

Artifact: `red-counterexample.log`, SHA-256
`8ba87a0b0fb1feee4edc00e1a9f2a825fbf519427d85d74da4410fcad0cc23ac`.

After replacing only the two reset values in `boundary.applied` with the
already-computed `repairAdvanced` and `repairPreparationAdvanced` flags, the
same Lease suite passed `25/25`. Artifact: `green-counterexample.log`, SHA-256
`f815f89aabf3af32bd8be973987a6af12dc41498dd57633024210523ae5cf83a`.

The counterexamples also prove that feedback and preparation co-delivered by
one boundary cannot be replayed for another turn. Existing second-revision,
pre-boundary preparation, simultaneous handoff/repair, unavailable boundary,
rollback, and per-progress-epoch handoff-limit tests remain green.

## AgentLoop ordering

The existing prepared-target AgentLoop regression now reproduces the product
ordering: feedback first appears in the forced-boundary `PreModelRequest`,
preparation appears on the next request, and semantic progress follows.

Observed decision sequence:

```text
baseline -> stagnant -> boundary_grace -> repair_preparation_grace -> renewed
```

The separate runtime test for feedback arriving after a boundary remains
unchanged and still exercises `feedback_grace`. Combined Lease and AgentLoop
suite: `33/33` passed. Artifact: `focused-core.log`, SHA-256
`570356dcff34549794f07c9fbd4a4ec0cc7ffbdccfb7bca52f13888e4ae28192`.

## Preserved V24R11 trajectory replay

`replay-preserved-case09.mjs` verifies the frozen V24R11 `events.jsonl` hash,
extracts all 21 real `progress_lease_evaluated` observations, derives applied
boundaries from the recorded `boundary_grace` decisions, and replays them
through the candidate Lease with the frozen `8/2` limits.

Observed: the first 20 decisions are byte-for-byte equivalent as decision
names. Only observation index 20 changes:

```text
progress 5, repair 2, preparation 2, handoff 3
fail_closed -> repair_preparation_grace
```

Artifact: `case09-lease-replay-result.json`, SHA-256
`78d2b5f5e2d7d32c4261e025f29c61b295117084f3f2a761497c187568cf7177`.

Why enough: the replay includes the first repair, three ordinary source
handoffs, all prior semantic renewals, and the exact terminal failure. It proves
the behavior change is isolated to the identified accounting boundary.

## Preserved legal repair projection

`project-preserved-case09-repair.mjs` verifies the frozen run-summary hash,
copies the preserved workspace to a disposable directory, installs the
candidate Legal Coverage plugin into only that copy, derives the current work
item, executes the exact injected command, verifies the durable receipt and
input tree, and removes the temporary workspace.

Observed:

```text
work item:        source-fragment-repair-apply / validated
repair:           2 operations, 4 sources, 10 facts, 8,838 bytes
state hash:       2c78fb...a560 -> a7454c...0bc
durable receipt:  source-repair-applied-cb249643d05a.json
next group:       source-fragment-merge
input tree:       unchanged
preserved run:    unchanged
```

Artifact: `case09-repair-projection-result.json`, SHA-256
`d751d2d5c78c5350303f0e94b803a655415da0dc35f869da402404797f919b1f`.

Why enough: this holds the legal validator, transaction, command, and source
content constant and proves the blocked turn had a valid executable operation.
Together with the Lease replay, it isolates the failure from legal semantics.

## Focused Gateway, Legal Coverage, Lease, and O1 suite

Command:

```sh
node --test --test-force-exit --test-timeout 60000 \
  dist/tests/products/legal-coverage.spec.js \
  dist/tests/agent/legal-coverage-plugin-runtime.spec.js \
  dist/tests/agent/progress-lease.spec.js \
  dist/tests/agent/agent-loop-runtime-controls.spec.js \
  dist/tests/observability/recorder.spec.js \
  dist/tests/observability/local-gateway-progress-handoff.spec.js
```

Observed: `87/87` passed. The suite drives real local Gateway instances with
Router, Memory, and telemetry disabled; exercises immutable source repair,
ordinary source handoff, exact apply commands, durable receipts, compaction,
Lease and O1; and reports complete model/tool/turn pairing with zero dropped
events. Artifact: `focused-legal-gateway.log`, SHA-256
`463fac93007ad37b1d6a9d7fd3c84d5559272489003a5a9f6ca409d64301a1ea`.

## Complete repository suite and hygiene

Command: `npm test`.

Observed: build plus `311/311` tests passed with no failures, cancellations,
skips, or todos. Artifact: `full-suite.log`, SHA-256
`482b51521fae369c768a9a9c0684b2a263db2db6e6e16526a0922fd4eb9d6909`.

`git diff --check` exited `0` with no diagnostics. The runtime diff is two
assignments in Core plus focused tests; no Legal Coverage production file is
changed.

## Omitted and residual risk

No API key, provider URL, authorization header, environment dump, private
source content, report text, prompt text, or model reasoning is included. Raw
logs are local and ignored; the committed artifacts contain only hashes,
counts, ordinal decisions, stable basenames, and bounded protocol metadata.

This QA proves the Core state transition, real AgentLoop ordering, local
Gateway behavior, O1 integrity, exact frozen-session isolation, and repository
regression surface. It does not prove the production model will complete Case
09 after the newly available apply turn. A fresh immutable V24R12 campaign must
still pass Gate 0, paired smoke, Case 05, and the complete Case 09 product gate.
V25 and the 85-case campaign remain unauthorized until then.
