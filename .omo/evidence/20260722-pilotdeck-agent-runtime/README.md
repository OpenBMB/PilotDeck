# PilotDeck Agent Runtime QA Evidence

Date: 2026-07-22

## What Was Tested

1. TypeScript production build with `pnpm run build`.
2. Forty-one focused tests covering dynamic context, mutable `PreModelRequest`, post-routing request rebuilds, domain activation, artifact validation/correction, session cleanup, prompt dispatch arbitration, cancellation, timeout, shutdown, and the public WebSocket trust boundary.
3. A deterministic local-gateway integration test that loads a real project plugin command from `.pilotdeck/plugins`, injects current-request context and a model patch, registers a required `.xlsx` artifact, observes the first validation failure, and accepts completion only after the correction request creates the artifact.
4. The complete compiled test inventory except the independently reproduced baseline timer file: 154 tests.
5. The repository's unmodified `pnpm test` command, including the known baseline timer file.
6. Diff hygiene with `git diff --check`, and a base comparison for the timer implementation and tests.

## What Was Observed

- `pnpm run build`: PASS.
- Focused runtime controls: PASS, 41/41.
- Local gateway/project plugin QA: PASS. Dynamic context was present on the first model request only; `maxOutputTokens` was patched to 1234; a missing `final.xlsx` produced an artifact correction request; completion followed creation of the required file.
- Full regression inventory excluding `dist/tests/network/fetch.spec.js`: PASS, 154/154.
- Unmodified `pnpm test`: 153 passed and 7 cancelled in `tests/network/fetch.spec.ts`; no test reported a failed assertion. The cancellation is independently reproducible on Node v22.22.0 because the only pending retry/timeout timers are `unref()`'d.
- `git diff --exit-code origin/main -- src/network/fetch.ts tests/network/fetch.spec.ts`: PASS, proving this branch does not modify the cancelled baseline surface.
- The user's main PilotDeck checkout retained its pre-existing uncommitted dynamic-context files; implementation and QA ran only in `/Users/da/Documents/PilotDeck-wt-agent-runtime`.

## Why It Is Enough

The focused suite proves state and security invariants at component boundaries. The local-gateway test additionally drives production assembly, project plugin discovery, command-hook execution, lifecycle parsing, context preparation, routing, model execution, artifact correction, transcript/session cleanup, and gateway disposal together. The 154-test regression pass covers every other compiled test surface in the repository.

## What Was Omitted

- No external model or network API was called; QA used a deterministic local fake model.
- No real API keys, auth headers, environment dumps, or private user data were captured. The integration fixture uses the literal placeholder `test-key`.
- The unrelated baseline network timer defect was not changed in this branch to keep the PR scoped to Agent runtime foundations.
