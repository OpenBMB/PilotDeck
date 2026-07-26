# O1 subagent tool-pairing calibration fix

Date: 2026-07-26 (Asia/Shanghai)

## What was tested

- A live candidate Case 05 run using the first O1 implementation.
- Focused bridge coverage for a subagent tool result, including hash-only output
  fingerprinting and plaintext exclusion.
- TypeScript strict compilation, production build, O1 focused tests, and the
  complete PilotDeck suite after the correction.

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

- The first live Case 05 Bundle was correctly rejected as `partial`: 168 tool
  starts, six parent-tool terminals, and 162 missing subagent-tool terminals.
- Root cause was the O1 bridge ignoring `subagent_tool_result` while recording
  the corresponding subagent `pre_tool_execute` events.
- The correction emits the same hash-only `tool.call.completed` fact for parent
  and subagent results, adding only subagent identity metadata.
- The regression test proves the output hash exists and the private fixture
  output body is absent.
- O1 focused suite: 10 passed, 0 failed.
- PilotDeck full suite: 261 passed, 0 failed.

## Why it is enough before live recalibration

The fix is at the generic Agent-event bridge where the missing fact originates,
not in the verifier or legal product. Focused coverage proves the exact event
mapping and hash-only boundary; the full suite guards shared Agent, Gateway,
tool, subagent, plugin, and legal runtime behavior. A new immutable campaign is
still required to prove the corrected live multi-tool path.

## What was omitted

- No prompt, tool body, legal source, expected answer, credential, or private
  reasoning is stored here.
- The failed campaign was not reused and Case 09 was not started.
