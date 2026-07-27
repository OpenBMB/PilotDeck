# V24R9 Durable Ordinary Source Apply Receipt QA

## Scope and boundary

V24R9 changes only the Legal Coverage observation of a successful ordinary
source merge. It does not change PilotDeck Core, O1, validator acceptance,
issue taxonomy, Progress Lease thresholds `8/2`, Router, Memory, the model, the
evaluation corpus, repair acceptance, matrix handoffs, or authority closure.

The success criterion is narrow: a successful ordinary source transaction
must leave a state-bound applied receipt which advances semantic progress once,
while apply readiness, tampering, and replay do not advance it.

## Static and automated verification

### Syntax and patch hygiene

Commands:

```sh
node --check products/legal/plugins/legal-coverage/hook.mjs
node --check products/legal/plugins/legal-coverage/scripts/legal-coverage.mjs
node --check products/legal/plugins/legal-coverage/scripts/lib/legal-coverage.mjs
node --check .omo/evidence/20260727-v24r9-durable-source-apply-receipt/replay-preserved-case09.mjs
git diff --check
```

Observed: all commands exited `0`; `git diff --check` produced no diagnostics.

Why enough: these checks cover JavaScript parse validity and whitespace
errors. They do not substitute for behavior tests.

### Focused Legal Coverage and real Gateway suite

Command:

```sh
node --test --test-force-exit --test-timeout 60000 \
  dist/tests/products/legal-coverage.spec.js \
  dist/tests/agent/legal-coverage-plugin-runtime.spec.js
```

Observed: `45/45` passed. Artifact: `focused-legal-gateway.log`.

The product regression reproduces the ordinary source transaction following a
successful immutable repair. It proves that apply readiness does not increment
progress; successful CLI apply writes the deterministic receipt; a tampered
receipt is ignored; an unknown source status is rejected even when the receipt
claims that new current state hash; the restored valid receipt increments
exactly once; and its replay does not increment. The four Gateway cases
continue to pass with Router and Memory disabled and O1 enabled in the
source-repair fixture.

Why enough: this covers the changed hook, CLI, receipt writer, receipt verifier,
immutable repair compatibility, real hook subscription, Gateway tool calls,
Progress Lease projection, and O1 integrity.

### Complete repository suite

Command:

```sh
pnpm test
```

Observed: `308/308` passed, with no failures, cancellations, skips, or todos.
Artifact: `full-suite.log`.

Why enough: the clean complete run covers all repository behavior on the
candidate, including Core Progress Lease, compaction, Gateway, Legal Coverage,
and O1. No unrelated component was changed.

## Preserved Case 09 failure replay

The reviewer-readable replay driver is `replay-preserved-case09.mjs`. It copies
the preserved V24R8 Case 09 failure into a disposable directory, installs the
V24R9 Legal Coverage plugin, reconstructs the canonical state immediately
before the ordinary source apply, and verifies that its hash equals the
immutable proposal's expected state before executing anything.

It then drives the actual Legal Coverage hook and CLI. Observed:

```text
proposal:         source-merge-5dadf825216f.json
receipt:          source-merge-applied-5dadf825216f.json
state:            74abe7... -> 4d3a3c...
applied:          4 sources, 23 facts
canonical total:  24 sources, 8 reviewed, 16 pending, 45 facts
progressOrdinal:  1 -> 2 -> 2
next work group:  source-fragment-merge
```

Artifact: `case09-replay-result.json`.

Why enough: these are the exact proposal, source/fact counts, and state hashes
from the V24R8 product failure. The replay proves that the missing durable
identity, rather than error counts or opaque hash churn, now renews progress
once after the real mutation and remains deduplicated on the next hook call.

## Counterexample coverage

Automated tests cover apply-ready non-progress, deterministic receipt creation,
receipt tampering, exact source-ID binding, exact reviewed-status binding,
current state binding, immutable proposal hash binding, one-time progress, and
replay. Existing tests continue to cover stale state, changed proposals,
traversal, symlink ancestors, atomic source/fact mutation, immutable repair
receipt validation, and repair replay.

## Omitted and residual risk

No API key, provider URL, authorization header, environment dump, private
source content, report text, prompt text, or raw reasoning is included in this
evidence directory. The replay result contains only hashes, counts, stable
artifact basenames, and ordinal transitions.

The complete production-model Case 09 has not yet run on V24R9. Therefore this
change is code-, protocol-, Gateway-, and exact-failure-replay verified, but it
is not yet a product Gate pass. V25 and the 85-case campaign remain blocked
until a new immutable campaign passes Gate 0, paired smoke, Case 05, and the
complete Case 09 product Gate.
