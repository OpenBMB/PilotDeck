# Verification record

Verified locally on Node 22.23.2, against upstream `cfc4d1779228f91fececc5d6705c14dab5b7ef2f`. This records local execution, not GitHub CI approval.

| Check | Result |
|---|---|
| `pnpm build` | Passed, including root TypeScript compilation |
| `pnpm --dir ui run build` | Passed; existing chunk-size warning |
| Complete compiled backend test suite | 617 passed, 2 skipped, 7 cancelled; exit 1 |
| Settings, delivery cards and relevant config/server tests | 246 passed |
| Final settings/navigation/history/model-reference checks | 37 passed |
| Final delivery-card interaction checks | 23 passed |
| Independent artifact-grader regression | 3 passed |

UI groups overlap; their counts must not be added into one unique-test total. The final backend suite includes the delivery checker, packet, archive, reviewer, repair orchestration, native Memory, gateway model inheritance and persisted history tests.

## Existing backend cancellations

The complete suite used:

```sh
node --test --test-concurrency=4 --test-force-exit --test-timeout 60000 "dist/tests/**/*.test.js" "dist/tests/**/*.spec.js"
```

All seven cancellations are in `tests/network/fetch.spec.ts`, reporting `Promise resolution is still pending but the event loop has already resolved`. There were zero assertion failures. To distinguish this from a regression, the unmodified network module and test were extracted from the upstream base, compiled with the same TypeScript settings and dependencies, and run with the same Node test flags. They reproduced **the same seven cancellations**. Neither file is changed in this PR. The complete suite is therefore not reported as green.

## Real interface and model execution

The isolated native gateway run verified file creation, semantic rejection, same-child repairs, the main-model reviewer default and a text-only receipt. Browser checks verified prompt save/restore, reviewer selection, Auto/Off, reopening delivery history and opening the actual repaired file. No browser responses were mocked. The recorded walkthrough replays this real model run with explicitly seeded initial faults.

The final controlled regression reran all 16 task/arm combinations. Runtime file hashes and all outcomes are linked from [EXPERIMENTS.md](EXPERIMENTS.md). These model experiments are separate from deterministic test counts.
