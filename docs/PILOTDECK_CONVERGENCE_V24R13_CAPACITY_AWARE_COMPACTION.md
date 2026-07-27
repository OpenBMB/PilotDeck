# PilotDeck Convergence V24R13: Capacity-Aware Compaction

## Decision

V24R13 fixes one domain-neutral full-compaction planning defect exposed by the
V24R12 Case 09 product gate. Exact post-compact retention is bounded by token
capacity instead of message and protected-frame counts alone. It does not
change Legal Coverage, domain validators, Progress Lease thresholds `8/2`,
Router, Memory, model, Skills, corpus, deadlines, tool execution, durable
receipts, or completion authority.

The failed run completed full summaries, but the planner restored a 35% tail
selected by message count and up to eight additional protected frames without
accounting for their aggregate size. A few large, valid tool-result frames
therefore survived verbatim and left the projected request blocking.

## Protocol

Full compaction computes one exact-retention budget from the estimated token
size of the current canonical messages and the existing `keepTailRatio`.

- Atomic frames remain the unit of selection, so tool calls and results are
  never split.
- The newest complete frame is retained even when it alone exceeds the target.
- Newest tail frames consume the budget first.
- Eligible protected prefix frames may use only the remaining budget.
- Protected frames that do not fit are included in the same summary input;
  they are not silently dropped.
- The boundary marker, summary, exact retained messages, attachments, hook
  results, and trailing-user normalization keep their existing order.

Protected context remains a preference for exact retention, not authority to
construct a request that still exceeds the model boundary. The existing
post-compact full-request evaluator remains the final fail-closed check.

## Boundaries

- No legal field, Case 09 identity, plugin name, or domain state is inspected.
- No blocking or warning threshold is relaxed.
- No additional model request, Lease grace, retry loop, or completion path is
  introduced.
- No tool result is truncated or deleted by this planner. Non-retained frames
  are visible to the summary model and represented by its handoff.
- Existing per-result persistence and references are unchanged.
- The count bound of eight protected prefix frames remains as a second ceiling;
  the token budget is an additional aggregate ceiling.
- A single newest atomic frame can still exceed the target. The post-compact
  evaluator must reject it if the complete request remains blocking.

## Counterexamples

Tests must prove that:

- uneven, large protected frames cannot bypass the aggregate retention budget;
- protected frames excluded from exact retention are present in the summary
  request;
- every summarized and retained tool call has its exact result pair;
- the newest atomic frame remains exact and in chronological order;
- ordinary small protected trajectories still retain useful recent frames;
- no-summarizable, warning-only, dynamic prompt, Progress Lease, and legal
  contracts retain their existing behavior; and
- a sanitized Case 09-shaped replay changes a rejected blocking projection
  into a non-blocking projection without changing the domain or Lease layers.

## Verification Gate

1. Record the uneven-frame counterexample failing on the V24R12 base.
2. Apply the smallest Core compaction-planning change and rerun focused context,
   Agent runtime, Progress Lease, O1, Gateway, and Legal Coverage controls.
3. Replay the sanitized preserved-session shape and prove token reduction plus
   pair integrity without copying source content or reasoning.
4. Run the complete repository suite and patch hygiene checks, then record
   reviewer-readable QA evidence.
5. Push a stacked draft PR on V24R12. Create a fresh immutable campaign and run
   Gate 0, paired smoke, Case 05, and full Case 09. V25 and the 85-case campaign
   remain blocked until Case 09 completes with a substantive report and
   completion proof.
