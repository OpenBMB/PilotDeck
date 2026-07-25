# Deterministic legal source bootstrap QA

Date: 2026-07-25
Branch: `codex/convergence-hardening-v1`
Base commit: `ef922c3dafe5a38cc8d5bb34942bfe269ac51013`

## Triggering evidence

Campaign `20260725-e2-elite-convergence-v10-manifest-init`, candidate Case 09
run `20260725_191242_cdf4739c`, proved manifest-bound initialization,
`originalRoot`, root skeleton creation, source-phase advancement, and stable
guidance addressing. The main Agent then spent its two steady-state observations
reading the data contract and serializing 24 manifest entries without committing
source rows or launching workers. The lease correctly failed closed.

## Change and boundary

The Legal CLI now exposes `bootstrap-sources --from-manifest`. It validates the
runner manifest and source bytes, then atomically adds only missing originals to
`sources.json` as `pending` records with:

- deterministic path-derived IDs;
- exact original path and SHA-256;
- manifest-bound derivation path, SHA-256, extraction method, and extractor
  version.

It preserves existing rows and is idempotent. It does not mark a source reviewed,
invent facts, assign evidence class or materiality, create issues, or write a
deliverable.

Source-phase dynamic milestones expose `sourceBootstrapCommand` only when a
validated manifest exists and the blocker is an un-inventoried original. The
Legal Skill tells the Agent to execute it before manually copying manifest rows,
then delegate pending review batches.

No Core lease, editor rule, validator requirement, activation, runner, corpus,
benchmark identity, expected answer, or legal conclusion changed.

## QA

```text
npm run build
node --test --test-force-exit --test-timeout 60000 \
  dist/tests/products/legal-coverage.spec.js
```

Result: 32 passed, 0 failed. The new test proves command injection, exact
manifest lineage, pending-only semantics, stable IDs, idempotence, mode
validation, and removal of `source_not_inventoried` while preserving
`source_pending`.

```text
npm test
```

Result: 245 passed, 0 failed. This includes real local Gateway legal lifecycle,
subagent identity, progress lease, source lineage, editor freshness, artifact
contracts, server, tools, channels, config, and history.

`node --check` passed for the Legal CLI, validator library, and hook;
`git diff --check` passed.

## Residual risk

A fresh external-model campaign must prove that the Agent executes the injected
source bootstrap within the steady-state lease, launches disjoint workers,
receives successful subagent reports, and merges fragments into reviewed source
and fact state. No secret-bearing material or private corpus content is stored
here.
