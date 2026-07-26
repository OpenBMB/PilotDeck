# V24R8 Immutable Source Repair QA

## Scope and boundary

V24R8 changes only the Legal Coverage source-proposal repair protocol. It does
not change PilotDeck Core, validator acceptance, issue taxonomy, Progress Lease
thresholds `8/2`, Router, Memory, O1, V24R7 authority closure, the model, or the
evaluation corpus.

The success criterion is narrow: a rejected bounded source proposal can be
corrected through one immutable repair transaction, revalidated against the
unchanged proposal and current state, atomically applied, and counted as
semantic progress only after a verified applied receipt.

## Static and automated verification

### Syntax and patch hygiene

Commands:

```sh
node --check products/legal/plugins/legal-coverage/hook.mjs
node --check products/legal/plugins/legal-coverage/scripts/legal-coverage.mjs
node --check products/legal/plugins/legal-coverage/scripts/lib/legal-coverage.mjs
git diff --check
```

Observed: all commands exited `0`; `git diff --check` produced no diagnostics.

Why enough: these checks cover JavaScript parse validity and whitespace errors.
They do not substitute for behavior tests.

### Complete repository suite

Command:

```sh
pnpm test
```

First observation: `307/308` passed. The only failure was the pre-existing O1
equivalence test during recursive temporary-directory cleanup:

```text
ENOTEMPTY: directory not empty, rmdir '.../pilotdeck-observation-equivalence-.../home'
```

Artifact: `full-test.log`.

The failed test was then isolated with:

```sh
node --test --test-name-pattern='enabling O1 does not change Agent-visible model input' \
  dist/tests/observability/local-gateway-observation.spec.js
```

Observed: `1/1` passed. Artifact: `o1-isolated-rerun.log`.

The complete `pnpm test` command was rerun without concurrent diagnostics.
Observed: `308/308` passed, including build, Legal Coverage, Progress Lease,
compaction, Gateway, and O1 tests. Artifact: `full-test-rerun.log`.

Why enough: the clean complete rerun and clean isolated reproduction show that
the first result was a temporary cleanup race, not a reproducible V24R8 or O1
behavior failure. No unrelated O1 code was changed.

## Real Gateway QA

Command:

```sh
node --test --test-force-exit \
  dist/tests/agent/legal-coverage-plugin-runtime.spec.js
```

Observed: `4/4` passed. Artifact: `real-gateway.log`.

The immutable-repair case drove a real local Gateway and real PilotDeck tools
against an isolated temporary `PILOT_HOME`. Its fixture configuration had:

- Router disabled.
- Memory disabled.
- Telemetry disabled.
- O1 enabled with the `diagnostic` profile and queue capacity `4096`.
- A local deterministic mock model, so no external model request or credential
  was used.

The observed trajectory was:

```text
source-fragment-repair
  -> real write_file to the deterministic immutable repair path
source-fragment-repair-apply
  -> real bash execution of the exact state-bound apply command
verified applied receipt
  -> progressOrdinal 0 -> 1
```

The rejected proposal bytes remained unchanged. O1 integrity was `complete`;
model requests, tool calls, and turns were paired, with zero dropped events.
The test also proves that preparation advances once on the required write and
that validation or command execution alone does not manufacture progress.

Why enough: this exercises hook subscription, dynamic prompt injection, tool
execution, CLI revalidation, atomic canonical projection, receipt verification,
Progress Lease metadata, and O1 recording together on the actual Gateway
surface rather than only calling library functions.

## Preserved Case 09 failure replay

Manual action: the preserved V24R7 Case 09 rejected source proposal was copied
to a disposable workspace at:

```text
/private/tmp/pilotdeck-v24r8-case09-replay.AMGjFo
```

The two rejected facts (`4` and `7`) were repaired through the V24R8 immutable
transaction and exact apply command. Artifact: `case09-replay-result.json`.

Observed:

```text
groups:                    repair -> repair-apply -> merge
repairPreparationOrdinal: 0 -> 1 -> 1
progressOrdinal:          0 -> 0 -> 1
proposal unchanged:       true
applied source rows:      4
applied fact rows:        19
```

The post-apply validator exposed more downstream matrix and coverage work
(`89 -> 181` errors). That is expected: the new canonical facts make previously
unobservable work visible. Error-count reduction is not the progress signal;
the verified applied receipt is.

Why enough: this reproduces the exact failure shape that motivated V24R8 and
shows that both rejected facts can cross the former read/edit lease boundary
without weakening validation or mutating the rejected proposal.

## Counterexample coverage

Automated tests reject missing, duplicate, unknown, and extra fact operations;
unsupported actions; placeholders; missing removal reasons; changed diagnostic
identity; invalid locators; byte overflow; changed proposals; changed repairs;
stale state; traversal; symlinked repairs; replay; missing, wrong-path, and
repeated preparation writes; and tampered applied receipts. Canonical ledgers
remain unchanged on every rejected transaction.

## Omitted and residual risk

No API keys, authorization headers, environment dumps, private source contents,
or raw production model logs are included in this evidence directory.

The full 35-minute Case 09 product run with the production model has not yet
been executed. Therefore V24R8 is protocol- and replay-verified, but Case 09 is
not yet a product Gate pass. V25 and the 85-case campaign remain blocked until
a new immutable campaign passes Gate 0, paired smoke, Case 05, and Case 09.
