# V24R15 post-tool convergence preview QA

## What was tested

### Focused cross-layer gate

Command:

```bash
npm run build
node --test --test-force-exit --test-timeout 120000 \
  dist/tests/extension/hooks/model-request-patch.spec.js \
  dist/tests/agent/progress-lease.spec.js \
  dist/tests/tool/bash-result-display.spec.js \
  dist/tests/agent/agent-loop-runtime-controls.spec.js \
  dist/tests/gateway/map-agent-event-runid.spec.js \
  dist/tests/observability/recorder.spec.js \
  dist/tests/observability/local-gateway-progress-handoff.spec.js \
  dist/tests/products/legal-coverage.spec.js
```

Artifact: `focused-gate.log`

This drove the bounded parser, HookRuntime event restriction, ToolRuntime
internal transport, Progress Lease planner, AgentLoop ordering, Gateway event
projection, O1 recorder, a real local Gateway, and the unchanged Legal Coverage
validator/transaction surface.

### Full repository regression

Command:

```bash
npm test
```

Artifact: `full-suite.log`

### Patch hygiene

Command:

```bash
git diff --check
```

Artifact: `diff-check.log`

## What was observed

- Focused gate: 103 tests passed, 0 failed.
- Full repository suite: 325 tests passed, 0 failed.
- TypeScript build completed in both gates.
- The synthetic AgentLoop handoff trajectory reached genuine progress with two
  `progress_boundary_deferred` events and zero forced full compactions.
- A stale preview stopped with `boundary_preview_unconfirmed` before a third
  model request was sent and without running a forced full compaction.
- Replay, repair-only, exhausted-budget, and multiple-forcing-scope previews
  did not defer the required boundary.
- The real local Gateway emitted the ordered O1 sequence
  `progress-boundary/deferred` then the authoritative
  `progress-lease/v5` confirmation for both deferred boundaries.
- The real Gateway trajectory finalized with complete model/tool/turn pairing,
  zero recorder drops, and no fake API key in the observation log.
- Legal Coverage produced previews for legal-state writes, but not for reads,
  unrelated writes, or read-only legal CLI commands.
- `git diff --check` produced no findings.

## Why this is enough for the code gate

The tests cover both halves of the protocol. Positive tests prove the original
ordering defect is removed in AgentLoop and in a real Gateway runtime. Negative
tests prove the preview remains advisory: it cannot carry domain payload,
consume lease state, bypass the handoff budget, handle multiple forcing scopes,
or survive a mismatched authoritative report. Full-suite coverage checks the
new hook effect and agent event against every existing product and runtime test.

This evidence completes only the code gate. It does not claim that the 35-minute
Case 09 task now completes semantically.

## What was omitted

- No real LLM credentials, auth headers, environment dumps, or private corpus
  content were copied into evidence.
- No validator, model, Router, Memory, deadline, corpus, or Progress Lease
  threshold was changed.
- No V24R14 campaign artifact was modified or rerun.
- The V24R15 product campaign remains a separate immutable gate after this
  commit and PR are available to the isolated candidate instance.
