# Model providers

Owns the provider catalog, canonical model protocol, provider adapters, streaming and retry/error handling.

Entry points: [ModelRuntime.ts](ModelRuntime.ts), [canonical.ts](protocol/canonical.ts), [streamModel.ts](streaming/streamModel.ts).

Keep provider wire formats separate from transcript metadata and never log credentials or raw private prompts.

Tests: [tests/model](../../tests/model). See the [test guide](../../docs/testing.md) for runner selection.

Reference: [reasoning settings](../../docs/reasoning-settings.md).
