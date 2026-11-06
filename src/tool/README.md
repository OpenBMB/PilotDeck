# Tools

Registers and schedules built-in and contributed tools, applying permission decisions and audit boundaries.

Entry points: [index.ts](index.ts), [todoWrite.ts](builtin/todoWrite.ts), [bash.ts](builtin/bash.ts).

Todo updates use stable IDs and explicit merge/cancellation semantics. Shell and file operations must retain their path and ownership checks.

ToolRuntime validates mode restrictions, input schema and prompt capability after hooks and again before dispatch. Permission-rewritten inputs also pass the tool's semantic validator and todo gate. Cancellation after permission handling prevents a new tool body from starting; every early rejection retains its structured result and audit record.

The concurrent scheduler overlaps consecutive calls declared safe for their input, with a default limit of four active runtime calls per batch. The optional `{ maxConcurrency }` constructor argument accepts a positive safe integer; `1` serializes execution. Exclusive and unknown calls are barriers, and results keep submitted order. Unexpected failures stop dispatch and drain started work. Queued cancelled calls use ToolRuntime's audited abort path. This limit does not apply globally across sessions or nested tool calls.

A hook that changes a parallel-dispatched call into exclusive work receives an error before its body starts; retry that call alone. Running bodies must still cooperate with cancellation. Tool names and aliases share one namespace; registration and replacement validate the entire alias set before mutating it, so a failed reload preserves the previous definition.

`ToolRegistry.replaceGroup` validates a complete owned group against the remaining tools before publishing any removals or additions. Catalog bindings must retain ownership of those definitions and refresh only between model/tool batches.

Validate these boundaries with `tests/tool/execution-contracts.spec.ts` and `tests/tool/scheduler-ordering.spec.ts`.

Video tools use [durable jobs](builtin/videos/VideoJobManager.ts) and [session attachments](builtin/videos/VideoStore.ts). See [video generation](../../docs/video-generation.md) for opt-in, recovery and export boundaries.

Tests: [tests/tool](../../tests/tool). See the [test guide](../../docs/testing.md) for runner selection.
