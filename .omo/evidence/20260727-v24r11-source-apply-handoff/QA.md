# V24R11 Ordinary Source Apply Handoff QA

## Scope and boundary

V24R11 changes only the Legal Coverage projection of a newly validated ordinary
source proposal. It adds one replay-safe handoff identity so the existing Core
Progress Lease can grant one model turn in which the Agent receives the exact
`source-merge-apply` command.

It does not change Agent Core, O1, validator acceptance, Progress Lease
thresholds `8/2`, Router, Memory, model configuration, corpus, source apply
execution, durable receipts, repair behavior, matrix or authority protocols,
deadlines, or completion authority. Apply readiness remains non-semantic;
verified V24R9 receipts remain the only ordinary source progress identity.

## Counterexample-first verification

The source workflow regression was added before the implementation. Against
V24R10 it failed only at the new handoff assertion:

```text
Expected values to be strictly equal:
0 !== 1
```

Artifact: `red-counterexample.log`, SHA-256
`7705db07e30d8b2926ce1512ffb4d55307b10f9714db2a234c9df547f1e84db3`.

After the 15-line Legal Coverage checkpoint implementation, the same test
passed. Artifact: `green-counterexample.log`, SHA-256
`3dca49fa89146cdeda92dc1e550cbe9c6c61838489f71040cfbf9c7da0eb2a54`.

Why enough: the before/after holds validators, receipts, Core, Lease, test data,
and commands constant. The only changed runtime behavior is the missing
validated-proposal handoff identity.

## Static and patch verification

Commands:

```sh
node --check products/legal/plugins/legal-coverage/hook.mjs
node --check products/legal/plugins/legal-coverage/scripts/legal-coverage.mjs
node --check products/legal/plugins/legal-coverage/scripts/lib/legal-coverage.mjs
node --check .omo/evidence/20260727-v24r11-source-apply-handoff/replay-preserved-case09.mjs
git diff --check
```

Observed: every command exited `0`; `git diff --check` emitted no diagnostics.

## Focused Legal Coverage, Gateway, Lease, and O1 suite

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

Observed: `85/85` passed with no failures, cancellations, skips, or todos.
Artifact: `focused-legal-gateway.log`, SHA-256
`cfe8da9140d85ad15728caec45c110eec9a578dad1a7b4d9808af9b87c9979bc`.

The product regression proves invalid proposal state advances no handoff; valid
ordinary apply readiness advances exactly once; replay advances zero; the exact
command remains stable; successful apply advances only progress through the
durable receipt; and applied-state replay advances neither ordinal.

The real local Gateway regression drives proposal write, exact apply, receipt
observation, and completion. It observes:

```text
baseline -> handoff_grace -> renewed -> completed
progressOrdinal: 0 -> 0 -> 1 -> 2
handoffOrdinal:  0 -> 1 -> 1 -> 1
```

Router, Memory, and telemetry are disabled. O1 reports complete model, tool,
and turn pairing, two tool starts and completions, and zero dropped events.

## Preserved V24R10 Case 09 replay

The reviewer-readable driver `replay-preserved-case09.mjs` copies the immutable
V24R10 Gate V2 Case 09 workspace into a disposable directory and replaces only
the copied Legal Coverage plugin. The original campaign is never mutated.

The replay temporarily removes and then byte-for-byte restores the already
validated proposal to establish a same-session pre-handoff baseline. It then
drives the real hook and exact injected command through apply, durable receipt,
and replay.

Observed:

```text
proposal:           source-merge-d2979ab3c066.json, 15,355 bytes
handoffOrdinal:     0 -> 1 -> 1 -> 1 -> 1
progressOrdinal:    0 -> 0 -> 0 -> 1 -> 1
applied mutation:   4 sources, 20 facts
durable receipt:    source-merge-applied-d2979ab3c066.json
next work group:    source-fragment-merge
input tree:         unchanged
```

Artifact: `case09-replay-result.json`, SHA-256
`50894e1f6c08cffbc9b14380f831450cd7e9325fec2a977afa28964dd48edeaf`.

Why enough: this is the exact state hash, proposal hash and bytes, source IDs,
and command from the failed 277-second product run. It proves the missing
handoff at the actual dynamic hook boundary, while the unchanged durable
receipt remains the semantic renewal authority.

## Complete repository suite

Command:

```sh
npm test
```

Observed: build plus `309/309` tests passed with no failures, cancellations,
skips, or todos. Artifact: `full-suite.log`, SHA-256
`bfc02836bf9fe56cf859e2267a028956bd343b92e7b13f6935bf07eb37a34d34`.

Why enough: the complete run covers every repository component against this
candidate, including Core Lease and compaction, Gateway, O1, source repair,
ordinary receipts, matrices, authorities, and non-legal behavior. No Core
implementation file changed.

## Omitted and residual risk

No API key, provider URL, authorization header, environment dump, private
source content, report text, prompt text, or model reasoning is included. The
replay result retains only hashes, counts, stable artifact basenames, source
identifiers, and ordinal transitions.

This evidence does not prove that the production model will complete Case 09.
V24R11 is protocol-, Gateway-, O1-, full-suite-, and exact-failure-replay
verified. A fresh immutable campaign must still pass Gate 0, paired smoke,
Case 05, and complete Case 09 before V25 or the 85-case campaign is authorized.
