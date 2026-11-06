# Agent execution

Runs model/tool turns, continuation and recovery. It publishes execution events; transport-specific rendering belongs to adapters.

Entry points: [index.ts](index.ts), [AgentLoop.ts](loop/AgentLoop.ts).

[Request preparation](loop/prepareModelRequest.ts) owns model-visible tool filtering, message normalization, context projection, media materialization and final cache planning. It reads current tools for each request and preserves tool-call boundaries when merging assistant continuations. Context preparation owns preview state; the loop supplies the instruction-event callback only when events should be emitted. Plan reminders are appended after projection and media loading, so they cannot displace the real user request or memory query.

AgentLoop retains routing, recovery, budgets, lifecycle dispatch and tool execution. Both normal requests and budget probes use the same preparation path. Changes to request assembly must preserve model overrides, permissions, plan paths, media fallback and cache fingerprints; validate these contracts with `tests/agent/loop/model-request-preparation.spec.ts` and the existing loop/context regression suites.

Tool scheduling failures retain their rejection reason through event delivery and result pairing, including non-Error values; validate that boundary with `tests/agent/loop/tool-scheduler-failure.spec.ts`.

Use structured todo updates for multi-step work and verify outcomes before reporting completion; todo tool ownership stays in the tool module.

Tests: [tests/agent](../../tests/agent). See the [test guide](../../docs/testing.md) for runner selection.
