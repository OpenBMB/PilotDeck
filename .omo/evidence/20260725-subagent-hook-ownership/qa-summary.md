# Subagent hook ownership QA

Date: 2026-07-25
Branch: `codex/convergence-hardening-v1`
Base commit: `072c0afc39817b758aa47f28d9ed250b9004a6c8`

## Triggering evidence

Candidate-only Case 09 in campaign
`20260725-e2-elite-convergence-v8-guidance-command`, run
`20260725_182123_d941239d`, successfully consumed the new stable
`reference --name data-contracts` command and launched two disjoint evidence
workers. The workers created four preserved fragments; worker 1 validated its
fragment as 12 source rows, 44 facts, zero reciprocal-link errors, and zero
missing required fields.

Both `agent` tool calls were nevertheless returned to the parent as errors.
The subagents shared an already configured legal workspace, so their own
PreModelRequest and Stop hooks inherited the main matter's incomplete
`source_not_inventoried` contract. The workers correctly did not edit canonical
`sources.json`, but were then blocked for not completing the whole matter. The
parent could not receive and merge their reports and correctly failed closed.

## Change and boundary

PilotDeck Core now adds its already-known `isSubagent` boolean to generic hook
base input for AgentLoop lifecycle events; top-level TurnRunner input explicitly
sets it to false. Core contains no legal policy and does not disable subagent
tools or convergence globally.

The Legal Plugin consumes that generic identity. Matter-level activation,
dynamic convergence metadata, completion validation, and Stop enforcement are
inactive for subagent sessions. Main-agent behavior remains unchanged. Evidence
workers continue to receive the parent's scoped directive and their normal tool
permissions, may write only assigned fragments under the Skill contract, and
do not gain permission to edit canonical ledgers or completion proof.

No progress-lease threshold, validator rule, runner behavior, activation term,
case fact, benchmark ID, or expected answer changed.

## Commands and observations

```text
npm run build
node --test --test-force-exit --test-timeout 60000 \
  dist/tests/agent/agent-loop-runtime-controls.spec.js \
  dist/tests/agent/legal-coverage-plugin-runtime.spec.js \
  dist/tests/products/legal-coverage.spec.js
```

Result: 37 passed, 0 failed. Coverage includes explicit Core subagent identity
delivery, a configured legal workspace that injects no matter-level context into
a subagent and does not block its Stop, and unchanged main-agent legal lifecycle
and failure behavior.

```text
npm test
```

Result: 243 passed, 0 failed. This includes real local Gateway legal lifecycle,
subagent and tool behavior, hook protocol, progress lease and compaction,
artifact contracts, server, channels, config, and history.

## Why this is enough and residual risk

The focused tests reproduce the ownership distinction directly and the full
suite protects generic hook and agent behavior. A fresh external-model campaign
must still prove that Case 09 worker reports return successfully to the parent,
the parent merges bounded fragments into canonical state, and opaque progress
renews before the unchanged main-agent lease expires.

No API key, token, auth header, environment dump, private corpus content, or raw
model payload is stored here.
