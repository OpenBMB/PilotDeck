# Incremental workspace checkpoints (#687)

This document records **stage one** and its historical measurements. Stage two
changes turn startup scheduling; see [parallel workspace preparation](parallel-workspace-preparation.md).

Workspace scans reuse unchanged protected file versions and previously verified
backup objects within a `CheckpointStore` process. Turn startup ordering, leases,
manifests, retention limits and restore/undo formats are unchanged.

## Correctness policy

- Reuse is a process-local hint, never loaded from an old manifest after restart.
  The source cache contains only files from the most recent successful traversal;
  deleted, excluded, unreadable and over-budget entries are not carried forward.
- Every hit revalidates the workspace root and parent directory safety, then
  compares device, inode, mode, link count, owner/group, size, nanosecond mtime,
  ctime and birthtime. The source metadata must also remain identical after the
  backup-object check. Cached versions still count toward the existing byte budget.
- Files without a usable identity, with coarse (millisecond-aligned) ctime, or
  with timestamps in the current millisecond/future use the full-content path.
  This avoids trusting size/mtime alone or a file that could still be edited in
  the same timestamp tick. This policy assumes ordinary filesystem change-time
  semantics; it is not a cryptographic proof against forged metadata or silent
  hardware corruption. Filesystems that cannot provide reliable change metadata
  must use the conservative fallback.
- An object is reusable only after this store has read and verified its SHA-256
  and its exact metadata remains unchanged. Newly created objects are verified
  on their first reuse. A missing object triggers a fresh source backup; changed
  objects are read/hashed again, with corrupt contents rejected. Pruning removes
  verification hints for deleted objects.
- Public `captureFile` always reads the source. File-tool preimages, restore
  preview/conflict checks and restore revalidation therefore retain content-based
  checks. Public `readObject` always reads and verifies backup bytes, including
  before any restore writes. No protected write starts earlier than before.
- Modified files use the existing capture/open/identity/retry/atomic-write path.
  Undo, external edit conflicts, symlinks, permission changes, failed commands,
  child agents and cross-turn background tasks retain their existing handling.

## Tests

`npm run build && npm run test:checkpoints` includes incremental-cache tests plus
the existing restore/undo, shell/Python, subagent, background task, overlapping
workspace, interrupted-turn, transcript replacement and artifact regressions.
New cases also cover same-size edits with restored mtime, replaced file/object
identities, corrupt or deleted backup objects, coarse/missing metadata, timestamp
ticks, process restart, manifest mutation and warm-cache byte-budget accounting.

## Reproducible benchmark

Use Node 22 and leave the target workspace unchanged throughout each comparison:

```sh
node --import tsx scripts/benchmark-workspace-checkpoints.ts \
  --workspace /absolute/path/to/project --runs 7 --output /tmp/checkpoints-after.json
```

The script creates a temporary backup home outside the workspace, measures the
initial backup separately from unchanged turns, finishes every turn, and removes
its temporary backups. It reports startup checkpoint, artifact baseline and
finish-checkpoint time, eligible/protected files, content bytes, and source/object
read counters. Counters describe checkpoint content reads, not filesystem metadata
operations or the artifact collector's reads. No model/network request is made.
Initial means an empty backup store, not a flushed OS filesystem cache.

For a baseline comparison, check out the original commit in a temporary worktree,
make its dependencies available, and run the same script against the **same target
directory**, changing only the implementation:

```sh
node --import tsx scripts/benchmark-workspace-checkpoints.ts \
  --workspace /absolute/path/to/project --runs 7 \
  --implementation /tmp/baseline/src/session/checkpoints/WorkspaceCheckpoints.ts \
  --output /tmp/checkpoints-before.json
```

These are component measurements, not end-to-end first-token latency or model
generation throughput. Incremental reuse primarily benefits unchanged scans;
initial backups still require complete reads and durable object writes.

## Measured results (2026-10-27)

Apple M5, 32 GiB RAM, macOS 26.6, Node 22.23.4, arm64. The baseline was commit
`5862db796e7619f37b559a46417a6c7f9415bbeb`. The same script and unchanged target
directory were used for both implementations, running sequentially without other
test/build work. Each implementation used a separate empty temporary backup home:
one initial-backup sample, then six unchanged samples. Tables use the median of
those six samples. The operating-system cache was not flushed. All turns reported
zero changes. [Full samples and read counters](benchmarks/checkpoints-687-macos.json)
also record the candidate source checksum.

| Target | Eligible entries | Protected files | Protected bytes |
| --- | ---: | ---: | ---: |
| PilotDeck working tree | 2,129 | 2,128 | 22,196,668 |
| Synthetic large workspace | 5,352 | 5,352 | 268,440,264 |

The synthetic directory contains 54 groups of up to 100 files, each 50,157 bytes.
File `index` is filled with byte `97 + index % 26`, with its prefix overwritten by
`checkpoint benchmark ${index}\n`. Every file has distinct contents. Its size is
near the existing workspace limit; the existing policy checks the budget before
the next file and can include one final file across the threshold. That behavior
is preserved. This fixture approximates the issue's content volume, not its
Windows filesystem or complete directory layout.

| Target / measured phase | Before | After | Time reduction |
| --- | ---: | ---: | ---: |
| PilotDeck: startup checkpoint | 460.5 ms | 227.2 ms | 50.7% |
| PilotDeck: checkpoint + artifact startup | 501.8 ms | 270.3 ms | 46.1% |
| PilotDeck: finish checkpoint | 463.9 ms | 236.9 ms | 48.9% |
| Large: startup checkpoint | 1,125.9 ms | 354.4 ms | 68.5% |
| Large: checkpoint + artifact startup | 1,171.2 ms | 398.0 ms | 66.0% |
| Large: finish checkpoint | 1,146.5 ms | 385.6 ms | 66.4% |

Warm startup checkpoint reads dropped from 2,128 source files plus their backup
contents to **zero source content reads and zero protected-file backup content
reads** in PilotDeck; the large case likewise dropped from 5,352 plus their backups
to zero. The first unchanged sample still verified the separate two-byte `[]`
conversation-context object once; the remaining samples read zero object bytes.
Directory traversal, path checks and metadata I/O remain. Artifact startup was
unchanged: medians varied from 41.7 to 44.8 ms for PilotDeck and 45.3 to 43.7 ms for
the large case. No artifact speedup is claimed.

Initial-backup checkpoint + artifact startup took 13.04 s before / 11.99 s after
for PilotDeck, and 31.78 s before / 33.22 s after for the large fixture. These are
single samples with full reads and durable writes, not evidence of an initial
backup speedup. The large initial sample was 4.5% slower. Incremental bookkeeping
adds metadata work on cache misses, and OS/filesystem variation also affects
these samples. Windows and end-to-end model latency have not been benchmarked.

At the stage-one measurement point, `npm run build`, TypeScript compilation and
`npm run test:checkpoints` passed: **95 tests, zero failures and zero skips**, including
17 incremental-capture tests. The [stage-two report](parallel-workspace-preparation.md)
records the expanded suite and final review of both stages.
