# Parallel workspace preparation

After accepted input is durable, one preparation task runs beside the model
request. The task records the turn checkpoint and collects the file-artifact
baseline. Tools, matching hooks, and terminal bookkeeping wait until that
protection is ready. Model text can be emitted while preparation is still
running.

```text
input accepted --+-- beginTurn -> file-artifact baseline -> protection ready
                 +-- context / model request -> first text -> tools wait -> execute
```

## Readiness

Each turn has one preparation task. `beginTurn` persists that turn's checkpoint
record, then the file-artifact baseline is collected. Protection is ready when
both have finished.

The model request starts immediately when no `UserPromptSubmit`,
`InstructionsLoaded`, or `PreModelRequest` hook matches. A matching hook waits
for protection before it runs. The match check does not execute the hook. A
lifecycle implementation that cannot report matches waits as well.

`SessionStart` and `Setup` run in `AgentSession` before the turn runner accepts
input.

`ToolRuntime` waits before hook dispatch, argument validation, and the tool
body. Read-only tools wait as well, because their hooks can run arbitrary
commands. Shell, Python, file edits, subagents, background tasks, and plugins
use this entry. Nested tool calls keep the same wait, and a subagent inherits
it.

Context compaction uses its own hook entry. When `PreCompact` or `PostCompact`
is configured, the turn waits before any context operation, including a turn
that does not compact. A lifecycle that cannot report those hooks waits too.

`Stop` and the other post-request hooks wait when they match. When context
capture is installed, it waits before it writes. Terminal success,
file-artifact output, and checkpoint finalization wait for preparation.

Operations on the same or overlapping directories stay serialized. The model
may run while a tool is waiting for its own protection.

These rules are exercised by `tests/session/workspace-preparation.spec.ts`.

## Failure and cancellation

If preparation fails, the turn aborts the in-flight model request and rejects
the turn abort signal. Later tool calls stop with that failure. The turn
records the error and completes as a failure. Text already sent stays in the
stream, and the failure is reported when the stream ends. `beginTurn` releases
its turn registration when it fails. Checkpoint finalization releases that
registration after a failed turn.

Cancelling the turn or closing the stream aborts preparation, closes the model
iterator, and waits for cleanup. The file-artifact scan observes the abort
signal during the directory walk. Finalization joins the preparation task, then releases
the turn registration, so a late `beginTurn` cannot keep it.

The baseline is a directory walk. The model may read the workspace while that
walk is still running. External edits are resolved from the collected version,
together with the existing pre-write checks and restore conflict checks.

## Benchmark

`scripts/benchmark-turn-startup.ts` runs the production turn, tool, hook, and
file-protection path against a local model. The model waits for a fixed delay
and makes no provider request. Times are measured from `input_accepted`.

```sh
node --import tsx scripts/benchmark-turn-startup.ts \
  --workspace /absolute/path/to/project \
  --runs 7 \
  --output /tmp/startup.json
```

`--runs` is an integer of at least 3 and defaults to 7. `--model-delay-ms`
defaults to 50 and must be zero or greater. `--implementation-root` selects
the source tree and defaults to this repository. `--pre-request-hook` installs
a matching `UserPromptSubmit` hook, so the model request waits for protection.

The first run records the initial backup. Later runs use the unchanged
workspace. The script prints each sample and the median of the unchanged runs:
first router execution, first text, protection ready, first tool execution, and
turn completion. It fails when a tool runs before protection is ready, or when
the workspace changes. Repeat a changed run against an unchanged tree.
`--output` writes the samples and that median as JSON. The median is also
printed when `--output` is omitted.
