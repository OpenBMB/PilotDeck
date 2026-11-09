# Sessions and workspace changes

Stores transcripts, restores history and manages workspace checkpoints and file artifacts.

Entry points: [index.ts](index.ts), [WorkspaceCheckpoints.ts](checkpoints/WorkspaceCheckpoints.ts), [ProjectSessionStorage.ts](storage/ProjectSessionStorage.ts).

Checkpoint restoration must preview conflicts and preserve later edits. Internal checkpoints do not create user Git commits.

Checkpoints work in ordinary directories and store deduplicated content, file existence, permissions and conversation boundaries. File-tool journals establish ownership. Shell, Python and background-command observations remain reviewable, while automatic restoration requires a continuous matching file-tool history. Excluded directories, oversized files and external side effects have limited recovery coverage.

Restore and undo both preview the current version and revalidate it before writing. Conflicting edits remain protected. Restoration journals support interrupted operations. File-only, conversation-only and combined recovery retain the original transcript and project a restored branch. Forks copy referenced attachments and rebind their ownership.

Project `.pilotdeck` files are hidden from user-file counts while recorded internal work files remain available for restoration. Git operations act on the actual repository and index, including other sessions' edits. Commits validate the reviewed index tree, and restore/Git operations coordinate with file operations through directory leases.

Tests: [tests/session](../../tests/session). See the [test guide](../../docs/testing.md) for runner selection.

Protocol: [session timeline](../../docs/architecture/session-timeline.md).
