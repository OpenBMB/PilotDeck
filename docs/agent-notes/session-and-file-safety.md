# Session And File Safety Contracts

## Context

Session transcripts and workspace files are durable user state. Replay,
backup, restore, and path checks must fail closed and must not silently replace
valid content with an empty or unrelated file.

## Invariants

- Transcript replay tolerates only explicitly supported legacy, truncated, or
  compacted forms and preserves event pairing and ordering.
- File history snapshots are idempotent for the same source state; failed file
  creation or restore rolls back without deleting the last valid snapshot.
- Workspace and attachment paths remain inside the intended directory after
  normalization, including traversal, prefix, symlink, and Windows drive
  cases.
- Editor load failures never authorize saving an empty replacement over the
  existing file.

## Evidence and status

- [session tests](../../tests/session)
- [file and config regressions](../../tests/regressions/config-state-file-regressions.spec.ts)
- [workspace/path tests](../../tests/tool/tool-result-workspace-path.spec.ts)
- [UI editor regressions](../../ui/src/components/code-editor)

The historical audit maps the surviving FILES and SESSION contracts to these
tests. Coverage thresholds and additional damaged-transcript/concurrent-file
cases are P4 work; platform-specific filesystem behavior remains deferred to
the relevant runner.
