# Model context

Assembles prompts, resolves attachments and memory, accounts for tokens and compacts history.

Entry points: [index.ts](index.ts), [DefaultContextRuntime.ts](DefaultContextRuntime.ts), [PromptAssembler.ts](prompt/PromptAssembler.ts).

Context summaries expose category estimates without full prompt payloads. Full diagnostic snapshots require an explicit authenticated request.

Python capabilities come from the Gateway's verified runtime snapshot, which also supplies the turn's shell, background-task and MCP environment. The typed `pythonRuntime` field flows through `AgentRuntimeConfig`, `ContextPrepareInput` and `PromptAssembler`; its always-present user-context section survives custom system prompts and context compaction. Only public interpreter/package metadata is included, never the host environment map. Subagents inherit their parent's snapshot.

Prompt assembly reads one fresh extension metadata snapshot, orders commands/skills deterministically, and describes only tools available in that request. Custom prompts skip the extension sections they replace. Retrieved memory is synthetic reference context after conversation history; changing retrieval results does not rewrite the system prefix or persisted history. Memory retrieval uses the latest real user request, excluding compaction notices and prior memory attachments. Cache plans identify the final context before assigning a session generation; previews do not commit generations or consume resets. Provider-reported usage, not local fingerprints, measures actual cache reuse.

`prepareForModelAttempt` is an optional staged interface: resolve external inputs, project a provider/model without new I/O, then commit the dispatched projection's date and final cache plan once. Discarded candidates do not mutate session state. Direct `prepareForModel` calls remain supported. Artifact and instruction preparation honor cancellation; legacy asynchronous callbacks may finish in the background but their results cannot start later preparation stages.

The context popover requests `includeModelContext=summary` on authenticated message history and receives only `contextBreakdown`. `includeModelContext=true` explicitly requests the full diagnostic snapshot. Normal history reads omit snapshot I/O. Local system/tool/message estimates describe the latest assembled request and can differ from the reported token budget.

Snapshots atomically replace a private `<transcript>.context.json` sidecar. Readers validate transcript ownership and reject snapshots from an older accepted turn. Session deletion removes the sidecar. Forked sessions without a fresh snapshot show unavailable estimates until their next model request.

Tests: [tests/context](../../tests/context). See the [test guide](../../docs/testing.md) for runner selection.
