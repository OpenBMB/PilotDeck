# E2-Elite adaptive runtime pilot

## What was tested

One difficult legal-opinion case was run through the real PilotDeck local
gateway with the legal plugin installed in an isolated PilotDeck home and an
isolated workspace. The run used the original task query and 62 copied source
files. No rubric, expected answer, Judge response, or case-specific answer was
available to the plugin or Agent.

The evaluation-only mutation guard denied dependency installation, privilege
escalation, writes outside the isolated workspace, and, after the first-run
finding, writes under the copied source root. The user's downloaded source
files and real PilotDeck home were not modified.

Three bounded observations were retained:

1. an initial 72-turn end-to-end run using state-hash milestone deduplication;
2. a 12-turn continuation using observable-progress deduplication;
3. a 12-turn continuation after adding the deterministic coverage-batch CLI.

A final model-free hook probe exercised automatic work-slice injection over the
resulting real legal state.

## What was observed

### Initial run

- Duration: 3,241,710 ms (about 54 minutes).
- Finish reason: `tool_error` after the configured turn budget.
- Model requests reported by the runtime: 73; audited stream calls including
  delegated activity: 206.
- Total token accounting: 7,876,826.
- Canonical state reached 64 source rows, 256 facts, 7 matrices, 13 issues,
  9 authorities, and 2 deliverables.
- Validation remained failed with 212 errors; first error:
  `coverage/deliverable_hash_missing`.
- No completion proof was created.
- One attempted canonical write was about 84 KiB and required large-output
  recovery.
- The Agent created two OCR text caches under the copied input root. This
  increased the source inventory from the original 62 files to 64 rows. The
  original Downloads corpus was unchanged, but the mutation is still a process
  failure.

The old digest replayed the envelope repeatedly when draft/state hashes changed
without a meaningful milestone change. Near the end of the run, every audited
stream request carried an envelope.

### Observable-progress continuation

- Duration: 266,435 ms; 12 model turns.
- Total token accounting: 413,578.
- Envelope delivery: 1 of 12 requests.
- Legal state and 212 validation errors were unchanged.

This isolates a real cost improvement from semantic progress: suppressing
opaque hash churn removed repeated prompt delivery, but it did not tell the
Agent how to read a bounded slice of the large existing ledgers.

### Coverage-batch continuation

- Duration: 723,066 ms; 12 model turns.
- Total token accounting: 488,515.
- Envelope delivery: 2 of 12 requests. The second injection followed a genuine
  blocking-gap change.
- `coverage.json` advanced from empty arrays to 2 deliverables, 10 unresolved
  sources, 42 facts, 9 issues, and 7 authorities.
- Validation errors fell from 212 to 164; first error became
  `coverage/unresolved_source_not_disclosed`.
- No completion proof was created.

The Agent created and used its own coverage scripts instead of the new CLI and
wrote about 40 KiB in one step, so the model did not obey the new 12-record /
24-KiB transaction guidance. The run proves progress, not compliance or final
quality.

### Automatic dynamic work-slice probe

The final production hook was invoked directly against the 164-error real
state. It produced:

- milestone: `VALIDATING`;
- total context size: 3,627 bytes;
- first gap: 19 occurrences of `unresolved_source_not_disclosed`;
- injected work group: `sources`;
- injected items: 4 of 19;
- work-item payload: 1,237 bytes, capped by 4 records / 2,048 bytes;
- benchmark-marker scan: no rubric, Judge-response, checkpoint ID, or ground
  truth marker.

## Why it is enough

The initial run proves the workflow can inventory and project a large,
multi-format legal room while exposing real cost and mutation failures. The two
continuations isolate the effect of prompt deduplication and bounded work
discovery. The final probe proves the shipped hook can inject a compact,
current, domain-owned work slice without relying on model compliance to invoke
the CLI first.

Together with the automated gateway tests, this is enough to accept the
bounded vertical slice and reject the previous hash-driven prompt replay. It is
not enough to claim that the difficult case or the 82-case corpus semantically
passes.

## What was omitted

Raw legal sources, extracted facts, opinion text, model messages, expected
answers, rubric content, Judge payloads, credentials, private configuration,
and raw tool logs are omitted. Only aggregate counts, failure codes, hashes,
and control-flow observations are recorded.

## Remaining risk

- The difficult case still has 164 deterministic coverage errors.
- The final automatic work-slice injection has deterministic and gateway test
  coverage, but was not followed by another paid 12-turn model run.
- Model guidance alone did not enforce the batch-write limit; a generic Core
  mutation/size contract remains a separate future capability.
- The original legal Skills needed for a faithful 82-case A/B rerun are absent
  from the supplied archive.

