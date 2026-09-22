# Background subagents

The `agent` tool accepts an optional `run_in_background: true` flag. Omission or
`false` keeps the existing synchronous behavior. For example:

```json
{
  "description": "Inspect the test coverage",
  "prompt": "Read the tests and summarize missing coverage. Do not edit files.",
  "subagent_type": "explore",
  "run_in_background": true
}
```

The call returns immediately with a `taskId` equal to the child's `subagentId`.
The parent can work on independent steps while the child runs. Existing
`task_list`, `task_output`, `task_wait`, and `task_stop` tools can inspect or stop
that task. Agent tasks are visible only to their owning session; existing bash
task behavior is unchanged. Output becomes available when the child settles;
this does not stream partial child text through `task_output`.

When a child finishes, its result is persisted and delivered once to the parent
as a labelled, synthetic `background_subagent_result` message. Reports and error
text share a 16,000-character limit; `task_output` exposes the retained output
subject to its normal output-store limits. The result is explicitly marked as
untrusted tool output. Runtime record pruning does not discard an undelivered
parent result.

Before a normal final answer, the parent joins any outstanding children and
gets another model call to incorporate their results. This still respects the
parent's `maxTurns` limit: exhausting the limit reports an error and cancels
pending children. Failed or explicitly stopped children deliver a failed or
cancelled result, allowing the parent to explain or recover.

Background work belongs to the active parent request. Stopping, abandoning, or
failing that request cancels its remaining children. Cancellation events are
flushed before the parent turn ends, and late child events are suppressed.
Cancellation uses an abort signal and a five-second grace period; code that
ignores the signal is marked cancelled, but arbitrary JavaScript cannot be
forcibly terminated. There is no detached daemon, restart recovery, or automatic
wake-up of later conversations.

The existing `agent.subagents.timeoutMs` setting applies to each child (default
one hour). Depth and tool permissions follow the existing synchronous fork
rules. This change adds no new settings screen. The shared runtime defaults to
at most eight running agent tasks, with old terminal records pruned when new
work is registered (retention target: 32), independently of the bash task cap.

Hosts that do not provide `startBackground` receive an explicit unsupported-tool
error rather than silently running the child synchronously. This feature does
not add session continuation; that is a separate change.
