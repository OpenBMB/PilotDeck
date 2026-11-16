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
choice. Scheduled/manual executions set `canPrompt: false`; requests for approval
or input become visible blocked results. User-initiated chat turns use ordinary
interactive permissions without changing the task's unattended permission mode.
A task's project identity and execution directory are
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

## Web workspace

The scheduled-task route replaces the shell's project/conversation tree with a
compact task list. The shell owns its width and compact-mode threshold, shared
with project and conversation navigation. Task rows use the same theme, selection,
heading and compact-entry primitives. Compact entries expose actions through
right-click or Shift+F10; list options retain search and filters in a portaled
popover. Its title-bar plus button opens the task editor. Selecting a
task with no messages shows a fixed waiting view with its next run time and the
shared composer. `CronTaskConversation` reuses `ChatInterface`, including its
attachments, input queue, mid-turn steering and existing message/store pipeline.
Chatting before or between executions does not create an execution record or
advance the schedule. The same conversation is retained for recurring runs.
Thinking, tools, file previews, history pagination and reading position use the
same implementation as ordinary chat. File previews resolve the task’s trusted
execution workspace through a task identity; General and isolated
worktree files do not require registering another ordinary project. There is no separate result/history page
or link into ordinary conversations. `/cron?taskId=<taskId>` opens a task directly.

MainArea retains the task workspace after its first visit. Task catalog changes
are pushed as `cron-task-changed` browser frames through the existing Gateway and
WebSocket connection. The first snapshot and reconnect recovery merge changes
received during the request and ignore older task revisions. There is no catalog,
result or active-status polling in task views. The selected task remains watched
when switching views; cached sessions are reused when revisited. Missing history,
older pages and reconnect recovery use the shared message endpoints.
Task history caches confirm the observed run identity and reconnect epoch. A
changed run repairs only that conversation on selection; unchanged task visits
reuse the confirmed cache. Ordinary task-chat completions, failures and stops
also invalidate their conversation through shared session-activity revisions;
they do not need a scheduled run record. Reconnect recovery resets those
connection-local revisions. Workspace changes recreate the cached execution
session at the next admitted turn while preserving its transcript and context.
Preparation failures use the shared persisted error-message contract even when
no model turn starts. Notification result policy is synthetic model context,
separate from the task input displayed and reconciled in history.

Task overviews and file authorization resolve the current workspace using the
same destination rule as execution. Chat-created files in a prepared worktree
are previewable before the first scheduled run, and a previous run's directory
does not override the current workspace. File reads never create worktrees and
retain source registration, owned-worktree and canonical-path checks.

Task and ordinary-chat event consumers have separate session scopes. Task frames
cannot consume ordinary session-status replies or trigger project-list refreshes.
Task transcripts are excluded from ordinary lists, counts and search, including
legacy per-run transcripts; direct task history reads remain supported.

Create/edit use a modal with task instructions, workspace, timing controls and
an IANA timezone selector. Names and reminder timing are generated asynchronously by a task-only
model classifier; naming failure retains the instruction-based fallback
and never delays execution. Description changes regenerate names, while explicit
Agent/API names remain supported. The editor offers standard recurrence controls
and preserves existing complex schedules without exposing expression inputs.
Permissions, model and task-workspace settings expand on demand. The shared
calendar/clock picker owns Escape before the editor. Rejected saves retain input, and closing the editor restores focus to its trigger.

## Task and execution lifecycle

Tasks retain `scheduled`, `running`, `paused`, `completed`, `failed`, or `missed`
status. `enabled` controls future triggers independently of the active run.
Pausing a running task lets that run finish; stopping cancels only that run.
One-time tasks remain after completion, failure or interruption. Resume requires
a future occurrence; manual retry works without changing the saved schedule.
Description-only edits preserve the committed occurrence. Edits require an
`expectedRevision`; concurrent changes reject with a conflict.

Every task owns one persistent conversation. New tasks use `cron:<taskId>`;
one-time executions, recurring occurrences and manual retries all use that same
session. Agent tools and the editor do not expose execution-mode/target-session
selection. Legacy input fields remain accepted for compatibility but cannot
adopt an ordinary conversation. Startup migrates old task modes to task ownership,
reusing the latest owned per-run transcript when available. Existing ordinary
conversation history and earlier per-run files are preserved. The shared history
reader projects retained owned per-run transcripts into the task flow without
copying them into the continuing model context.

The Gateway resolves task ownership and its trusted workspace for every task
turn; a browser-supplied directory cannot replace that workspace. Current task
instructions and identity are supplied as hidden reference context. Explicit
lasting guidance is merged into the saved instructions using `cron_get` and
`cron_update`; acknowledgement requires a successful update. Temporary guidance
remains in history. Task conversations use the normal project instructions,
memory retrieval/capture (when enabled), and context compaction mechanisms.
Saving task instructions does not confirm a project-memory write. Memory capture
and extraction follow the configured indexing interval; cross-session memory is
available after indexing succeeds. Agent acknowledgements must distinguish a
confirmed task update from memory awaiting extraction.
Web memory settings honor `memory.schedule` with the same precedence as Gateway
configuration, and editing those settings updates the effective nested values.

Git tasks can select `workspaceMode: worktree`. A task's worktree starts at
committed HEAD and is reused by subsequent runs, preserving task changes while
excluding the user's dirty checkout. The scheduler never stages or commits the
user's checkout. Other tasks use the selected working directory. A model override
can be stored per task.

Manual execution creates a Run under the existing task ID and preserves its
schedule. Admission prevents overlapping executions of that task and enforces
the shared concurrency limit. A user turn occupying the task conversation defers
a due occurrence without recording a failed run, including an admission race.
Queued replies resume after background execution releases Gateway admission;
applied steering messages are removed from the queue exactly once. Instruction
and title updates are allowed during execution and affect subsequent runs; the
active run retains its original instruction snapshot. Schedule, workspace, model
and permission edits still require the run to stop. Each run records the instruction snapshot,
trigger source, intended and actual times, execution conversation, output, file
artifacts, outcome and result delivery status.

Results remain in the task transcript and run records. No result is appended to
the source conversation or delivered to its messaging channel. The source chat
keeps only the creation acknowledgement/card. `notificationPolicy` controls task
unread attention (`all`, `findings`, `failures`); findings checks may return
`[NO_UPDATE]`. Legacy delivery-retry requests retain records without resubmitting
the model or sending source-chat messages.

## Persistent reminders

Task reminders are independent of ordinary conversation unread indicators and
notifications. `reminderTiming: due` records a reminder at the intended occurrence
before execution admission, including when a task conversation is busy. `result`
(the compatibility default) records completed or failed results, subject to
`notificationPolicy` and `[NO_UPDATE]` suppression. Stopped runs do not alert.
Successful due-mode runs do not create a second result reminder; failures remain
visible according to the notification policy. The naming classifier selects due delivery for simple user reminders and result
delivery for agent work; Agent creation and the editor can explicitly override it.

All clients use the existing system-notification transport and preferences.
There are no custom reminder windows or page cards. Web uses the Notifications
API/Service Worker with `requireInteraction`; Electron uses native notifications,
Windows reminder Toasts, and a non-expiring timeout where supported. macOS alert
style and Linux notification-server policy remain user/system controlled. Due
reminders show a short action message instead of the task's execution instructions.

Viewing a task does not acknowledge its reminder. The OS may hide a notification
when activated or after its own timeout; hiding is not business acknowledgement.
Only supported explicit user-dismissal events acknowledge the authenticated
user's reminder. Unknown close reasons, focus/read events and programmatic closes
do not. Ordinary chat notification, badge and read behavior are unchanged.

Initial connection, reconnect, permission/preference changes and focus recover
pending snapshots; there is no periodic reminder query. Per-client durable OS
delivery receipts prevent replay after refresh/restart, including notifications
already dismissed by the user. Failed or denied delivery stays retryable. Receipt
and pending-dismissal records are separate in the worker: closing the last page
does not lose a later OS dismissal. Pages replay its account-scoped outbox after
reconnect and remove entries only after the server confirms acknowledgement.
Receipt recovery is quiet and never reruns the model. Electron stores delivery and explicit-dismissal identities
and navigation metadata in its user-data directory. It reads macOS Notification
Center history once before live notification delivery, rebinds retained records,
and restores missing records only when the server still reports them pending.
The snapshot also closes system notifications already acknowledged elsewhere. Windows activation routes only recognized stored
reminder IDs. Browser worker receipts are independent of ordinary chat unread
state and survive worker replacement. Each occurrence has a stable unique ID;
later occurrences cannot replace earlier notifications from that task. System
retention and available close/activation callbacks determine platform limits.
Local scheduling still requires the runtime and computer to remain running.

## Storage and interfaces

Reminder records and per-user acknowledgements are in
`<PILOT_HOME>/cron/reminders.json`, written atomically with serialized mutations.
`GET /api/always-on/cron-reminders` returns the current user’s pending records;
`POST /api/always-on/cron-reminders/:id/dismiss` acknowledges only that user’s
record. Gateway equivalents are `cron_reminder_list` and `cron_reminder_dismiss`.

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
Creation revalidates the project's registration and directory using the same
resolver as conversation submission, before writing any task or Cron project
marker. Missing, unregistered, or removed projects reject with
`cron_project_unavailable`; the Web API returns HTTP 400 and the editor preserves
the draft. General retains its separate virtual identity and execution workspace.

Web APIs keep `/api/always-on/cron-jobs` compatibility. Task detail is
`GET /api/always-on/cron-jobs/:taskId`; history pagination uses `beforeRunId`.
`POST /api/always-on/cron-preview` validates and previews without creating work.
The existing PATCH, run-now, stop and DELETE routes operate on the same tasks.
The legacy `retryDeliveryRunId` field is accepted without executing or forwarding a result.

Validate with `tests/cron`, `tests/gateway/cron-defaults.spec.ts`, Web route and
Cron panel tests. See [testing](testing.md) for runners and isolation requirements.
