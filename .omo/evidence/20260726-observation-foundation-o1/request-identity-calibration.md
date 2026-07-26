# O1 model-request identity calibration

Date: 2026-07-26 (Asia/Shanghai)

## What was tested

- Two sequential Router executions sharing one Recorder, session, and turn.
- Integrity verification for a reused model request ID and duplicate terminal
  facts.
- Offline re-verification of the immutable v2 Case 09 observation stream using
  the corrected verifier.
- The complete PilotDeck test suite after the identity correction.

Commands:

```text
pnpm test
node --input-type=module -e '<offline verifier invocation>' \
  <v2-case09-observations.jsonl> <v2-case09-integrity.json>
git diff --check
```

## What was observed

- The full PilotDeck suite passed: 263 passed, 0 failed, in 30.620 seconds.
- Sequential requests in one turn received distinct, monotonic identities ending
  in `:model:1` and `:model:2`.
- A reused request ID with duplicate terminal facts made model pairing fail and
  changed integrity to `partial`.
- The unchanged v2 Case 09 stream contained 31 request starts but only one unique
  request ID. The old verifier had reported `complete`; the corrected verifier
  reported `partial` with one `model_request_id_duplicate` omission and one
  `model_request_terminal_duplicate` omission.
- The v2 stream's schema, event identity, sequence, tool pairing, turn pairing,
  secret-key check, and Recorder health remained valid. This isolates the
  calibration failure to model-request identity rather than data corruption.

## Why it is enough before live v3 calibration

The regression tests cover both sides of the defect: identity generation and
integrity rejection. Re-verifying the original failing stream proves that the
new check detects the exact false-complete condition observed in the live legal
case. The full suite guards shared Router, Agent, Gateway, plugin, and legal
runtime behavior. A fresh live campaign is still required to prove that newly
recorded requests and prompt-injection facts have one-to-one identities.

## What was omitted

- No prompt body, tool body, legal source, expected answer, credential, private
  reasoning, environment dump, or raw secret-bearing log is stored here.
- The immutable v2 artifacts were read only and were not rewritten.
- No Legal Plugin, validator, lease policy, Router/Memory switch, or evaluation
  answer was changed.
- The 85-case campaign was not run.
