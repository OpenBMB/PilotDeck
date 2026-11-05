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
- Thinking positions optionally carry `startedAt` (first received reasoning delta)
  and a frozen `durationMs` when the block ends. A text/tool boundary, stream end,
  error or retry stops that block's clock; later tool execution is excluded. These
  presentation fields survive final snapshots and JSONL history. Older transcripts
  have no measured reasoning duration.
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
without an additional typewriter. Reasoning opens automatically while streaming and collapses smoothly when its
phase ends. Manual toggles survive token updates. Continuous reasoning and tool
calls share a stable process seat between visible assistant replies; the next
reply closes that seat. On successful turn completion, one measured process
header folds all intermediate prose, reasoning, tool calls and answered questions
in their original order. Only the final assistant reply and delivered media stay
visible. Reopening restores the same seats and their disclosure state without
reparenting content or replaying its text animation.
Interrupted work and pending interactive prompts remain accessible. Disclosures
retain mounted content after opening, use inert hidden subtrees, and respect
reduced motion. Conversation scrollbars reserve their gutter, and disclosure
columns constrain intrinsic content widths so expansion never shifts the transcript
horizontally. All process and tool disclosures animate in both directions.
The localized status shows elapsed seconds while live and the measured
duration after completion. Legacy history without timing shows a completed label
without a guessed duration. Reasoning and tool summaries share row metrics and
theme-aware colors; expanded reasoning retains its reading position. New live
replies drain gradually even when text and completion arrive in one render;
historical text displays immediately. Answered question panels retain their seat
for a short height transition without delaying the submitted answer.
Question tools use full-width compact transcripts with a separate disclosure
header. Multi-select answers remain arrays through elicitation, live transport,
canonical history and UI projection, preserving labels that contain commas.
The history reader retains structured question results instead of reconstructing
answers from tool-result text. Todo updates use one progress header and checklist;
successful acknowledgements do not create a second details row.

An active process group does not by itself represent ongoing tool execution.
Root and child views show a localized model-call spinner after tools or reasoning
finish, until the model produces new output. Actual tool execution, visible live
reasoning or reply text, file preparation and pending user interactions take
precedence over this fallback. Completion removes it; reduced motion retains the
status text with a static icon.

File mutation preparation is an ephemeral Gateway activity, separate from the
ordered tool-call transcript. The Gateway observes argument generation before
dispatch, publishes only a validated complete path and received argument byte
count, and throttles updates. It retains a bounded prefix rather than file
contents. Active snapshots coalesce each draft to one update; dispatch, retry,
failure, cancellation and turn completion retire drafts. Preparing arguments
never implies that a tool ran or a file was written. Root and child views show
the same localized feedback, without a fabricated percentage or a file-open
action before dispatch.

Large file previews render a bounded batch of lines, shorten exceptionally long
lines, and reveal additional batches on request. Large edits use an explicitly
labeled content preview instead of allocating a quadratic line-diff matrix.
Copy retains the complete underlying content, including text outside the preview.

File results are a turn footer rather than part of an assistant prose message.
They stay hidden while the turn runs and appear after all prose, tools and other
process events when execution stops, including interrupted turns without a final
reply. Artifact ownership used by Markdown references is unchanged. The footer
stays outside process disclosures, so reopening work never moves or hides it;
checkpoint review and restoration remain available there.

The left conversation navigation rail uses fixed-pitch turn marks with bounded plain
text previews of user prompts and assistant replies. It excludes reasoning and
tool output, follows the visible turn, supports keyboard navigation and virtual
rows, and pauses automatic following on explicit jumps. Earlier known turns load
history before landing. The rail is hidden when the conversation pane is narrow;
its own long list scrolls independently of the transcript.

## Verification

- `tests/model/streaming/timeline.spec.ts`: assembler → agent coordinates → Gateway
  projection → transcript identity; long replay and isolated child lifecycle.
- `tests/gateway/active-turn-snapshot.spec.ts`: history/active epoch race.
- `ui/src/stores/sessionTimeline.test.ts`: repeated text, duplicated/reordered
  packets, missing predecessor, stale snapshots, delayed completion, child
  identity, and 150 deterministic randomized replay schedules.
- `ui/src/stores/useSessionStore.timeline.test.tsx`: real store history/live race
  and edited-turn tombstones.
- `ui/src/components/chat-v2/ThinkingBlock.test.tsx`: localized clocks, completion,
  manual expansion and legacy-history fallback.
- `ui/src/components/chat-v2/ConversationI18n.test.tsx`: in-place language changes
  for process durations, question/Todo controls, tool fallbacks and image accessibility labels.
- `ui/e2e/conversation-turn-nav.spec.mjs`: left-side positioning, previews, keyboard
  navigation, distant virtual rows, reader ownership and responsive hiding.
- `ui/e2e/process-transitions.spec.mjs`: bidirectional height transitions, stable
  widths, ordered turn folding, compact question/Todo tools, multi-select history
  replay, question exits, batched final replies, file footer placement and reduced motion.
- `tests/web/question-answer-history.spec.ts`: real elicitation output through
  canonical transcript and live Web projections, including comma-bearing labels.
- `tests/gateway/file-input-progress.spec.ts`: pre-dispatch feedback, bounded
  metadata, throttling, coalesced snapshots, retry and child isolation.
- `ui/e2e/reasoning-status.spec.mjs`: real row alignment across light palettes and
  dark mode, keyboard expansion, narrow layouts and reduced motion. Run with
  `pnpm --dir ui exec playwright test -c e2e/streaming-scroll.config.mjs` after
  installing Playwright Chromium; the suite also checks reading-position retention.

## Limits of this first version

This is not a durable per-token event journal. A gateway crash can lose an
unpersisted draft; completed JSONL blocks remain authoritative. Legacy stored
messages cannot gain lost alternation order retroactively. Existing UI grouping,
permissions, artifacts and activity summaries retain their separate presentation
logic. Rendering bugs outside this synchronization contract still require their
own tests.
