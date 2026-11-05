# Model context

Assembles prompts, resolves attachments and memory, accounts for tokens and compacts history.

Entry points: [index.ts](index.ts), [DefaultContextRuntime.ts](DefaultContextRuntime.ts), [PromptAssembler.ts](prompt/PromptAssembler.ts).

Context summaries expose category estimates without full prompt payloads. Full diagnostic snapshots require an explicit authenticated request.

The context popover requests `includeModelContext=summary` on authenticated message history and receives only `contextBreakdown`. `includeModelContext=true` explicitly requests the full diagnostic snapshot. Normal history reads omit snapshot I/O. Local system/tool/message estimates describe the latest assembled request and can differ from the reported token budget.

Snapshots atomically replace a private `<transcript>.context.json` sidecar. Readers validate transcript ownership and reject snapshots from an older accepted turn. Session deletion removes the sidecar. Forked sessions without a fresh snapshot show unavailable estimates until their next model request.

Tests: [tests/context](../../tests/context). See the [test guide](../../docs/testing.md) for runner selection.
