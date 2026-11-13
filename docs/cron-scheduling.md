# Scheduled tasks

Scheduled tasks are owned by `pilotdeck server`. Keep the server and computer
running for local work. The Web page, Agent tools and Gateway share `CronManager`
and its project runtimes; the old UI daemon helpers are not used.

## Configuration and permissions

Cron is enabled by default. Set `cron.enabled: false` to disable scheduling and
Agent scheduling tools. Defaults are timezone `UTC`, `maxConcurrentRuns: 1`
(across projects), and `runTimeoutMinutes: 60`. Configuration hot reload rebuilds
the runtime and interrupts active runs; their records remain available.

New tasks default to the existing restricted permission rules, not Full Access.
`mode: plan` allows read-only work; `bypassPermissions` is an explicit Full Access
choice. Execution sets `canPrompt: false`; requests for approval or input become
visible blocked results. A task's project identity and execution directory are
separate. General uses its configuration-home identity and managed workspace,
never the configuration directory as its working directory.

## Timing

Creation accepts `once` (an RFC 3339 instant with an offset), `delay` (positive
amount and second/minute/hour/day unit), `cron`, `interval`, and `monthly`.
Delays normalize to one-time instants. Intervals use an integer `everySeconds`
of at least 60 and a persisted `anchorAt`; late execution never moves the anchor.
Monthly weekday rules specify `ordinal` (1–4 or -1 for last), Sunday-based
`weekday` (0–6), `hour`, `minute`, and an IANA `timezone`.

Cron uses five numeric fields: minute, hour, day-of-month, month, day-of-week.
Sunday is 0 or 7. Wildcards, lists, ranges, and wildcard/range steps are supported.
Names, macros, seconds, malformed numeric tokens and single-value steps reject.
When neither day field starts with `*`, the day fields match with **OR**; when
either starts with `*` (including `*/n`), they match with **AND**. Thus
`0 9 1 * 1` means every Monday or the first day of a month. Use a typed monthly
weekday rule for the first Monday instead of `0 9 1-7 * 1`.

Each project waits for its nearest due task, with periodic clock rechecks. Busy
execution slots leave the original occurrence unchanged. Missed recurring
occurrences produce one execution and advance to the first future occurrence
when it finishes, rather than replaying every missed run. New one-time tasks
more than one minute overdue at server startup become `missed` for manual action.
The preview endpoint uses the same evaluator as execution.

The version-3 day matching migration preserves cached pending occurrences and
applies corrected OR semantics to existing tasks. It does not replay historical
occurrences missed under the older intersection rule.

## Task and execution lifecycle

Tasks retain `scheduled`, `running`, `paused`, `completed`, `failed`, or `missed`
status. `enabled` controls future triggers independently of the active run.
Pausing a running task lets that run finish; stopping cancels only that run.
One-time tasks remain after completion, failure or interruption. Resume requires
a future occurrence; manual retry works without changing the saved schedule.
Description-only edits preserve the committed occurrence. Edits require an
`expectedRevision`; concurrent changes reject with a conflict.

Execution modes:

- `independent`: a fresh `cron:<taskId>:<runId>` conversation for each run (default).
- `conversation`: wait for an existing target conversation to become idle, then
  continue with its history. The scheduler never closes the target conversation.
- `persistent`: reuse one dedicated task conversation (legacy default).

Independent Git tasks can select `workspaceMode: worktree`. Worktrees start at
committed HEAD, exclude dirty local work, and are retained for review. The
scheduler never stages or commits the user's checkout. Other tasks use the
selected working directory. A model override can be stored per task.

Manual execution creates a Run under the existing task ID and preserves its
schedule. Admission prevents overlapping executions of that task and enforces
the shared concurrency limit. Each run records the instruction snapshot,
trigger source, intended and actual times, execution conversation, output, file
artifacts, outcome and result delivery status.

Results always remain in the task history. `notificationPolicy` controls source
result delivery: `all`, `findings`, or `failures`. Independent tasks created in
Web chat can append a durable result notification to their source conversation;
conversation-mode output is already in the execution conversation. Delivery
failures remain separate from execution failures, retry three times, and can be
retried manually without executing the task again. Delivery across independent
stores/channels is at least once, not exactly once.

## Storage and interfaces

Tasks are in `<PILOT_HOME>/cron/projects/<projectId>/tasks.json`, with a `.cwd`
project marker. JSON writes use a serialized mutation queue and atomic replace.
Unreadable, unsupported or damaged stores reject writes and preserve their bytes.
Running records recover after restart; a committed terminal result is retained
rather than executed again. Run history uses JSONL with bounded retention (200
runs per task and 30 days, always retaining the latest); superseded updates of a
run are compacted. Pruning removes old event logs, never retained worktrees.

Agent tools are `cron_create`, `cron_list`, `cron_get`, `cron_update`,
`cron_run_now`, `cron_stop`, and `cron_delete`. Creation defaults to the current
project and captures the actual working directory. Lists default to the current
project; `scope: all` enables a host-wide query. Detail queries provide cursor
pagination. Source session and project identity are supplied by the host.

Web APIs keep `/api/always-on/cron-jobs` compatibility. Task detail is
`GET /api/always-on/cron-jobs/:taskId`; history pagination uses `beforeRunId`.
`POST /api/always-on/cron-preview` validates and previews without creating work.
The existing PATCH, run-now, stop and DELETE routes operate on the same tasks.
A run-now request with `retryDeliveryRunId` retries only result delivery.

Validate with `tests/cron`, `tests/gateway/cron-defaults.spec.ts`, Web route and
Cron panel tests. See [testing](testing.md) for runners and isolation requirements.
