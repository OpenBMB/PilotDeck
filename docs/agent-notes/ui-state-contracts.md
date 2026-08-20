# UI State Contracts

## Context

The UI Server bridge translates Gateway events. It may maintain transport and
view state, but Gateway remains the source of truth for sessions, turns, and
active runs.

## Invariants

- Pending, working, permission, and elicitation state is keyed by session and
  run identity; one session's late event cannot overwrite another session.
- History replay and live events converge to one representation without
  duplicating tool results or terminal events.
- Reconnects discard stale connection events and preserve the current active
  run until the Gateway reports a terminal state.
- Queued send, force-send, abort, and Stop preserve message/attachment
  snapshots and never submit a second active turn accidentally.

## Evidence and status

- [session store tests](../../ui/src/stores)
- [chat hook tests](../../ui/src/components/chat/hooks)
- [WebSocket lifecycle tests](../../ui/src/contexts/WebSocketContext.lifecycle.test.tsx)
- [controlled browser smoke](../../ui/e2e)

Store/reducer/protocol helpers are P6 candidates for 100% coverage. Hooks and
components use behavior assertions and targeted public-entry smoke; Playwright
and real Gateway reconnect remain non-required checks.
