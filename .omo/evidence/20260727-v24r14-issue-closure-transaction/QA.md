# V24R14 issue closure transaction QA

## What was tested

1. A sanitized `risk_signal_orphaned` counterexample exercised proposal
   preparation, rejection, validation, apply, replay, stale-state, byte-change,
   criticality-downgrade, path, and symlink controls.
2. A real local Gateway loaded the installed Legal Coverage plugin, received
   the dynamic issue proposal and apply milestones, executed both through real
   `bash` tool calls, enforced Progress Lease `8/2`, and recorded O1 diagnostic
   evidence with Router and Memory disabled.
3. The preserved V24R13 Case 09 workspace was copied to a temporary directory
   and passed through the current `PreModelRequest` hook process. The probe
   emitted only counts, flags, and booleans and compared canonical hashes before
   and after.
4. Focused Progress Lease, context compaction, dynamic context, domain plugin,
   Gateway handoff, O1, and machine-deadline suites were run together.
5. The complete repository build and test suite plus `git diff --check` were
   run against the unchanged locked dependency tree.

## What was observed

- Red criticality counterexample: the pre-fix template returned `false` for a
  target containing critical facts; the new assertion failed as intended.
- Focused issue transaction tests: 2 passed, 0 failed.
- Real local Gateway issue/authority comparison: 2 passed, 0 failed. The issue
  path observed `baseline(0,0) -> handoff_grace(0,1) -> completed(1,1)`, two
  paired tool calls, a current completion proof, and zero O1 recorder drops.
- Cross-layer controls: 46 passed, 0 failed.
- Preserved Case 09 projection: `risk_signal_orphaned` produced one bounded
  `issue-closure-propose` item with 5 facts, 4 critical facts, 1 allowed rule,
  no premature apply command, and unchanged frozen/copy canonical ledgers.
- Full repository: 316 passed, 0 failed after a clean build.
- Patch hygiene: `git diff --check` passed; `pnpm-lock.yaml`, Core compaction,
  Progress Lease, validator rules, Router, Memory, and runner files are
  unchanged.

Artifacts:

- `focused-issue-closure.log`
- `real-gateway.log`
- `cross-layer-focused.log`
- `preserved-state-probe.json`
- `full-test.log`
- `diff-check.log`

## Why it is enough for the code gate

The state-bound tests cover all mutation inputs and prove that invalid or stale
revisions cannot mutate canonical ledgers or manufacture progress. The real
Gateway test proves the dynamic prompt, handoff ordinal, tool execution,
validator, completion proof, and O1 surfaces compose end to end. The preserved
state probe proves the exact V24R13 failure shape now receives the new bounded
interface without changing the frozen campaign. The full suite covers
unrelated product regressions.

## Boundary preserved

- Production changes are limited to the Legal Coverage plugin CLI, hook,
  transaction library, and its domain Skill.
- The transaction handles only the first `issues/risk_signal_orphaned` entry,
  at most 12 facts, one issue per known risk signal, and 24 KiB.
- Criticality is derived from the complete fact slice and cannot be downgraded
  to avoid the unchanged authority requirement.
- Core, Lease `8/2`, validator rules, model, corpus, Skills snapshot, runner,
  deadlines, Router, Memory, and O1 implementation are unchanged.

## Remaining product risk

Deterministic QA cannot prove that the real model will produce correct legal
analysis, finish all six remaining matrices, close authority and coverage
relationships, create a substantive report, or finish Case 09 within 2,100
seconds. Those claims require a new immutable V24R14 Gateway/O1 campaign.
V25 and the 85-case campaign remain unauthorized until the Case 09 product
Gate passes in full.

## What was omitted

No API key, token, auth header, environment dump, private source text, prompt
body, legal report text, or model reasoning is stored in this evidence. The
preserved-state probe reads a temporary local copy and records only aggregate
metrics and booleans.
