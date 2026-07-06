# Agent Todo Workflow

This document defines the common PilotDeck agent workflow for using `todo_write` outside and inside Plan Mode. It is an implementation-facing specification for prompt, tool, and runtime behavior.

## Goals

- Make todo tracking a general agent state mechanism, not only a Plan Mode helper.
- Let agents revise todos mid-task when discovery changes the work.
- Preserve progress across long tasks through periodic updates and workspace artifacts.
- Require final verification before reporting completion.

## When To Use Todo

Agents should usually do a small amount of exploration before creating a detailed todo list. Use todo once the likely shape of the work is visible, especially when a task has any of these properties:

- Three or more meaningful steps.
- Multiple requested outcomes or deliverables.
- Multi-file or cross-module code changes.
- Long-running commands, batch work, or background tasks.
- Any task where verification is expected.
- Any task where intermediate findings must survive context compaction or handoff.

Short factual answers and single-step local edits do not require todo tracking unless the agent expects the work to grow. Do not let an early todo list lock the agent into a bad route: if evidence contradicts the current approach, cancel the stale item and add a revised one.

## Editable Todo Rules

`todo_write` is the session todo state tool. Agents may read and update it throughout execution.

- Use stable `id` values for structured todos so later updates can merge by id.
- Use `merge=true` when updating only part of the list or adding discovered work.
- Keep at most one item `in_progress` when possible.
- Mark completed items only after checking the relevant evidence.
- Mark obsolete or superseded work as `cancelled` with a reason instead of silently deleting it.
- Add newly discovered required work as a new todo rather than burying it in prose.
- Split oversized todos when they become too broad to verify cleanly.
- Preserve completed facts when restructuring the list, but do not keep obsolete active work alive merely because it was previously written down.

Legacy markdown checklist input remains supported for simple replace-style updates. Structured todo input is preferred for long-running work because it is easier to edit safely.

## Progress Updates

Agents should keep the user and future context synchronized.

- Update `todo_write` after meaningful implementation or investigation steps, not after every trivial command.
- Send a short progress message before and after high-latency work when the user may otherwise see no movement.
- When todo structure changes, explain the reason in the tool input `reason` or the next progress note.
- Before the final response, update `todo_write` so its state matches the final answer.

Final responses should include what was completed, what was verified, where artifacts were saved, and any remaining risk or incomplete work.

## Workspace Artifacts

Use the current session workspace path (`cwd`) as the root for intermediate files. Web or subsystem sessions may point `cwd` at an isolated worktree or snapshot workspace, so do not infer workspace paths from the global project root.

Recommended layout:

```text
.pilotdeck/work/<session-id>/
  findings.md
  todo_history.md
  verification.md
  artifacts/
```

If a stable session id is not available to the model, use a clear fallback such as `.pilotdeck/work/current/` and mention it in the final response.

Artifact guidelines:

- `findings.md`: durable discoveries, decisions, constraints, and facts needed later.
- `todo_history.md`: structural todo changes, especially added, cancelled, split, or reordered work.
- `verification.md`: commands, checks, outputs, and unresolved verification gaps.
- `artifacts/`: generated intermediate files that are useful for handoff or final delivery.

Do not persist secrets, large raw logs, binary caches, or files that are trivial to regenerate unless the user explicitly asks.

## Verification

Every completed deliverable should have a matching verification step when feasible.

Acceptable verification includes:

- Targeted tests.
- Build or type checks.
- Static checks.
- Smoke runs.
- Manual inspection with a clear explanation.
- A documented reason why verification was not possible.

The final todo state and final answer must agree: completed items were done and verified when feasible, pending items are called out, and cancelled items have a reason.

## Implementation Notes

- `todo_write` is registered as a built-in session tool and can be used outside Plan Mode.
- Plan Mode approved-plan gating still requires todo initialization before non-read-only tools.
- The current workspace is the tool/runtime `cwd`; this is the correct root for `.pilotdeck/work/...` artifacts.
- The preferred editable shape is structured todos with stable ids, `merge`, and `reason`; markdown checklist input is retained for compatibility.
