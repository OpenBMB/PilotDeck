# MCP integrations

Loads MCP server configuration, manages client transports and exposes approved tools to the agent.

Entry points: [index.ts](index.ts), [McpClient.ts](client/McpClient.ts), [projectMcpSpec.ts](runtime/projectMcpSpec.ts).

Built-in computer use is controlled in Settings > External integrations > Computer Use. It uses the pinned Driver manifest, the backend host desktop and the current task permissions; do not add a duplicate manual MCP entry.

Tests: [tests/mcp](../../tests/mcp). See the [test guide](../../docs/testing.md) for runner selection.

Driver resources: [pinned manifest](../../scripts/computer-use/cua-driver.json). Lifecycle implementations: [desktop](../../apps/desktop/src/computerUse.ts) and [standalone Web](../../ui/server/services/standaloneComputerUse.js).
