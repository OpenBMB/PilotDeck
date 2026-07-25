# Manifest-bound legal initializer QA

Date: 2026-07-25
Branch: `codex/convergence-hardening-v1`
Base commit: `584010569ead3383f6db8ed030a3e29e143cda71`

## Triggering evidence

Candidate-only Case 09 in campaign
`20260725-e2-elite-convergence-v9-subagent-ownership`, run
`20260725_184537_db0b7783`, activated the Legal Plugin and created the root
deliverable skeleton, but the model initialized `config.inputRoots` from the
runner manifest's `derivedRoot` instead of `originalRoot`.

Validation reported `configuration/input_root_not_original`. The model then
inspected the values through bash and attempted `edit_file` without first
establishing a `read_file` snapshot, so the generic editor correctly rejected
the write. The unchanged state reached the steady-state progress lease and
failed closed after two observations. The run preserved all inputs and artifacts
but never reached the evidence-worker treatment point.

## Change and boundary

The Legal CLI now supports `init --input-from-manifest`. This mode is mutually
exclusive with explicit `--input`, requires a readable trusted runner manifest
with a safe `originalRoot`, and writes only that runtime-resolved root to
`config.inputRoots`.

The Legal Plugin validator result exposes the already validated, non-secret input
manifest descriptor. Configuration milestones use it to emit a structured
`initializerCommand` with `--input-from-manifest`; workspaces without a runner
manifest retain the generic `--input <source-root>` command. The Legal Skill and
product README document preserving this manifest-bound option.

No Core progress-lease threshold, edit freshness rule, source/fact validator
rule, activation term, runner behavior, corpus case, benchmark ID, expected
answer, or legal conclusion changed. Manifest-specific policy remains in the
Legal Plugin rather than PilotDeck Core.

## Commands and observations

```text
npm run build
node --test --test-force-exit --test-timeout 60000 \
  dist/tests/products/legal-coverage.spec.js
```

Result on the final code tree: 31 passed, 0 failed. The new test proves:

- dynamic context includes `initializerCommand`;
- the command selects `--input-from-manifest` and never selects `derivedRoot`;
- CLI initialization writes the manifest `originalRoot`;
- mixing manifest mode with explicit input fails closed;
- manifest mode without a usable manifest fails closed;
- ordinary explicit-input initialization remains compatible.

```text
npm test
```

Result: 244 passed, 0 failed. This includes real local Gateway legal lifecycle,
main/subagent identity propagation, progress lease and compaction, edit
read-before-write protection, artifact contracts, source lineage, server,
channels, config, tools, and history.

`node --check` passed for the Legal CLI, validator library, and hook;
`git diff --check` passed.

## Why this is enough and residual risk

The focused tests directly reproduce the original/derived choice and its
fail-closed variants. The full suite protects generic Agent and Gateway behavior.
A fresh external-model campaign must still prove that the model consumes the
new initializer command, reaches source review, launches evidence workers with
`isSubagent=true`, receives successful worker reports, and merges their bounded
fragments before the main-agent lease expires.

No API key, server token, auth header, environment dump, private corpus content,
or raw model payload is stored here.
