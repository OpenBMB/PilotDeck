# Gateway

Coordinates sessions, turn submission, permissions and project operations through one interface shared by in-process and remote clients.

Entry points: [Gateway.ts](Gateway.ts), [InProcessGateway.ts](client/InProcessGateway.ts), [GatewayWsClient.ts](client/GatewayWsClient.ts).

Keep RPC compatibility, accepted-input identity and process ownership intact when changing execution paths.

Tests: [tests/gateway](../../tests/gateway). See the [test guide](../../docs/testing.md) for runner selection.
