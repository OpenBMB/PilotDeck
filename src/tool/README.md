# Tools

Registers and schedules built-in and contributed tools, applying permission decisions and audit boundaries.

Entry points: [index.ts](index.ts), [todoWrite.ts](builtin/todoWrite.ts), [bash.ts](builtin/bash.ts).

Todo updates use stable IDs and explicit merge/cancellation semantics. Shell and file operations must retain their path and ownership checks.

Video tools use [durable jobs](builtin/videos/VideoJobManager.ts) and [session attachments](builtin/videos/VideoStore.ts). See [video generation](../../docs/video-generation.md) for opt-in, recovery and export boundaries.

Tests: [tests/tool](../../tests/tool). See the [test guide](../../docs/testing.md) for runner selection.
