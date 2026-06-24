# Chat Patching (M1)

> Sub-feature of Chat Forking. Where M0 lets users fork "from here", M1
> lets them apply a fork *retroactively*: see a branch in the sidebar,
> drag it back into the main conversation, or replace an old turn with a
> newer one without losing context.

## 1. Why M1 exists

M0's mental model is **branching**: each fork is a parallel universe. The
user must decide up-front whether they want to explore a tangent or stay
on the main line.

In practice users:

1. Start on main.
2. Try a tangent, explore it (M0).
3. Want to **promote** the better answer from the tangent back into the
   main line, without losing any of the new user turns made on main in the
   meantime.

M0 cannot express that. The user is forced to choose: discard the main
turns made while branching, or stay on the tangent.

**M1 introduces chat patching**: a fork can be *rebased* onto the source,
preserving the order of events and the user-turn history of the main
line, while replacing some of the assistant turns with the better ones
from the fork.

## 2. Mental model

```
main line (A):  u1 → a1 → u2 → a2 → u3 → a3
fork  (B):      u1 → a1' → u2 → a2' → (no more turns)
patch result:   u1 → a1 → u2 → a2' → u3 → a3
```

The patch result re-uses main's `a1` (because B's `a1'` is worse), but
uses B's `a2'` (because the user prefers it). The user keeps main's `u3`
turn because it was made while exploring B.

M0's `upToEntryId` becomes: the **boundary** of the patch (the last
entry to copy verbatim from main), plus a list of *patches* — entryIds
from the fork that should replace the corresponding entries in main.

## 3. Data model extensions on top of M0

Re-uses M0's SessionMeta, but adds:

```ts
interface SessionMeta {
  // ... M0 fields ...
  schemaVersion: 2;                    // bumped from M0's 1
  forkedFrom?: {
    intent: 'fork' | 'rewind' | 'patch';  // NEW: 'patch' = M1
    upToSequence?: number;
    patches?: Array<{ from: string; to: string }>;  // entryId pairs
    snapshotHash: string;
  };
}
```

The JSONL entries themselves are unchanged. A patch session is just a
regular session whose `SessionMeta.forkedFrom.intent === 'patch'`.

## 4. UX surface

The user opens the sidebar → clicks a fork → sees a "Promote into main"
button. Clicking opens a dialog showing:

- The fork's diff vs main (turns added, turns replaced).
- A toggle per turn: keep main's turn vs use fork's turn.
- A "Preview" button that runs through the merged timeline locally.
- "Apply" → creates a patch session and navigates to it.

Keyboard shortcut: `Cmd+Shift+P` on the fork page opens the promote dialog.

## 5. Telemetry (extends M0)

| Event | When |
|---|---|
| `patch_dialog_shown` | "Promote into main" clicked |
| `patch_diff_rendered` | diff list visible to user |
| `patch_toggle_changed` | user toggled a turn (keep main / use fork) |
| `patch_previewed` | user clicked Preview |
| `patch_applied` | user clicked Apply and the new session was created |
| `patch_applied_reverted` | user reverted a patch within 5 minutes |

These 6 events, together with M0's 5 (`fork_menu_shown`, `fork_clicked`,
`fork_menu_dismissed`, `assistant_hover`, `assistant_text_selected`),
give full coverage of branching + patching.

## 6. Open questions

- **Conflict on parallel branches**: if main advanced while the fork was
  active, main may have a turn (`u3`) that the fork never saw. The patch
  must insert `u3` at the right point. Current proposal: always insert
  new main turns *after* the patch boundary, in the order they appeared.

- **Reverting a patch**: should be possible within 5 minutes (analogous
  to email unsend). After 5 minutes, reverting requires a fork-of-the-
  patch. Tooling for the 5-minute window is TBD.

- **Multi-source patches**: can a patch combine turns from 2+ forks?
  Out of scope for M1.

## 7. Implementation sketch (placeholder)

The patching engine lives in `src/session/patching/` (TBD path) and is
invoked from `useSessionStore.applyPatch(forkUrl, patches)`. It calls
`POST /api/projects/:p/sessions/:s/apply-patch` which:

1. Reads source's full entry list up to `upToEntryId`.
2. Reads fork's `patches` entries.
3. Merges and writes a new JSONL with new `entryId`s (preserving
   `parentEntryId` chains).
4. Writes a SessionMeta with `forkedFrom.intent = 'patch'`.

Open questions §6 above block final design.

## 8. Test plan (placeholder)

Reuses M0's test helpers (`tests/e2e/helpers/`). Adds:

- `tests/e2e/patch/B1-apply-patch.spec.ts` — promote fork into main.
- `tests/e2e/patch/B2-revert-patch.spec.ts` — undo within 5 min.
- `tests/e2e/patch/B3-patch-after-fork.spec.ts` — patch after both sides
  have added new turns.

Telemetry assertions: each test triggers a known patch event and asserts
the event was logged via `GET /api/telemetry?since=...`.

## 9. Reference

- `chat-forking.md` §3.5 — the M0 fork model this extends.
- `fork-browser-testing.md` — Playwright patterns this re-uses.