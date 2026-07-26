# Agent Subagent Budget Hardening QA

## What Was Tested

Build gate:

```bash
npm run build
```

Focused deterministic gate:

```bash
node --test --test-timeout 10000 \
  --test-reporter=tap \
  --test-reporter-destination=.omo/evidence/20260727-agent-subagent-budget-hardening/focused-tests.tap \
  dist/tests/agent/sub/SubagentBudget.spec.js \
  dist/tests/agent/subagent-budget-integration.spec.js \
  dist/tests/gateway/turn-deadline-propagation.spec.js \
  dist/tests/tool/builtin/agent-subagent-type.spec.js \
  dist/tests/observability/local-gateway-subagent-budget.spec.js
```

Full repository regression gate:

```bash
node --test --test-force-exit --test-timeout 60000 \
  --test-reporter=tap \
  --test-reporter-destination=.omo/evidence/20260727-agent-subagent-budget-hardening/full-suite.tap \
  "dist/tests/**/*.test.js" \
  "dist/tests/**/*.spec.js"
```

The focused gate drives the real local Gateway and AgentLoop with an isolated
Pilot home, project, skill root, deterministic model runtime, Router disabled,
Memory disabled, and O1 diagnostic observation enabled.

## What Was Observed

- Build completed successfully under the repository's required Node runtime.
- Focused gate: 15 passed, 0 failed.
- Full repository gate: 294 passed, 0 failed.
- The child request contained the effective runtime budget directive.
- A child model that waited only for abort terminated with typed
  `subagent_timeout` behavior.
- A child operation that ignored abort could not keep the parent waiting.
- Parent abort remained an abort and was not misclassified as child timeout.
- The parent continued after child timeout and emitted a completed turn.
- O1 integrity was `complete`; model requests, tool calls, and turns were
  paired; recorder drops were zero.
- O1 contained `subagent.started`, `subagent.failed`, and a completed `agent`
  tool terminal.
- Raw observations contained neither the injected prompt text nor the test API
  key.

Exact outputs:

- `focused-tests.tap`
- `full-suite.tap`

## Why It Is Enough

The focused tests cover the new contract at unit, AgentLoop integration,
Gateway propagation, fallback model, and O1 trajectory levels. The full suite
then covers the unchanged neighboring surfaces, including Legal Coverage,
Progress Lease, Router, Memory, Gateway, model runtime, artifact validation,
and all existing tools. This directly exercises the failure mode from the
closed Case 05 campaign without weakening any legal acceptance rule or parent
deadline.

## Counterexample Covered

Closed V24R5 Gate 2a Case 05 run `20260727_015639_fb7afb31` reached the
2,100-second Gateway deadline. One generic research child ran for at least
2,075 seconds and started 164 tools, including 79 `web_fetch` and 76 `bash`
calls, while repeatedly switching equivalent public search endpoints. The
campaign omitted a child timeout override and the prior Core fallback was 60
minutes, so the parent deadline fired first.

The new contract defaults children to 10 minutes, clamps them against the
absolute parent deadline with a 30-second handoff reserve, injects the
effective budget and diminishing-return guidance, and races the wait itself
against abort.

## What Was Omitted

- No external LLM API call was made during deterministic QA.
- No private legal source text, provider key, authorization header, or
  environment dump was captured.
- Case 05 was not rerun before freezing and committing this Core candidate.
- Case 09 and the 85-case suite remain unauthorized until the new campaign
  passes the earlier gates.
