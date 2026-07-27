# V24R10 Validated Repair Contract QA

## Scope and boundary

V24R10 changes only Legal Coverage source-repair guidance and preparation
accounting. It exposes validated fragment `evidenceClass` metadata, derives a
template correction only when the referenced sources permit exactly one value,
and requires a fully validated repair/apply work item before advancing
`repairPreparationOrdinal`.

It does not change Agent Core, O1, validator acceptance, Progress Lease `8/2`,
Router, Memory, model configuration, corpus, ordinary source apply receipts,
matrix selection, authority closure, or completion authority.

## Static and patch verification

Commands:

```sh
node --check products/legal/plugins/legal-coverage/hook.mjs
node --check products/legal/plugins/legal-coverage/scripts/legal-coverage.mjs
node --check products/legal/plugins/legal-coverage/scripts/lib/legal-coverage.mjs
node --check .omo/evidence/20260727-v24r10-validated-repair-contract/replay-preserved-case09.mjs
git diff --check
```

Observed: every command exited `0`; `git diff --check` emitted no diagnostics.

Why enough: these checks cover parse validity and patch hygiene, but do not
substitute for behavioral tests.

## Focused Legal Coverage and real Gateway suite

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

Observed: `84/84` passed with no failures, cancellations, skips, or todos.
Artifact: `focused-legal-gateway.log`, SHA-256
`4841ba259bf33fb21261eda4a598207d18c0d5496fda3da919d4756af83756e1`.

The Legal Coverage regression proves that a unique validated fragment class is
projected into the repair template, every tested invalid repair write keeps
`repairPreparationOrdinal` at zero, and a valid repair advances preparation
once. Existing counterexamples continue to cover missing/duplicate/unknown
operations, extra valid-fact changes, unsupported actions, placeholders,
missing removal reasons, changed diagnostic identity, invalid locators,
overflow, stale state, changed proposals, traversal, symlink ancestors, and
replay.

The four real local Gateway cases cover actual hook subscription and tool
execution, immutable source repair through verified progress, authority
closure, Stop failure, Router/Memory-disabled isolation, and complete O1
pairing with zero drops in the source-repair fixture.

## Complete repository suite

Command:

```sh
npm test
```

Observed: build plus `308/308` tests passed with no failures, cancellations,
skips, or todos. Artifact: `full-suite.log`, SHA-256
`6a66ff058ef158a5fc47ac66e5b42ae7b3a5db814529586f7c47e0f0fb37f613`.

Why enough: the complete clean run covers every repository component against
the candidate, including Core Lease and compaction, Gateway, O1, ordinary
source receipts, Legal Coverage, matrices, authorities, and unrelated product
behavior. No non-Legal implementation file changed.

## Preserved Case 09 failure replay

The reviewer-readable driver `replay-preserved-case09.mjs` copies the exact
V24R9 failed execution workspace to a disposable directory and installs the
V24R10 Legal Coverage plugin. It never mutates the original campaign or
preserved workspace.

It first replays PostToolUse against the original invalid immutable repair and
proves preparation remains zero. It then removes only that disposable copy,
derives the new state-bound repair template, preserves its mechanically
corrected exact fragment classifications, selects an exact locator from the
bounded repair context, writes the transaction, and drives the real hook and
CLI through apply and replay.

Observed:

```text
rejected repair:            source-repair-43668ad6d287.json
applied receipt:            source-repair-applied-43668ad6d287.json
invalid preparation:        0
valid preparation:          1
progressOrdinal:            0 -> 1 -> 1
canonical mutation:         4 sources, 16 facts
post-apply source state:    4 reviewed, 20 pending
next work group:            source-fragment-merge
```

Artifact: `case09-replay-result.json`, SHA-256
`1f211ea08ae4cf2cdae7436778e407d020a1eb93f61a33df5cfbb106f76b499c`.

Why enough: this is the exact proposal, repair identity, fragment metadata, and
canonical state from the failed product run. It proves the bug was corrected at
the real dynamic prompt/hook/CLI boundary: invalid bytes do not earn grace;
valid receipt-bound bytes expose the exact apply command; apply writes the
verified receipt and renews progress once; replay renews zero.

## Omitted and residual risk

No API key, provider URL, authorization header, environment dump, private
source content, report text, prompt text, raw repair content, or model reasoning
is included in this evidence directory. Logs contain only local deterministic
test output.

The production-model Case 09 has not yet run on V24R10. Therefore this change
is code-, contract-, real-Gateway-, O1-, full-suite-, and exact-failure-replay
verified, but it is not yet a product Gate pass. V25 and the 85-case campaign
remain blocked until a fresh immutable campaign passes Gate 0, paired smoke,
Case 05, and the complete Case 09 gate with validator success, a current
completion proof, and a non-skeleton report.
