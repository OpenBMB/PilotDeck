# Subagent task continuation (`task_id`)

The `agent` tool supports continuing a **completed child agent** in place via an
optional `task_id` input, in both the normal and the ask-mode tool schema.

## Contract

- **Supported forks return a task id.** With native transcript persistence,
  each full-fork `agent` result carries
  `task_id` (model-visible text line plus the JSON output field `taskId`). The
  id is the child's stable subagent UUID and is reused for continuation.
- **Continuation restores context.** When `task_id` is supplied, the runtime
  restores the child's prior durable user/assistant/tool history from its
  sidechain transcript and appends **only** the new `prompt` as the next
  directive. The child keeps its identity: same UUID, same subagent definition,
  same provider/model that the child actually used (preserved across parent
  session reloads — a changed `agent.subagents.default` or parent model does
  **not** silently switch the child's model).
- **`subagent_type` on continuation.** Omit it to reuse the task's saved
  identity. Passing a type that conflicts with the saved definition fails with
  `subagent_task_type_conflict`.
- **Current permissions always win.** Permission mode, run mode (ask/plan), and
  tool restrictions come from the calling parent at continuation time. Saved
  metadata deliberately contains no permission state, so nothing can relax the
  child's tool permissions. A read-only parent forces a read-only child run even when the
  saved definition is write-capable.

## Failure modes (no provider calls are made)

| Situation | Error code |
|---|---|
| Unknown id, or the task was created by a different parent session | `subagent_task_unknown` |
| Another continuation of the same task is already running | `subagent_task_busy` |
| Requested type conflicts with the saved definition | `subagent_task_type_conflict` |
| Legacy, corrupt or incomplete sidechain history | `subagent_task_history_unsupported` |
| Saved metadata lacks provider/model, or the saved model is no longer configured | `subagent_task_model_missing` |
| Last recorded round ended in error/abort/max-turns | `subagent_task_round_failed` |
| Runtime without continuation support (including older custom fork hosts) | `subagent_task_unsupported` |

Failed or incomplete rounds cannot be resumed. The caller can start a new
agent task with an explicit briefing. The failed round remains available for
inspection in its original sidechain.

## Storage format (formatVersion 2)

Each child's sidechain lives at
`<chats>/<parent-session>/subagents/<subagentId>.jsonl` — the path is always
derived from the **calling parent session's** storage directory, never from
tool input. Replayable sidechains contain, per round:

1. one `accepted_input` entry (the round's directive only — never a full
   history copy),
2. the round's durable messages (`assistant_message` / `tool_result_message`),
3. any `control_boundary` compaction entries followed by their replacement
   messages (replay slices history after the boundary), and
4. a `turn_result` entry closing the round.

A `session_metadata` entry (`subagentTask`) records the child identity,
provider, model, owning parent session, and sidechain session id. The sidechain
writer is re-seeded from the persisted sequence before a continuation appends,
so entry ordering stays monotonic.

## Supported boundaries

- Continuation only inside the **owning parent session** (parent session
  reloads are fine; forked/renamed parent session keys are not).
- Only transcripts written in formatVersion 2 (older sidechains are rejected,
  never guessed at).
- Continuation preserves the existing subagent depth and tool restrictions;
  it does not enable nested delegation.
- Hosts opt in through `PilotDeckSubagentForkApi.supportsContinuation`.
  Unsupported hosts omit resumable task ids and reject `task_id` instead of
  silently creating a new child.
