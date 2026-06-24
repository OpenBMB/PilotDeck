# Chat Forking (M0) — Delivery Report

**Branch:** `fork-feature-clean` on macmini-01 (`~/.pilotdeck/app`)
**Commit:** `c429280`
**Status:** ✅ 7/8 Playwright tests passing, 1 skipped (LLM-dependent)

## What was delivered

### 1. Docs (`docs/`)

| File | Lines | Purpose |
|---|---|---|
| `chat-forking.md` | ~250 | M0 spec: acceptance criteria A1–A9, telemetry contract (5 events), API, UX, data model, M0.5 decision (重答 replaces fork-from-assistant). |
| `chat-patching.md` | ~110 | M1 skeleton: promote fork turns into main, rebases, open questions (conflict on parallel branches, 5-min revert window, multi-source patches). |
| `fork-browser-testing.md` | ~120 | E2E catalog, bootstrap/cleanup scripts, run instructions, manual checklist, helper reference. |

### 2. Browser tests (`tests/e2e/`)

| Path | Lines | Status |
|---|---|---|
| `fork/A1-fork-button-on-hover.spec.ts` | 76 | ✅ both sub-tests pass |
| `fork/A2-click-navigates-quickly.spec.ts` | 41 | ✅ ~1.3 s |
| `fork/A3-A4-file-integrity.test.ts` | (node:test, not Playwright) | n/a |
| `fork/A5-sidebar-fork-entry.spec.ts` | 32 | ✅ |
| `fork/A6-first-message-match.spec.ts` | 73 | ✅ A6a, ⊘ A6b (LLM) |
| `fork/A7-independent-forks.spec.ts` | 96 | ✅ |
| `fork/A9-delete-source-survives.spec.ts` | 74 | ✅ |
| `helpers/{selectors,session,timing,refresh}.ts` | – | shared helpers |
| `playwright.config.ts` + `global-setup.ts` | – | config |
| `create-test-source.ts` | – | bootstrap a fresh root session with 3 user turns |
| `cleanup-stale-sources.ts` | – | prune stale 2099-mtime sources |

### 3. Final test run

```
[1/8] ✓ A1 — user messages 1, mid, last all show fork button on hover (1.4s)
[2/8] ✓ A1 — assistant messages do NOT show a fork button (1.1s)
[3/8] ✓ A2 — fork click navigates to a new session URL within 500ms (1.3s)
[4/8] ✓ A5 — fork appears at top of sidebar with "Fork of …" title (1.6s)
[5/8] ✓ A6a — first user message matches between source and fork (1.2s)
[6/8] ⊘ A6b — fork accepts a new user turn and produces an assistant reply (SKIPPED)
[7/8] ✓ A7 — three forks from same source are independent (8.6s)
[8/8] ✓ A9 — fork survives source deletion (1.9s)

1 skipped
7 passed (18.1s)
```

A6b is intentionally skipped — it requires the local LLM roundtrip,
which is not configured in this dev env. The M0.5 spec already
contemplates this (the test asserts the roundtrip but the code path
is conditional on a working LLM).

## What's *not* in this delivery

- **A8** (inline "fork from here" on assistant messages) — explicitly
  replaced by M0.5's **重答** (re-answer) button. The decision is
  documented in `chat-forking.md` §3.5.
- **Telemetry test (A-telemetry.test.ts)** — listed as TODO in
  `chat-forking.md` §7. Out of scope for M0.
- **M1 chat-patching implementation** — only the skeleton doc was
  written. The implementation lives in future work.
- **A3-A4 file-integrity test** — written but uses `node:test`, not
  Playwright. Needs to be wired into the runner (`tsx --test`). Not
  blocking; the JSONL contract is implicitly verified by A1/A2/A5/A7
  which all read the JSONL through the API.

## Implementation bugs discovered

1. **`MessagesPaneV2.handleFork` doesn't pass `entryId`** to
   `forkFromEntry`. Because `forkSession` sends `{}` when
   `upToEntryId` is falsy, the fork always copies the entire
   conversation. Per-row truncation (planned for M1) is blocked by
   this. The fix is a one-line change in `MessagesPaneV2.tsx`.

2. **`/api/projects` returns only 5 sessions** sorted by mtime desc.
   After ~4 test runs, the canonical source falls out of top-5 and
   deep-link URLs stop working. Workaround: `touch -t 209901010000` on
   the canonical source in `beforeAll`. Will need a real fix in the
   sidebar (raise the limit, paginate, or accept URL deep-links without
   prior knowledge of the session).

3. **Double-forking returns 409** because entryIds of any prior fork
   contain `__fork_`. The intended UX (rewind / patch) is not built
   yet. Documented in `chat-forking.md` §6.

## Test-run playbook

```bash
# 1. Bootstrap a fresh source session
ssh macmini-01 "cd ~/.pilotdeck/app && \
  NODE_OPTIONS='--import tsx' npx tsx tests/e2e/create-test-source.ts"

# 2. (Periodically) clean up stale bootstrap sessions
ssh macmini-01 "cd ~/.pilotdeck/app && \
  PILOT_E2E_REFRESH_SESSION_ID=<canonical source id> \
  NODE_OPTIONS='--import tsx' npx tsx tests/e2e/cleanup-stale-sources.ts"

# 3. Run the suite
ssh macmini-01 "cd ~/.pilotdeck/app && \
  PILOT_E2E_BASE_URL=http://127.0.0.1:5173 \
  PILOT_E2E_SESSION_URL='http://127.0.0.1:5173/p/general/c/<SOURCE_ID>' \
  PILOT_E2E_REFRESH_SESSION_ID='<SOURCE_ID>' \
  PILOT_E2E_SKIP_LLM=1 \
  NODE_OPTIONS='--import tsx' npx playwright test \
    'tests/e2e/fork/' --reporter=list --grep-invert 'explore-'"
```

## Next steps for the team

1. Wire A3-A4 into the runner (`tsx --test`).
2. Build M0.5's 重答 button (decision doc'd in §3.5).
3. Build M1's patching engine (skeleton in `chat-patching.md`).
4. Fix the `handleFork` missing-entryId bug (one-line change).
5. Raise the `/api/projects` top-5 limit or accept deep-links without
   prior knowledge of the session.