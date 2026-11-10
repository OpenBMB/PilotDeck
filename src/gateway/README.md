# Gateway

Coordinates sessions, turn submission, permissions and project operations through one interface shared by in-process and remote clients.

Entry points: [Gateway.ts](Gateway.ts), [InProcessGateway.ts](client/InProcessGateway.ts), [GatewayWsClient.ts](client/GatewayWsClient.ts).

Keep RPC compatibility, accepted-input identity and process ownership intact when changing execution paths.

`submitTurn(input, { signal })` gives each caller cancellation ownership of its own submission. The optional signal stays local; remote clients translate it into cancellation of that connection's stream request. A rejected duplicate never owns the active turn, even when callers reuse a public `runId`. `abortTurn({ sessionKey, runId })` ignores stale run IDs. Cancellation during configuration, session, attachment or model preparation prevents agent execution.

Execution retains the session reservation until its pump drains. Returning the event iterator cancels that execution; pausing a reader does not keep a completed turn busy. A hard timeout covers preparation and quarantines its session, including late factory results, before allowing reuse. Cleanup uses execution identity so an older stream cannot clear a later turn's replay, permission or elicitation state. Socket close observers run once for both graceful and abrupt closure, and structured error responses terminate remote streams. See the [submission API](../../docs/dialog-improvement-api.md#permissions-and-submission).

`python_runtime_status` reports the executing host's verified Python capability through both local and remote Gateways. `runtime.python.enabled` defaults to true. Python preference changes retire project runtimes without closing their sessions, MCP connections or tasks; disposal follows the final session/turn lease and background-task completion. New turns recreate dirty sessions against the new preference, including changes received during session initialization. The Web UI never probes its browser host for this status.

Settings requests `python_runtime_status` with `{ initialize: false }` to read metadata or the last verified result without creating a virtual environment or importing libraries. An installed but unused runtime is `available`; an active preparation is `initializing`. Omitting the option retains the full-check contract for manual checks and older clients. `git_runtime_status` reports the executing host's Git source, version and executable; its version probe has a five-second deadline. These status results contain no environment values or repository contents.

Config and extension reloads use the same retirement boundary. A project-scoped reload leaves other projects untouched; active turns retain their runtime until their session, turn and background-task leases finish. Per-session MCP connections close on session eviction, while shared connections close after the retired project runtime loses its owners. Gateway shutdown has a separate force-cleanup path.

Tests: [tests/gateway](../../tests/gateway). See the [test guide](../../docs/testing.md) for runner selection.
