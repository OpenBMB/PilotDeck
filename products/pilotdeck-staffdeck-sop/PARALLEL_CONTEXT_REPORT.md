# Parallel Context Report

Scope: E2E-01 / CTX-01 / CMP-01/CMP-02 native-owner compaction and context
replay. This is evidence for the authoritative ledger, not by itself a
G0-G5 acceptance sign-off.

## Evidence

- Candidate trace: `/tmp/pilotdeck-e2e01-agentdesc-fix2/e2e01-native-owner-trace.json`.
- Native-owner StaffDeck composition E2E passes `2/2` after applying the fixed
  B0 tool surface to every native-owner Gateway turn.
- Frozen-B0 replay without the post-compaction branch exits `0`. Both recorded
  automatic/reactive attempts match their trigger snapshots, budget evaluations,
  summary requests/results, replacement surfaces, and persisted-boundary checks.
- Full post-restart canonical request replay exits `0`. The `messages`, tool
  names, `agent` description, `execute_code.description`, request keys, and
  workspace normalization all match fixed B0. The strict comparator remains
  unchanged; `execute_code.description` is closed, not an open gap.
- The `agent` description is now configuration-aware. With the default
  `maxSubagentDepth=1`, the child registry has no `agent` or `subagent` fork
  capability and the public description uses B0's “except nested agent launch”
  wording; explicit depth `>1` retains the nested-delegation wording.
  Focused depth/description tests pass, and the refreshed real-owner trace no
  longer differs on `agent`.
- A harmless sentinel probe against B0 and candidate confirms the default
  `danger-full-access` host path preserves the parent environment while adding
  the same private `PYTHONPATH`, workspace/temp, and RPC variables. The
  candidate now exposes the selected host mode so constrained/custom sandbox
  descriptions remain truthful without changing execution behavior.
- The post-compaction mismatch sensitivity remains effective: injecting a
  message mismatch exits nonzero. Ordinary candidate/B0 replay remains passing.

## Boundary

This closes the declared native Context/Compaction cases: causal attempts,
budget decisions, summary/replacement messages, contribution ordering, media
pairing, spill/missing-summary recovery, cancellation/write-race behavior,
persisted boundaries, restart count, and full post-restart canonical request
parity. The remaining G0/G1 blockers are the independent incomplete-stream B0
replay and real-provider Model differential recorded in
`ACCEPTANCE_REQUIREMENTS.md`.

Status: `PASS` for the declared CTX-01/CMP-01/CMP-02 evidence; not a standalone
seven-slot sign-off.
