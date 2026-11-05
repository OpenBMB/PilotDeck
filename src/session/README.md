# Sessions and workspace changes

Stores transcripts, restores history and manages workspace checkpoints and file artifacts.

Entry points: [index.ts](index.ts), [WorkspaceCheckpoints.ts](checkpoints/WorkspaceCheckpoints.ts), [ProjectSessionStorage.ts](storage/ProjectSessionStorage.ts).

Checkpoint restoration must preview conflicts and preserve later edits. Internal checkpoints do not create user Git commits.

Tests: [tests/session](../../tests/session). See the [test guide](../../docs/testing.md) for runner selection.

Protocol: [session timeline](../../docs/architecture/session-timeline.md).
