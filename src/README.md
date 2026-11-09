# Core runtime

TypeScript backend shared by the CLI, desktop client and Web server.
Start at [the CLI entry](cli/pilotdeck.ts) and [local Gateway composition](cli/createLocalGateway.ts).

| Subsystem | Responsibility |
| --- | --- |
| [Agent execution](agent/README.md) | Runs model/tool turns, continuation and recovery. |
| [Gateway](gateway/README.md) | Coordinates sessions, turn submission, permissions and project operations through one interface shared by in-process and remote clients.. |
| [Sessions and workspace changes](session/README.md) | Stores transcripts, restores history and manages workspace checkpoints and file artifacts.. |
| [Model context](context/README.md) | Assembles prompts, resolves attachments and memory, accounts for tokens and compacts history.. |
| [Model providers](model/README.md) | Owns the provider catalog, canonical model protocol, provider adapters, streaming and retry/error handling.. |
| [MCP integrations](mcp/README.md) | Loads MCP server configuration, manages client transports and exposes approved tools to the agent.. |
| [Tools](tool/README.md) | Registers and schedules built-in and contributed tools, applying permission decisions and audit boundaries.. |
| [Permissions](permission/README.md) | Evaluates allow/ask/deny rules and persists the shared permission preference.. |
| [Skills and plugins](extension/README.md) | Discovers skills and plugins and composes their commands, prompts, hooks, tools and MCP contributions.. |
| [Channels and transports](adapters/README.md) | Connects CLI/TUI, messaging channels and HTTP-facing adapters to the shared Gateway.. |
| [Configuration and paths](pilot/README.md) | Resolves PilotDeck paths and loads, validates and updates application configuration.. |
| [Model routing](router/README.md) | Chooses model routes and orchestrates provider health, fallback chains and configured routing policy.. |

Supporting modules: [always-on](always-on), [cron](cron), [diagnostics](diagnostics), [lifecycle](lifecycle), [network](network), [runtime](runtime), [status](status), [task](task), [telemetry](telemetry), [web](web). Small internal folders use this overview rather than duplicate READMEs.

Build with `pnpm run build` from the repository root. The local memory dependency is built by prebuild; its committed lib payload is still an installation input. See [contribution rules](../CONTRIBUTING.md) and [reference documentation](../docs/README.md).
