# Background task contract

Scope: [BackgroundTaskRuntime](../../src/task/runtime/BackgroundTaskRuntime.ts), [TaskOutputStore](../../src/task/storage/TaskOutputStore.ts) and [task types](../../src/task/protocol/types.ts). This is the local background-process boundary, separate from foreground AgentLoop calls and Gateway turns.

- start creates a unique task ID, records session/agent ownership and immediately returns queryable state.
- list/get/output/wait/stop return explicit empty/error outcomes for unknown tasks, never fabricated completion. Enforce concurrency limits and emit completion once per child exit.
- Output offsets advance monotonically. Ring-buffer eviction reports truncated. Disk-spill failure must not crash the runtime.
- Commands use the shared shell resolver: Bash then sh on Unix; Git Bash, cmd.exe, then PowerShell 7 on Windows. Windows PowerShell 5 is not a fallback. PILOTDECK_SHELL_PATH overrides selection; PILOTDECK_GIT_BASH_PATH locates nonstandard Git Bash installs.
- Normal state flow is created -> running -> completed|failed. Stop requests graceful termination, then escalates after the grace period and marks cancellation. Timeout and AbortSignal waits release listeners; repeated stop remains safe.
- The registry is in memory. Do not imply restart persistence or recovery that has not been implemented.

Tests: [runtime](../../tests/task/background-task-runtime.spec.ts), [process/output behavior](../../tests/task/runtime/BackgroundTaskRuntime.test.ts), [tool display](../../tests/tool/session-tools-display.spec.ts). Use controlled child streams and temporary spill directories; native-shell acceptance is separate from deterministic tests.
