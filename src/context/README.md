# Model context

Assembles prompts, resolves attachments and memory, accounts for tokens and compacts history.

Entry points: [index.ts](index.ts), [DefaultContextRuntime.ts](DefaultContextRuntime.ts), [PromptAssembler.ts](prompt/PromptAssembler.ts).

Context summaries expose category estimates without full prompt payloads. Full diagnostic snapshots require an explicit authenticated request.

Tests: [tests/context](../../tests/context). See the [test guide](../../docs/testing.md) for runner selection.
