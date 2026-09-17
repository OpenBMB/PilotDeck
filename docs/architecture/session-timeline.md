# Versioned session timeline (v1)

New agent turns use an explicit transcript protocol. Older JSONL records remain
readable through the legacy adapter; their original ordering cannot be recovered
if an older assembler already combined non-adjacent parts.

## Contract

`timeline = { version: 1, turnId, id, previousId?, order, revision, offset? }`

- `turnId` identifies the originating agent turn, including child-agent turns.
- `id` and `order` are allocated before the first update and survive persistence.
- `previousId` allows a client to notice a completely missing live block.
  Tool starts reserve ordering slots but join this chain only when AgentLoop
  publishes/retains the assistant message or emits the accepted tool calls.
  Receiving all arguments is not publication: an interrupted response may discard
  even its complete calls. Unpublished reservations are discarded before the next
  model request and never advertised as recoverable predecessors.
- `revision` increases within the turn. An older snapshot never replaces newer
  content. Final snapshots replace drafts by identity, not by comparing text.
- `offset` is the UTF-16 string offset of an incremental text payload. Absence
  means the payload is an absolute snapshot. A gap triggers baseline recovery;
  duplicate offsets are not appended twice.
- `streamBoundary = { turnId, through, revision }` closes only blocks through that
  position. A delayed end frame cannot close a later response attempt.

A text/thinking channel change creates a new contiguous block. Tool calls,
results, steered input and compaction have positions in the same turn. Provider
adapters continue to serialize only provider fields; timeline metadata is for
transcript synchronization, not model inference.

## Data flow

1. `AgentLoop` uses `TurnTimeline` to annotate both emitted events and durable
   messages. The model assembler preserves contiguous content order.
2. Gateway keeps `ActiveTimeline`, an absolute projection per active block,
   separate from the bounded legacy event log. A long answer does not lose its
   opening tokens when that log is truncated.
3. A history read includes the active baseline captured after the disk read. If
   the active-run epoch changed during that read, Gateway rereads history. This
   prevents a completed turn from falling between history and active replay.
4. `SessionTimeline` in the UI owns new-protocol content and lifecycle. It buffers
   gapped deltas, requests a baseline, ignores stale versions and tombstones
   edited-away turns. New content bypasses legacy text/position reconciliation.
5. Rendering derives order and active status from this state. React keys remain
   stable through settlement. Expansion and scrolling remain view state.

Terminal child state is retained by parent-run/child identity even before any
content arrives. Restored absolute snapshots remain readable but closed; late
deltas cannot restart them. Terminal transitions clear pending recovery work for
that execution, without clearing gaps in other active executions.

The store creates the timeline before processing any close event, including an
initial WebSocket replay. Live frames and HTTP baselines use the same child-cache
projection, which retains non-timeline messages such as model errors. Child model
errors receive an `errorId` at gateway creation, before live delivery and replay
storage diverge. The bridge reuses that identity on HTTP and WebSocket recovery;
separate failures remain distinct even when their messages are identical.

A complete history read reconciles previously confirmed entities: missing blocks
are removed, and missing user turns invalidate their cached content. Live-only
content is retained unless its confirmed user turn was removed. Partial history
pages only add/update content; absence from a page is not evidence of deletion.

There is deliberately no client reconstruction of a provider response from its
text. Legacy records/frames use the old adapter at the boundary. Runtime status
rows do not place new-protocol content. Thinking renders received content
without an additional typewriter, and its phase transition collapses before paint.

## Verification

- `tests/model/streaming/timeline.spec.ts`: assembler → agent coordinates → Gateway
  projection → transcript identity; long replay and isolated child lifecycle.
- `tests/gateway/active-turn-snapshot.spec.ts`: history/active epoch race.
- `ui/src/stores/sessionTimeline.test.ts`: repeated text, duplicated/reordered
  packets, missing predecessor, stale snapshots, delayed completion, child
  identity, and 150 deterministic randomized replay schedules.
- `ui/src/stores/useSessionStore.timeline.test.tsx`: real store history/live race
  and edited-turn tombstones.

## Limits of this first version

This is not a durable per-token event journal. A gateway crash can lose an
unpersisted draft; completed JSONL blocks remain authoritative. Legacy stored
messages cannot gain lost alternation order retroactively. Existing UI grouping,
permissions, artifacts and activity summaries retain their separate presentation
logic. Rendering bugs outside this synchronization contract still require their
own tests.
