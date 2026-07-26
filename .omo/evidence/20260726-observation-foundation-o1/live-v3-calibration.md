# O1 live v3 calibration

Date: 2026-07-26 (Asia/Shanghai)
Campaign: `20260726-observation-foundation-o1-calibration-v3`
Core commit under test: `2ef688344186b469740e4d5b0d498e32de41796f`
Runner commit: `4d5b5b25d47be622e09a6886ec8637d1d1e6e271`

## What was tested

- Gate 0 immutable deployment and boundary checks.
- Authenticated baseline and candidate infrastructure smoke.
- Candidate Case 05 non-activation and exact tool/request pairing.
- Candidate difficult Case 09 with dynamic prompt injection, subagents,
  compaction, progress-lease decisions, and a product fail-closed terminal.
- Offline re-verification of the preserved Case 09 stream with the current Core
  verifier.

## What was observed

- Both smoke runs returned the exact expected answer and produced
  `complete/comparable`, zero-loss, secret-clean O1 Bundles.
- Case 05 produced 9 unique model requests with 9 terminals and 15 unique tool
  starts with the same 15 terminal IDs. Legal coverage did not activate.
- Case 09 produced 247 O1 events with zero drops: 17 unique sequential model
  request IDs, 17 response terminals, 59 unique tool starts and the same 59
  terminal IDs, plus two paired subagent lifecycles.
- Case 09 produced 21 unique `(requestId, injectionId)` facts. Every injection
  referenced one emitted request and appeared in that request's injection list;
  the reverse relation also had zero missing facts.
- Bundle hash checks and scans for query/injection plaintext, secret-bearing
  keys, and the approved credential value passed.
- Offline verification returned `complete` with all checks true and no
  omissions.
- The legal product independently failed closed in the sources phase with
  `boundary_rejected`; this did not make the O1 evidence incomplete.

## Why it is enough for O1

The campaign combines deterministic unit/full-suite evidence with authenticated
live paths covering ordinary tools, subagent tool results, sequential Router
requests, dynamic prompt injection, compaction decisions, and an error result.
The difficult run directly proves that the request identity fix preserves a
one-to-one model boundary and a lossless injection lineage under the conditions
that exposed the v2 false-complete defect.

The minimal O1 profile is therefore calibrated as an observation foundation.
This does not establish legal product correctness or authorize product-policy
changes.

## What was omitted

- No prompt body, tool body, legal source, expected answer, credential, private
  reasoning, or raw secret-bearing log is stored here.
- No Legal Plugin, validator, lease setting, Router/Memory switch, or evaluation
  answer was changed.
- Candidate product failure prohibited the predeclared baseline Case 09 run.
- The 85-case campaign was not run.

Full campaign evidence:

```text
/Users/da/Documents/PilotDeck-eval-labs/20260726-observation-foundation-o1-calibration-v3/evidence/
```
