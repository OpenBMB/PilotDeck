# Background task contract

Scope: [BackgroundTaskRuntime](../../src/task/runtime/BackgroundTaskRuntime.ts), [TaskOutputStore](../../src/task/storage/TaskOutputStore.ts) and [task types](../../src/task/protocol/types.ts). This is the local background-process boundary, separate from foreground AgentLoop calls and Gateway turns.

- start creates a unique task ID, records session/agent ownership and immediately returns queryable state.
- list/get/output/wait/stop return explicit empty/error outcomes for unknown tasks, never fabricated completion. Enforce concurrency limits and emit completion once per child exit.
- Output offsets advance monotonically. Ring-buffer eviction reports truncated. Disk-spill failure must not crash the runtime.
- Commands use the shared shell resolver: Bash then sh on Unix; Git Bash, cmd.exe, then PowerShell 7 on Windows. Windows PowerShell 5 is not a fallback. PILOTDECK_SHELL_PATH overrides selection; PILOTDECK_GIT_BASH_PATH locates nonstandard Git Bash installs.
- Normal state flow is created -> running -> completed|failed. Stop requests graceful termination, then escalates after the grace period and marks cancellation. Timeout and AbortSignal waits release listeners; repeated stop remains safe.
- The registry is in memory. Do not imply restart persistence or recovery that has not been implemented.

Tests: [runtime](../../tests/task/background-task-runtime.spec.ts), [process/output behavior](../../tests/task/runtime/BackgroundTaskRuntime.test.ts), [tool display](../../tests/tool/session-tools-display.spec.ts). Use controlled child streams and temporary spill directories; native-shell acceptance is separate from deterministic tests.

## Web preview handoff

`task_preview({ taskId, url, expectedText })` checks an already-running task in the
calling session and workspace. The page URL must match the port and compatible
loopback address family of an HTTP origin announced in that task's output
(`localhost`, `127.0.0.1`, `[::1]`, `0.0.0.0`, or `[::]`). `TaskOutputStore`
retains an immutable 16 KiB startup prefix alongside the 1 MB ring buffer so
long-running reused services keep their startup banner after log turnover. For
the owning session and workspace, a truncated `task_output` read from offset 0
can return `startupPreviewOrigins` from that prefix. Incremental output and its
byte offsets are independent of the retained origins.
Pass the exact page path and a project-specific marker from its raw initial HTML
(such as `<title>` in `index.html` for client-rendered SPAs), matched verbatim
including case and whitespace; missing-marker errors surface the initial
`<title>` when present. The check requires HTTP 200, `text/html`, and
the marker within 512 KiB. A single five-second deadline covers both IPv4/IPv6
attempts and callers can cancel. The tool accepts HTTP loopback URLs with an
explicit nonzero, non-default port and rejects credentials, fragments, redirects
and compressed responses. Requests always connect directly to the loopback IP.
For `localhost` input, the probe uses a compatible literal `127.0.0.1` or
`[::1]` URL with that URL's `Host` header and returns the literal URL that passed.

The successful result supplies a clickable URL, check time, HTTP/content evidence
and the task identity for `task_stop`. Use the returned URL for browser acceptance
and the final handoff. The caller performs browser acceptance when available and
reports its limits. The task association uses retained output as evidence for the origin.
Socket ownership is outside the scope of the check.
The URL belongs to the executing Gateway; remote/Docker clients need their own
forwarding. No client URL is guessed, service is stopped, or persistent deployment
is created. Leave requested previews running until the user stops them or the
owning runtime shuts down. Historical checks are point-in-time evidence only.

Ask and Plan may inspect an existing owned preview, but must not start services.
Implementation handoff guidance is omitted in those modes. Preview calls/results
receive the same compaction protection as the other task tools.
