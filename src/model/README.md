# Model providers

Owns the provider catalog, canonical model protocol, provider adapters, streaming and retry/error handling.

Entry points: [ModelRuntime.ts](ModelRuntime.ts), [canonical.ts](protocol/canonical.ts), [streamModel.ts](streaming/streamModel.ts).

Keep provider wire formats separate from transcript metadata and never log credentials or raw private prompts.

Media-reference preparation bounds filesystem reads to four at a time by default, reads duplicate paths once per preparation, and preserves message/block order. Abort stops queued work and propagates cancellation; missing files retain their text preview. Request attempts reuse materialized media across route projections without caching it across turns.

[User request classification](protocol/userRequest.ts) distinguishes task-bearing input from injected context and tool results for routing and compaction. Provider wire validation still operates on the complete request, including synthetic context.

Tests: [tests/model](../../tests/model). See the [test guide](../../docs/testing.md) for runner selection.

Reference: [reasoning settings](../../docs/reasoning-settings.md).
