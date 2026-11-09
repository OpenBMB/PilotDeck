# Configuration and paths

Resolves PilotDeck paths and loads, validates and updates application configuration.

Entry points: [paths.ts](paths.ts), [loadPilotConfig.ts](config/loadPilotConfig.ts), [PilotConfigStore.ts](config/PilotConfigStore.ts).

Preserve unknown configuration fields, masked secrets and concurrent-write checks. General workspace registration must protect existing files and directory identity.

Tests: [tests/pilot](../../tests/pilot). See the [test guide](../../docs/testing.md) for runner selection.
