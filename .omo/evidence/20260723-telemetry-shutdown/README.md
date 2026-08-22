# Telemetry shutdown QA evidence

## What was tested

- `npm run build` built the gateway and telemetry changes.
- `node --test --test-timeout 60000 dist/tests/telemetry/telemetry-shutdown.spec.js dist/tests/cli/local-gateway-dispose.spec.js` exercised disabled telemetry, existing queue preservation, re-enabled telemetry persistence, and awaitable `createLocalGateway().dispose()` behavior.
- `npm test` ran the complete repository suite after the awaited-network-timer parent fix was applied locally. The parent fix is independently tracked in PR #441; it is not part of this telemetry change.

## What was observed

- Focused telemetry/gateway tests: 4 passed, 0 failed, 0 cancelled. Exact output: `build-and-focused.txt`.
- Full suite on the combined local validation base: 149 passed, 0 failed, 0 cancelled; exit code 0. Exact output: `full-suite.txt`.
- The local gateway test creates an isolated `PILOT_HOME`, calls `dispose()` twice, awaits the first returned Promise, and verifies that disabled telemetry did not create `telemetry/queue.jsonl`.
- The sender tests verify that an already existing queue remains byte-for-byte unchanged while disabled, and that a sender enabled during its lifetime still persists pending events.

## Why it is enough

The tests cover the observed benchmark failure (empty queue-file recreation after shutdown), API lifecycle behavior (awaitable and idempotent disposal), and the compatibility path where telemetry is toggled during a runtime. The full suite covers unrelated regressions on the same local parent.

## What was omitted

No credentials, telemetry payloads, request headers, or external telemetry uploads were used. All files and provider endpoints were temporary or synthetic.
