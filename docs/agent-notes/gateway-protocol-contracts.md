# Gateway Protocol Contracts

## Context

The Gateway owns session, turn, message, and active-run state. Clients and the
UI bridge are transports over that state; they must not create a second turn
state machine.

## Invariants

- A WebSocket client must complete the `hello` handshake before requests.
- Every request keeps its request ID; streamed events keep their stream ID and
  sequence number, and the final frame terminates the stream exactly once.
- Turn-scoped events preserve `sessionKey`, `turnId`, `runId`, and `toolCallId`
  where applicable. Dynamic IDs, timestamps, paths, and secrets are normalized
  in contract assertions.
- Closing a client connection aborts its in-flight turns and releases pending
  request/stream waiters.
- Structured Gateway errors expose a stable `code` and `message`; clients must
  not parse human-readable text to identify an error class.

## Evidence

- [gateway-protocol-contract.spec.ts](../../tests/gateway/gateway-protocol-contract.spec.ts)
- [gateway-server-smoke.spec.ts](../../tests/gateway/gateway-server-smoke.spec.ts)
- [gateway-lifecycle-regressions.spec.ts](../../tests/gateway/gateway-lifecycle-regressions.spec.ts)
- Local gates: `pnpm test:contract`, `pnpm test:artifact`, and `pnpm check`.

The current contract tests cover hello, authentication, turn event pairing,
busy/abort behavior, WebSocket close abort, and compiled artifact loading.
Illegal frame variants, every RPC error branch, and all replay truncation
boundaries remain P2 coverage work. They must not be described as covered until
the corresponding tests exist.
