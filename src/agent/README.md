# Agent execution

Runs model/tool turns, continuation and recovery. It publishes execution events; transport-specific rendering belongs to adapters.

Entry points: [index.ts](index.ts), [AgentLoop.ts](loop/AgentLoop.ts).

Use structured todo updates for multi-step work and verify outcomes before reporting completion; todo tool ownership stays in the tool module.

Tests: [tests/agent](../../tests/agent). See the [test guide](../../docs/testing.md) for runner selection.
