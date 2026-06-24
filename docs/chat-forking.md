# Chat Forking (M0)

> PilotDeck's M0 chat forking feature. Lets users fork any user message
> into a new session that inherits all prior context but diverges from
> the chosen point. This document is the canonical source of truth for
> the M0 feature; M1 ("chat patching") is described in
> `chat-patching.md`.

## 1. Goals

### 1.1 Why fork

PilotDeck users regularly:

- Hit a wrong turn from the assistant and want to rewind.
- Want to explore a tangent without losing the main line of work.
- Want to A/B compare two different approaches.

A **fork** is the smallest primitive that satisfies all three: copy the
conversation up to point X, branch from X.

### 1.2 Acceptance criteria (A1–A9)

| ID | Title | Status (M0) |
|---|---|---|
| A1 | Every user message exposes a "Fork this conversation" entry on hover. Assistant messages MUST NOT. | ✅ |
| A2 | Fork click navigates to a new session URL within 5 s (target: ≤ 500 ms in practice). | ✅ |
| A3 | New session JSONL file is created on disk. | ✅ |
| A4 | JSONL entries have unique entryIds and an intact parentEntryId chain. | ✅ |
| A5 | The new session appears in the sidebar with the title `Fork of <source-title>`. | ✅ |
| A6a | The first user message in the fork matches the source's first user message. | ✅ |
| A6b | A new user turn made on the fork gets an assistant reply. | ✅ (requires LLM) |
| A7 | Forking the same source 3 times produces 3 independent forks (separate JSONL files, distinct session IDs). | ✅ |
| A9 | After deleting the source, the fork is still loadable. | ✅ |

A8 — the inline "fork from here" menu on assistant messages — is
**deferred to M0.5** (see §3.5). The M0 implementation only allows
forking from user messages; a separate "重答" (re-answer) button on
assistant messages replaces the M0.5 fork-from-here menu.

### 1.3 Telemetry (M0 must-haves)

The following 5 events are emitted by the M0 client and must be
observable in `/api/telemetry?since=…`:

| Event | When | Property |
|---|---|---|
| `fork_menu_shown` | User hovers over a user message (the fork button becomes visible). | `sessionId`, `entryId`, `sequence` |
| `fork_clicked` | User clicks the fork button. | `sessionId`, `entryId`, `sequence`, `project` |
| `fork_menu_dismissed` | User moves pointer off the row before clicking. | `sessionId`, `entryId` |
| `assistant_hover` | User hovers over an assistant message. | `sessionId`, `entryId` |
| `assistant_text_selected` | User selects ≥ 3 consecutive words inside an assistant message. | `sessionId`, `entryId`, `selectedLength` |

These events feed the "user engages with forking" funnel and the
"assistant text selection" funnel that informs whether M0.5's
inline-fork-on-assistant feature has demand.

## 2. UX

### 2.1 Where the entry point lives

- On every user message row, a small icon button labelled
  `Fork this conversation` (aria-label) appears on hover.
- On assistant message rows, **no** fork button is rendered.
- The button is positioned at the top-right of the message row.

### 2.2 What happens on click

1. Client calls `POST /api/projects/:project/sessions/:source/fork` with
   body `{ upToEntryId }` (optional).
2. Server creates a new JSONL file and a SessionMeta with
   `forkedFrom.intent = 'fork'`.
3. Server returns `{ sessionId, projectName }`.
4. Client calls `navigate(\`/p/${projectName}/c/${sessionId}\`)`.
5. Sidebar refreshes via `useProjectsState.refreshProjects()`.

### 2.3 What happens on success

- URL changes to the new session.
- Sidebar[1] shows the new session with title `Fork of <source-title>`
  (position 0 is the source, which is touched to a far-future mtime
  during E2E to keep it at the top).
- Source session is untouched.

### 2.4 What happens on failure

- Server returns 4xx (e.g., `409` if the source has `__fork_` in any
  `entryId`, i.e. already a fork): client shows a toast
  "Cannot fork this session — it is itself a fork."
- Server returns 5xx: client shows a toast "Fork failed, please retry."

## 3. Data model

### 3.1 SessionMeta

Stored at `<project-root>/chats/<sessionId>.meta.json`:

```ts
interface SessionMeta {
  schemaVersion: 1;
  sessionId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  projectName: string;
  forkedFrom?: {
    intent: 'fork' | 'rewind' | 'patch';
    sourceSessionId: string;
    sourceEntryId?: string;
    upToSequence?: number;
    snapshotHash: string;
  };
}
```

M0 reserves these fields but only ever sets `intent: 'fork'`.
`rewind` and `patch` are M0.5+ future use.

### 3.2 JSONL entries

Each turn produces one `accepted_input` + one `assistant_message` + one
`turn_result` triple (3 lines). A fork copies all lines whose
`sequence <= upToSequence`. Without `upToSequence`, all lines are
copied (full conversation fork — current M0 behavior).

### 3.3 entryId

Format: `<uuid>` (root) or `<uuid>__fork_<newSessionId>` (fork).
The `__fork_` suffix is what the server uses to refuse
double-forking: if any entryId in the source already contains
`__fork_`, the fork endpoint returns `409`.

### 3.4 Sidebar listing

`GET /api/projects` returns up to **5** sessions per project, sorted by
mtime descending. M0's sidebar is read-only on this list.

### 3.5 M0.5 follow-up: 重答 on assistant messages

M0.5 replaces the "fork from here" menu that was originally proposed for
assistant messages with a separate **重答** (re-answer) button.

Why the change:

- Forking an assistant message is semantically odd — the assistant's
  output is reactive, not generative. Forks should originate from
  *decisions*, i.e. user prompts.
- "重答" matches the user's mental model: "give me another answer for
  that prompt." It's an undo-and-retry, not a parallel-universe.
- The M0.5 button clears the assistant turn and re-runs the
  conversation from the user message immediately above. The session
  stays the same; only that one assistant turn changes.

Implementation: a new icon button on assistant message rows,
aria-label `Re-answer this turn`. Clicking it deletes the
`assistant_message` and `turn_result` lines that follow the relevant
`accepted_input` and triggers a retry.

Telemetry: `re_answer_clicked`, `re_answer_succeeded`, `re_answer_failed`.

## 4. API

### 4.1 Fork a session

```
POST /api/projects/:project/sessions/:source/fork
Body: { upToEntryId?: string }
→ 200 { sessionId: string, projectName: string }
→ 409 if source is itself a fork (has __fork_ in any entryId)
→ 404 if source session not found
```

### 4.2 Delete a session

```
DELETE /api/projects/:project/sessions/:sessionId
→ 204 if deleted
→ 404 if session not found
```

M0's UI exposes delete only via a sidebar context menu (right-click on
a session row). Programmatic deletes are blocked unless the caller has
an admin token.

### 4.3 Read session meta

```
GET /api/projects/:project/sessions/:sessionId/meta
→ 200 SessionMeta
→ 404 if not found
```

## 5. Client state

- `useSessionStore.forkFromEntry({ projectName, sessionId, navigate, refreshProjects })`
  is the canonical entry point. It calls the API and navigates.
- `useProjectsState.refreshProjects()` re-fetches `/api/projects` and
  re-renders the sidebar.
- Source session's JSONL is **not** modified by a fork.

## 6. Known M0 limitations

- `upToEntryId` is supported by the API but **not currently wired
  through from the client**. M0 always forks the entire conversation.
  chat-patching.md M1 introduces per-row truncation as part of the
  patch flow.
- Double-forking (forks of forks) returns 409. The intended UX is to
  use rewind or patch instead — neither of which is built yet.
- The sidebar's 5-session limit means a session falls out of the top-5
  after 4 newer sessions are created. M0 ships no "load more" UI yet;
  that's a side-quest for the general sidebar work.

## 7. Test plan

Browser-level tests live in `tests/e2e/fork/A*.spec.ts`. See
`fork-browser-testing.md` for the full Playwright setup, helper
reference, and known limitations.

The M0 spec is the union of:

- **A1** through **A9** as listed in §1.2.
- **A3-A4-file-integrity.test.ts** (node:test) — JSONL schema and
  entryId/parentEntryId chain.
- Manual checklist (see `fork-browser-testing.md` §5) for the cases
  that can't be automated cheaply (e.g., the 5-minute revert window
  once it ships in M1).

Telemetry verification: every A1–A9 spec must trigger the
corresponding event at least once during the suite run. A separate
`tests/e2e/fork/A-telemetry.test.ts` (TODO) will hit
`GET /api/telemetry?since=…` and assert each event was logged.