# Channels and transports

Connects CLI/TUI, messaging channels and HTTP-facing adapters to the shared Gateway.

Entry points: [index.ts](index.ts), [loadEnabledChannels.ts](channel/loadEnabledChannels.ts), [httpRouter.ts](web/httpRouter.ts).

Preserve channel/session identity and asynchronous permission delivery; keep model execution in the shared runtime.

Tests: [tests/adapters](../../tests/adapters). See the [test guide](../../docs/testing.md) for runner selection.
