# Gateway

Coordinates sessions, turn submission, permissions and project operations through one interface shared by in-process and remote clients.

Entry points: [Gateway.ts](Gateway.ts), [InProcessGateway.ts](client/InProcessGateway.ts), [GatewayWsClient.ts](client/GatewayWsClient.ts).

Keep RPC compatibility, accepted-input identity and process ownership intact when changing execution paths.

`python_runtime_status` reports the executing host's verified Python capability through both local and remote Gateways. `runtime.python.enabled` defaults to true. Python preference changes retire project runtimes without closing their sessions, MCP connections or tasks; disposal follows the final session/turn lease and background-task completion. New turns recreate dirty sessions against the new preference, including changes received during session initialization. The Web UI never probes its browser host for this status.

Config and extension reloads use the same retirement boundary. A project-scoped reload leaves other projects untouched; active turns retain their runtime until their session, turn and background-task leases finish. Per-session MCP connections close on session eviction, while shared connections close after the retired project runtime loses its owners. Gateway shutdown has a separate force-cleanup path.

Tests: [tests/gateway](../../tests/gateway). See the [test guide](../../docs/testing.md) for runner selection.
