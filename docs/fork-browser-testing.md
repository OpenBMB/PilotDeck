# Fork Browser Testing (A1–A9)

> E2E browser tests for the M0 Chat Forking feature. Runs against a live
> PilotDeck dev server (Vite + UI server) on `127.0.0.1:5173`. Implemented
> in Playwright + TypeScript (node:test harness).

## 1. Setup

### 1.1 Install Playwright (one-time on macmini-01)

```bash
ssh macmini-01 "export PATH=/opt/homebrew/bin:\$PATH && \
  cd ~/.pilotdeck/app && \
  npm i --no-save @playwright/test@1.61.1 && \
  npx playwright install chromium"
```

### 1.2 Bootstrap a fresh source session

The test session must be a **root** session (no `__fork_` in any
`entryId`) and must have **≥ 3 user turns** for A7. The bootstrap script
`tests/e2e/create-test-source.ts` writes such a session directly to
`~/.pilotdeck/projects/Users-macmini-01-.pilotdeck/chats/<id>.jsonl`
and touches the mtime to 2099-01-01 so it stays at the top of
`/api/projects` (which returns the top 5 by mtime desc).

```bash
ssh macmini-01 "cd ~/.pilotdeck/app && NODE_OPTIONS=--import\\ tsx npx tsx \
  tests/e2e/create-test-source.ts"
# → prints the new session id, e.g. web:s_810bb05a-...
```

### 1.3 Clean up stale bootstrap sessions

Each `create-test-source.ts` run touches its file to 2099. After several
runs, the top-5 list is full of these stale sources, leaving no room for
freshly-created forks. Run the cleanup to remove them:

```bash
ssh macmini-01 "cd ~/.pilotdeck/app && \
  PILOT_E2E_REFRESH_SESSION_ID=<canonical source id> \
  NODE_OPTIONS=--import\\ tsx npx tsx tests/e2e/cleanup-stale-sources.ts"
```

## 2. Test catalog

| Test | Verifies | LLM? | Notes |
|---|---|---|---|
| A1 | User messages show "Fork this conversation" on hover; assistant messages do not. | No | Two sub-tests: positive + negative. |
| A2 | Clicking fork navigates to a new session URL within 5 s. | No | Asserts URL ≠ source. |
| A3 | New session JSONL exists on disk and has the expected schema. | No | node:test, not Playwright. |
| A4 | JSONL entryId is unique; parentEntryId chain is intact. | No | node:test. |
| A5 | New session appears at sidebar[1] with title `Fork of …`. | No | Position 0 is the source (touched to 2099). |
| A6a | First user-message text matches between source and fork. | No | |
| A6b | New user turn on fork gets an assistant reply. | **Yes** | Skipped unless LLM available. |
| A7 | Three forks from same source have unique URLs and independent JSONLs. | No | Uses fresh `browser.newContext()` per fork to avoid SPA state carryover. |
| A9 | After deleting the source, the fork still loads. | No | Uses a fresh sacrificial session bootstrapped in `beforeAll`. |

A8 is intentionally skipped — it tests a feature that hasn't been built
yet (the in-chat "fork from here" menu mentioned in the original chat-
forking.md §1.2 plan). It's tracked as a TODO; once M0.5 ships the
`assistant-message` fork entry point, A8 should be added.

## 3. Running

### 3.1 All tests (LLM-dependent ones skipped)

```bash
ssh macmini-01 "export PATH=/opt/homebrew/bin:\$PATH && \
  cd ~/.pilotdeck/app && \
  PILOT_E2E_BASE_URL=http://127.0.0.1:5173 \
  PILOT_E2E_SESSION_URL='http://127.0.0.1:5173/p/general/c/<SOURCE_ID>' \
  PILOT_E2E_REFRESH_SESSION_ID='<SOURCE_ID>' \
  PILOT_E2E_SKIP_LLM=1 \
  NODE_OPTIONS='--import tsx' npx playwright test \
    'tests/e2e/fork/' --reporter=list --grep-invert 'explore-'"
```

### 3.2 Single test

```bash
ssh macmini-01 "cd ~/.pilotdeck/app && \
  PILOT_E2E_BASE_URL=http://127.0.0.1:5173 \
  PILOT_E2E_SESSION_URL='http://127.0.0.1:5173/p/general/c/<SOURCE_ID>' \
  PILOT_E2E_REFRESH_SESSION_ID='<SOURCE_ID>' \
  NODE_OPTIONS='--import tsx' npx playwright test \
    'tests/e2e/fork/A1-fork-button-on-hover.spec.ts' --reporter=list"
```

## 4. Helpers (`tests/e2e/helpers/`)

| File | Exports |
|---|---|
| `selectors.ts` | `SEL` — typed CSS selectors for fork UI elements. |
| `session.ts` | `waitForSessionReady(page)`, `readSidebar(page)`, `readUserMessageTexts(page)`, `assertIsSessionUrl(url)`. |
| `timing.ts` | `timeForkClick(page, buttonIndex)` — measures click→navigation latency. |
| `refresh.ts` | `refreshSourceSession()` — `touch -t 209901010000` on the canonical source file. Called from each spec's `beforeAll`. |

## 5. Manual checklist

For ad-hoc verification without Playwright:

- [ ] **A1**: open a session with ≥ 1 user + 1 assistant turn in a real
      browser. Hover over a user message — fork button appears. Hover over
      an assistant message — no fork button.
- [ ] **A2**: click the fork button. URL changes within ~1 s.
- [ ] **A5**: sidebar shows the new session with title `Fork of …`.
- [ ] **A6**: type a new message on the fork and verify it gets a reply.
- [ ] **A7**: fork the same source 3 times. Each appears in the sidebar
      with a unique ID. Editing one does not affect the others.
- [ ] **A9**: right-click a sidebar entry → Delete. Verify the fork is
      still loadable.
- [ ] **Telemetry** (devtools console): on hover, see
      `fork_menu_shown`; on click, `fork_clicked`.

## 6. Known limitations

- The PilotDeck `/api/projects` endpoint returns only the top 5 sessions
  by mtime. We work around this by touching the canonical source to
  year 2099. If a future release raises that limit, this hack can go.
- The `node:test` file `A3-A4-file-integrity.test.ts` requires tsx and
  uses node's test runner, not Playwright. Run with:
  ```bash
  NODE_OPTIONS='--import tsx' npx tsx --test tests/e2e/fork/A3-A4-file-integrity.test.ts
  ```
- `explore-*` files are scratch tests used during initial discovery.
  They're gitignored but live on disk. Don't rely on them.

## 7. Adding a new test (A10+)

1. Copy an existing `A*.spec.ts` as a template.
2. Add `import { refreshSourceSession } from '../helpers/refresh.ts';`
   and a `test.beforeAll(() => refreshSourceSession());` call so the
   source stays at top-5 across runs.
3. If the test creates forks or deletes the source, follow the
   sacrificial-source pattern from A9 (bootstrap a fresh session in
   `beforeAll`).
4. Append the test to §2 of this file.