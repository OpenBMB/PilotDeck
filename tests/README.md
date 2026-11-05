# Backend regression tests

Node test-runner coverage for core behavior, protocols, persistence and system boundaries. Fixtures are deterministic test data, not development outputs.

Run `pnpm test` for the built suite. For a focused TypeScript case, use `node --import tsx --test tests/path/to/case.spec.ts`. [TUI permissions](adapters/tui-permissions.spec.tsx) is an isolated regression suite and is also included in the compiled test run.

Use temporary PILOT_HOME/profile/database/workspace directories and clean up owned processes. Real provider requests must be explicit opt-in; synthetic tests must not inherit user credentials. Keep behavior assertions and do not remove security or data-retention coverage merely because a file has no production import.

Frontend/server tests use [Vitest in ui](../ui/README.md). Desktop helpers use Node tests under [apps/desktop/scripts](../apps/desktop/scripts). See [test selection](../docs/testing.md).
