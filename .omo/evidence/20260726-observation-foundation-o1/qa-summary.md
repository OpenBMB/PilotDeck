# Observation Foundation O1 QA evidence

Date: 2026-07-26 (Asia/Shanghai)
Branch: `codex/observation-foundation-o1`
Base: `5a4c565c17033bc043e150de844ccabfd433c97c`

## What was tested

- TypeScript strict compilation and the production build.
- Focused Recorder, verifier, config, real in-process Gateway, dynamic-context,
  PreModelRequest, Router fallback/retry, and cross-session request identity tests.
- O1 off/on semantic equivalence for the final Agent-visible model request.
- The complete PilotDeck test suite, including the frozen Legal Plugin tests.
- A local timing calibration of Recorder enqueue and deterministic request
  fingerprinting at 128 KiB and 1 MiB.

Commands:

```text
pnpm exec tsc -p tsconfig.json --noEmit
pnpm run build
node --test --test-force-exit --test-timeout 60000 \
  dist/tests/observability/local-gateway-observation.spec.js \
  dist/tests/observability/router-observation.spec.js \
  dist/tests/observability/recorder.spec.js \
  dist/tests/pilot/config/observability.spec.js
pnpm test
```

## What was observed

- Focused O1 tests: 9 passed, 0 failed.
- Full PilotDeck suite after permission hardening: 260 passed, 0 failed,
  duration 28.625 seconds.
- O1 off/on produced equal messages, system prompt, tools, tool choice, model
  parameters, and cache breakpoints after excluding the expected session-scoped
  transient identity.
- A primary failure, fallback failure, and fallback retry generated three unique
  model request IDs and exactly one terminal fact for every request.
- Parent and subagent sessions sharing a turn ID generated distinct request IDs.
- The real Gateway Bundle was `complete`; prompt and hook bodies and the fixture
  API key were absent from `observations.jsonl`.
- The observation directory was `0700`; JSONL, trajectory, and integrity files
  were `0600` on the POSIX calibration host.
- Recorder overflow emitted an explicit gap and produced `partial`; duplicate
  event IDs or secret-bearing keys produced `invalid`.

Timing calibration on the local machine:

| Operation | Samples | Median | p95 | p99 |
| --- | ---: | ---: | ---: | ---: |
| Recorder `emit` | 10,000 | 0.00088 ms | 0.00146 ms | 0.00246 ms |
| 128 KiB request fingerprint | 500 | 1.976 ms | 2.610 ms | 3.275 ms |
| 1 MiB request fingerprint | 100 | 15.420 ms | 15.815 ms | 17.370 ms |

## Why this is enough for the pre-campaign gate

The tests drive the real in-process Gateway and the actual Agent lifecycle,
not only isolated data structures. They prove that O1 records the final Provider
attempt boundary, preserves prompt injection lineage by hash, fails visibly on
observation loss, and does not alter Agent-visible inputs. Full-suite coverage
guards shared Core behavior and the existing legal runtime boundary.

The timing result separates the bounded queue operation from request hashing.
The queue is far below the 2 ms p99 architecture budget. Hashing remains a
small deterministic pre-request cost even at an intentionally large 1 MiB
fixture and does not retain plaintext.

## What was omitted

- No real provider credential, environment dump, prompt body, tool body,
  private chain-of-thought, legal source text, rubric, or expected answer is
  stored here.
- Authenticated deployment smoke and fresh legal-case calibration are the next
  campaign gate and are intentionally not claimed by this pre-campaign record.
- The 85-case campaign was not run.
