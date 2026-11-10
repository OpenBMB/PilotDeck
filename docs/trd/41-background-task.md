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
calling session and workspace. Use the exact page URL from `task_output` and a
project-specific marker from its initial HTML, matched exactly including case and
whitespace; avoid scaffold default titles. It requires HTTP 200, `text/html`, and
the marker within 512 KiB. A single five-second deadline covers both IPv4/IPv6
attempts and callers can cancel. Only explicit nonzero, non-default-port HTTP
loopback URLs are accepted; credentials, fragments, redirects and compressed
responses are rejected. Requests bypass ambient proxies, and localhost is pinned
to IPv4 loopback, retrying `[::1]` only if that connection is refused.
IPv6 services can also use `[::1]` explicitly.

The successful result supplies a clickable URL, check time, HTTP/content evidence
and the task identity for `task_stop`. It neither launches a browser nor executes
JavaScript. The caller must perform browser acceptance when available and report
its limits. The task association validates lifecycle/ownership, not OS socket
ownership: a distinctive HTML marker helps catch a wrong port or application.
The URL belongs to the executing Gateway; remote/Docker clients need their own
forwarding. No client URL is guessed, service is stopped, or persistent deployment
is created. Leave requested previews running until the user stops them or the
owning runtime shuts down. Historical checks are point-in-time evidence only.

Ask and Plan may inspect an existing owned preview, but must not start services.
Implementation handoff guidance is omitted in those modes. Preview calls/results
receive the same compaction protection as the other task tools.
