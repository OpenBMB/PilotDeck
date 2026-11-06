# Tools

Registers and schedules built-in and contributed tools, applying permission decisions and audit boundaries.

Entry points: [index.ts](index.ts), [todoWrite.ts](builtin/todoWrite.ts), [bash.ts](builtin/bash.ts).

Todo updates use stable IDs and explicit merge/cancellation semantics. Shell and file operations must retain their path and ownership checks.

The default [ConcurrentToolScheduler](scheduler/ConcurrentToolScheduler.ts) dispatches calls in submitted order, overlapping only consecutive calls whose tools declare `isConcurrencySafe(input)`. Other calls (including unknown tools) are barriers: all earlier calls finish before a barrier starts, and later calls wait for it. Results retain submitted order even when completion order differs.

Each `executeAll` batch allows up to four active runtime calls by default. The optional constructor argument `{ maxConcurrency }` accepts a positive safe integer; `1` serializes the batch. This is a per-batch limit, not a shared limit across sessions or nested subagents. Tool-returned errors remain ordinary results. Unexpected rejections stop dispatch and drain started calls before rejecting. Cancellation also drains started calls; queued calls pass through ToolRuntime's abort guard to retain one audited result per call. Running tool bodies remain responsible for observing the abort signal.

Video tools use [durable jobs](builtin/videos/VideoJobManager.ts) and [session attachments](builtin/videos/VideoStore.ts). See [video generation](../../docs/video-generation.md) for opt-in, recovery and export boundaries.

Tests: [tests/tool](../../tests/tool). See the [test guide](../../docs/testing.md) for runner selection.
