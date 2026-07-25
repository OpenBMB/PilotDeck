# Matrix Pending Evidence Handoff v1

Status: proposed v23 experiment derived from the fresh v22 Case 09 run.

## Problem

The current Legal Plugin has two different matrix paths:

- `matrix_pending` identifies one exact matrix but tells the Agent to read the
  complete `facts.json` before writing it;
- `material_fact_matrix_orphaned` injects a bounded fact batch, but is reachable
  only after all seven matrices have left `pending`.

In v22, source review completed with 24 reviewed sources and 107 facts. The
first matrix request read the complete facts ledger, grew context from roughly
140k to 150k tokens, then used the forced-boundary turn only to list fact IDs.
No matrix was written and the unchanged `8/2` Core lease correctly failed
closed. A read-only replay confirms that the `matrix_pending` envelope has no
`workItems` and explicitly requires the full-ledger read.

The defect is not the matrix validator, the lease, or missing legal knowledge.
It is the absence of a bounded evidence handoff between a known target matrix
and the Agent's legal classification decision.

## Decision

Add a finite, state-bound selection -> proposal -> apply protocol for the
initial construction of one pending matrix.

The Legal Plugin supplies evidence and enforces transaction boundaries. The
Agent remains responsible for deciding which facts belong in the matrix, how
they should be summarized, whether uncertainty prevents a conclusion, and
whether an exhaustively reviewed matrix is genuinely not applicable.

### 1. Bounded fact index

For the current `matrix_pending` target, inject the next deterministic page of
canonical fact index items. Each item contains only:

- fact ID;
- subject and predicate;
- date/period or the recorded missing-time reason;
- material and critical flags;
- verification and conflict status.

The index does not contain legal labels, a suggested matrix, expected answers,
or benchmark-specific entities. Page limits are 48 facts and 8 KiB, whichever
comes first. Canonical order is preserved.

The work item includes the current validator state hash, target matrix ID and
collection index, page offset, returned/remaining/has-more counts, an evidence
batch SHA-256, accumulated selected IDs, and a deterministic selection path.

### 2. Agent-owned selection checkpoint

The Agent writes one exact selection envelope for the current page:

```json
{
  "schemaVersion": 1,
  "phase": "matrices",
  "group": "matrix-pending-selection",
  "expectedStateHash": "<injected state hash>",
  "targetMatrixId": "<injected target>",
  "evidenceBatchSha256": "<injected batch SHA-256>",
  "selectedFactIds": ["<zero or more IDs from this page>"],
  "decision": "continue",
  "reason": "<brief legal selection rationale>"
}
```

`selectedFactIds` must be a unique subset of the injected page. Selections are
accumulated across pages, with a hard maximum of 12 facts. `continue` advances
to the next deterministic page. `finalize` stops scanning and prepares the
matrix proposal. A zero-selection `finalize` is valid only after the final page
has been reviewed and requires a specific not-applicable reason.

The checkpoint is operational state, not a canonical legal conclusion. Its
path and content are derived from the current validator state, target, offset,
and page SHA. A valid decision can advance only once. Rewriting invalid bytes
does not create new convergence progress; all invalid revisions share one
stable repair marker.

The Agent first writes the selection file. On the next request, the plugin
exposes `matrix-selection-apply` only after validating that file and replaces
the full evidence page with a compact receipt view. The command rechecks the
file SHA and prepared-slice size before making the receipt immutable. This
avoids racing a file write and apply command in one parallel tool batch while
still giving each protocol step observable, bounded progress.

### 3. Selected evidence rehydration

After a valid `finalize` decision with selected facts, the plugin rehydrates
only those canonical facts into a prepared slice. The slice contains the value,
time field, materiality, verification/conflict status, and locator-grounded
source references needed for legal classification. It is capped at 12 facts
and 8 KiB.

The Agent must not reread `facts.json`. Selection application computes the
accumulated prepared-slice size before making the receipt immutable, so an
over-limit selection is rejected while the current page can still be reduced.
If one index item itself exceeds 8 KiB, the work item exposes a deterministic
oversized pointer and fails closed. This version does not silently truncate or
permit that item to be skipped into a not-applicable conclusion; an explicit
future bounded path is required for such a record.

### 4. One-matrix proposal

The plugin injects one deterministic proposal path and exact template. The
proposal contains:

- the current validator state hash;
- target matrix ID;
- selection-chain SHA-256;
- prepared-slice SHA-256;
- one complete replacement record for the target matrix.

For `complete`, every proposal fact ID must come from the selected prepared
slice. For `not-applicable`, the selection chain must prove that every fact
index page was reviewed with zero accumulated selections and the reason must be
specific and non-placeholder. The proposal may not change another matrix,
facts, materiality, issues, authorities, or coverage.

The receipt validates the full envelope before exposing an apply command. An
invalid proposal is not partially applied and gets structured actionable
diagnostics without allowing byte-churn lease renewal.

### 5. SHA-bound atomic apply

The apply command rechecks:

- deterministic proposal path and lowercase proposal SHA-256;
- unchanged validator state hash;
- target matrix is still the same pending record at the same collection index;
- selection-chain and prepared-slice receipts;
- one-record and 24 KiB mutation limits;
- matrix status, entry schema, fact IDs, risk-signal vocabulary, and required
  not-applicable reason.

It atomically replaces exactly one matrix record, preserves every other record,
and immediately runs the unchanged validator. The result reports before/after
state hashes and error counts. A stale or changed proposal fails without a
canonical write.

## Convergence semantics

Core remains unchanged. The Legal Plugin's opaque convergence projection may
advance only for:

- one newly valid page-selection checkpoint;
- one newly valid matrix proposal receipt;
- one canonical matrix apply.

Repeated hook calls are stable. Invalid revisions map to one repair marker.
The scan is finite because offsets are deterministic and bounded by the
canonical fact count. The convergence write budget must report one changed
matrix and 24 KiB, matching the mutation contract; it must not fall back to 12
records when `matrix_pending` work items are present or absent.

## Boundaries

This experiment changes only the Legal Plugin. It does not change:

- Core AgentLoop, compaction, or cold/steady lease `8/2`;
- validator semantics, required matrix IDs, or materiality rules;
- source workers, source proposal/apply, facts, or reciprocal links;
- relation-closure behavior after matrices leave `pending`;
- issue, authority, coverage, or deliverable requirements;
- the model, runner, corpus, Router, Memory, or other runtime controls.

The plugin never selects a matrix for a fact, writes legal prose, changes fact
materiality, or embeds Case 09 literals or expected answers.

## Applicability

This protocol is general within the existing due-diligence matrix adapter. It
works for any configured pending matrix and any canonical fact set because it
depends only on validated IDs, bounded evidence fields, and Agent-owned legal
selection.

It is not a universal workflow for every task that happens to be legal. The
85-case architecture review includes narrative pleadings, short legal advice,
document redaction, content planning, calculations, research, and operational
file work. Those tasks need task-specific Skills or projection modes. This
change must not broaden legal-coverage activation or force the seven
due-diligence matrices onto inappropriate cases.

Available evidence supports the bounded protocol in its intended scope:

- v22: 107 facts; a compact index is 22,297 bytes versus 60,193 bytes for the
  canonical fact array, so three 8-KiB pages replace one unbounded read;
- v19: 94 facts; compact index 21,645 bytes versus 55,064 bytes, and the Agent
  successfully performed one-matrix direct writes once evidence was available;
- Case 05 remains an inactive legal-question control and must continue to
  create no legal workflow state;
- synthetic tests can cover empty, single-page, multi-page, oversized, stale,
  invalid, not-applicable, and successful apply paths without benchmark data.

## Verification gates

1. Unit tests prove deterministic paging, byte/record bounds, exact selection
   schemas, subset and duplicate rejection, finite offsets, repeated-call
   stability, stable invalid-revision markers, and cross-page accumulation.
2. Proposal tests prove selected-slice rehydration, deterministic paths and
   hashes, one-matrix scope, stale-state rejection, changed-proposal rejection,
   unknown/unselected fact rejection, not-applicable exhaustion, atomic apply,
   and preservation of all other canonical records.
3. Existing matrix-pending and relation-closure tests remain green; source,
   coverage, activation, path-security, and full PilotDeck suites remain green.
4. Read-only replay of the v22 snapshot proves the first pending matrix receives
   a bounded selection page and no instruction to read full `facts.json`.
5. Synthetic replays model at least three task shapes: relevant evidence on the
   first page, relevant evidence only after a skipped page, and no responsive
   evidence across all pages.
6. A fresh campaign repeats Gate 0, authenticated dual smoke, inactive Case 05,
   and one non-retried candidate Case 09. The candidate must write at least one
   matrix before broader testing is considered.

Passing initial matrix construction does not imply semantic completion. Any
later relation-closure, issue, authority, coverage, or deliverable blocker is
recorded separately and drives only the next smallest Legal Plugin experiment.
