# V24R17b Matrix Analysis Fragments

## What Was Tested

- `npm run build`
- `node --test --test-force-exit --test-timeout 60000 dist/tests/products/legal-coverage.spec.js`
- `npm test`
- `git diff --check`
- Fragment bind/apply and stale-snapshot paths through the Legal Coverage CLI and hook.
- Dynamic prompt command rendering with both absent and safely persisted fragments.

## What Was Observed

- Focused Legal Coverage suite: `47/47` passed.
- Full repository suite after rerun: `337/337` passed.
- The first full-suite run had one unrelated temporary-directory cleanup race (`ENOTEMPTY` in `observability/local-gateway-observation.spec.ts`); the immediate rerun passed `337/337`.
- A worker fragment does not modify `matrices.json`; `matrix-fragment-bind` creates only a state-bound proposal and immutable bind receipt.
- `matrix-proposal-apply` applies the bound proposal through the existing validator and canonical-writer path.
- Changing the facts snapshot rejects the fragment with `matrix_fragment_binding_invalid`.
- After an earlier matrix applies, an unchanged later fragment can be rebound to the new global state hash while retaining its facts and target-matrix hashes.
- The hook exposes fragment metadata and bind/apply state in the dynamic work items and convergence observation.
- A missing fragment never injects `<fragment-sha256>` or `undefined`; a safely persisted fragment injects its verified SHA-256 in the bind command.

## Why It Is Enough

The tests cover the new worker-only artifact boundary, current-state rebinding, stale fact protection, canonical write preservation, hook injection, and unchanged proposal validation. The full suite covers cross-module regressions and O1/Gateway behavior.

## What Was Omitted

No real LLM, external Gateway, Router, Memory, model, deadline, Lease policy, or 85-case campaign was run in this code-only verification. No credentials or environment dumps were recorded.
