# PilotDeck Agent Subagent Budget Hardening

## Status

- Worktree: `/Users/da/Documents/PilotDeck-worktrees/20260727-fix-agent-subagent-budget-hardening-v1`
- Branch: `codex/agent-subagent-budget-hardening`
- Frozen base: V24R5 `23d13803357025018ab9371c5f5a78cfacc2a777`
- Scope: generic Agent/Core child execution only.
- Legal Coverage, legal acceptance, Progress Lease limits, Router, and Memory are
  frozen.

## Evidence

The closed V24R5 Gate 2a Case 05 run timed out at the 2,100-second Gateway
deadline. One of three concurrent `general-purpose` subagents was still running
after at least 2,075 seconds and had issued 164 tool calls, including 79
`web_fetch` and 76 `bash` calls. Its siblings completed in 92 and 373 seconds.

Core already exposed `agent.subagents.timeoutMs`, but the tool fallback had
been increased from 120 seconds to 60 minutes. The campaign did not override
it, so the child limit was longer than the parent deadline. Legal Coverage and
Progress Lease never activated in the failed run.

## Contract

Every forked subagent now receives one effective wall-clock budget:

1. Use configured `agent.subagents.timeoutMs` when present; otherwise use the
   10-minute Core default.
2. Propagate the Gateway's absolute parent-turn deadline through AgentSession,
   TurnRunner, AgentLoop, and the tool runtime.
3. Clamp the child budget so at least 30 seconds remain for the parent to
   receive the child result, handle failure, and produce a terminal response.
4. Reject a new child launch when that 30-second handoff window has already
   begun.
5. Inject the effective budget into the child directive. The generic guidance
   requires a best-current result with explicit gaps when repeated retrieval
   attempts stop improving evidence.
6. Race the wait itself against abort. A model, provider, or tool that ignores
   `AbortSignal` cannot keep the parent waiting past the child budget.
7. Emit a typed `subagent_timeout` tool failure and an internal
   `subagent_completed` lifecycle event with `success: false`. O1 projects that
   terminal as `subagent.failed`, so the parent can continue while the child
   and parent tool terminals remain paired.

The 30-second reserve is a terminal handoff guard, not a promise that every
large artifact can be synthesized in 30 seconds. Evaluation campaigns should
still choose an explicit child timeout that leaves a task-appropriate parent
window. For the 35-minute legal Gate, the next campaign should freeze
`agent.subagents.timeoutMs: 600000`, leaving at least 25 minutes when children
are launched near the start of the turn.

## Dynamic Prompt Injection

The child receives a runtime-only block appended to its delegated directive:

```text
<subagent-execution-budget>
Hard wall-clock budget: N seconds.
Prioritize the requested outcome and the strongest available evidence.
If repeated retrieval or tool attempts stop producing materially better
evidence, return the best current result with explicit gaps instead of cycling
through equivalent alternatives.
Leave enough time to produce the requested final report before this budget
expires.
</subagent-execution-budget>
```

This is generic Harness policy. It contains no legal concepts, source rules,
validator fields, or benchmark-specific answer hints.

## Rejected Alternatives

- Do not add a fixed tool-call count. Tool granularity varies too much across
  local reads, network retrieval, code execution, and MCP tools.
- Do not weaken the 35-minute Gateway deadline. That would hide the runaway
  trajectory and reduce experiment comparability.
- Do not put research-loop rules into Legal Coverage. Case 05 proves the
  failure occurs before the legal plugin is active.
- Do not rely on prompt wording alone. The dynamic instruction improves model
  behavior, while the abort race supplies the enforceable boundary.

## Verification

Deterministic tests must prove:

- the 10-minute default and configured override;
- clamping against the parent deadline and rejection inside the handoff window;
- exact effective-budget prompt injection;
- full-fork and fallback timeout behavior;
- return of control when a callee ignores abort;
- failed child lifecycle plus a paired `subagent_timeout` tool result;
- parent completion after a child timeout;
- Gateway deadline propagation.

Then run the full repository suite and a real isolated Gateway integration. A
new immutable campaign must pass infrastructure smoke, Case 05, and Case 09 in
that order before any 85-case run is authorized.
