# MCP integrations

Loads MCP server configuration, manages client transports and exposes approved tools to the agent.

Entry points: [index.ts](index.ts), [McpClient.ts](client/McpClient.ts), [projectMcpSpec.ts](runtime/projectMcpSpec.ts).

Tool catalogs refresh after `tools/list_changed`, reconnect or cache expiry. Discovery coalesces concurrent readers, follows pagination and retains the last complete server catalog on failure. Each session and child registry publishes schema, permission flags and scheduling flags together at its next request boundary; child allowlists and session exclusions remain in force. A queued call using an obsolete contract fails before dispatch and asks the model to retry with the refreshed schema. Already dispatched calls continue normally.

Per-session transports belong to the session resource lease. Disposal releases the captured instance even when initialization finishes late, without removing a newer same-key instance. Stopping a runtime prevents queued startup and discovery work from opening another connection.

Built-in computer use is controlled in Settings > External integrations > Computer Use. It uses the pinned Driver manifest, the backend host desktop and the current task permissions; do not add a duplicate manual MCP entry.

Enable the component, grant the required operating-system permissions, and recheck its status before a task. The model needs image input support. Multiple tasks share the logged-in desktop, so use one desktop-control task at a time. After a lost connection, observe the current state before repeating an action whose outcome is unknown.

On macOS, grant Accessibility and Screen Recording to the exact `PilotDeck Computer Use.app` path shown in settings. If the system omits it, add that path manually. Production and development signing identities can require separate grants. Windows elevated/security windows and Linux Wayland have platform restrictions.

The native controller owns each instance's Driver, private connection and lifecycle. Disabling the instance revokes its generated MCP configuration and stops owned processes. Generated connection files are host-managed, and project/plugin configuration cannot replace the reserved `pilotdeck-computer-use` service.

Standalone Windows/Linux startup checks the owned child before publishing tools, bounds each readiness probe to one second within its 15-second wait, and stops an unready child on failure. Disable and server shutdown cancel pending startup commands and polling before waiting for process cleanup. A missing or failed Driver never publishes an MCP connection; recheck starts a new owned generation.

Settings keeps Stop and disable available while enable/reconnect is pending. A completed stop supersedes older responses so a delayed enable result cannot restore a connected state in the page. The desktop host also cancels its native startup command and endpoint polling on disable or quit.

An HTTPS reverse proxy requires login (`PILOTDECK_DISABLE_LOCAL_AUTH=0`), the browser-facing `Host`, and an overwritten `X-Forwarded-Proto`. Configure non-loopback proxy IPs/CIDRs through `PILOTDECK_TRUST_PROXY`. Request-origin validation uses the trusted proxy policy and the actual host.

Tests: [tests/mcp](../../tests/mcp). See the [test guide](../../docs/testing.md) for runner selection.

Driver resources: [pinned manifest](../../scripts/computer-use/cua-driver.json). Lifecycle implementations: [desktop](../../apps/desktop/src/computerUse.ts) and [standalone Web](../../ui/server/services/standaloneComputerUse.js).
