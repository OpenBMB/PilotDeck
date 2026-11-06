# Agent execution

Runs model/tool turns, continuation and recovery. It publishes execution events; transport-specific rendering belongs to adapters.

Entry points: [index.ts](index.ts), [AgentLoop.ts](loop/AgentLoop.ts).

`AgentLoop` owns turn sequencing, routing, recovery and event delivery. [prepareModelRequest.ts](loop/prepareModelRequest.ts) assembles each request through narrow context, tool-list and capability dependencies. It takes a fresh tool projection, applies ask/plan and interaction constraints, preserves message/tool pairing, passes Python runtime awareness into context preparation, and materializes media before adding the current plan reminder. Cache plans fingerprint the final effective system prompt and messages sent to the model. Budget previews use the same preparation path without instruction lifecycle events.

Tool execution events are drained before results or failures leave the loop. Rejections retain their original reason, including falsy values, so every requested tool call receives a paired result during recovery.

Use structured todo updates for multi-step work and verify outcomes before reporting completion; todo tool ownership stays in the tool module.

Tests: [tests/agent](../../tests/agent). See the [test guide](../../docs/testing.md) for runner selection.

Focused boundary coverage: [request preparation](../../tests/agent/loop/request-preparation.spec.ts), [tool failure propagation](../../tests/agent/loop/tool-failure-propagation.spec.ts), [model overrides](../../tests/agent/loop/model-override-defaults.spec.ts), and [Python awareness](../../tests/context/python-awareness.spec.ts).
