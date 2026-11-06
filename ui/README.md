# Web application

React/Vite client and Express server used by browser and Electron deployments.

- Client entry: [src/main.jsx](src/main.jsx); active shell and screens live under [src/components](src/components).
- The active route is `App -> AppShellV2 -> MainAreaV2 -> MainContent -> ChatInterfaceV2`. The `V2` names identify the current presentation, not an optional parallel application. `components/chat` contains shared session hooks, model selection, tool rendering and message primitives; shared code must not import `components/chat-v2`. Keep content-reference chips and model capability parsing in that shared boundary.
- [WebSocketContext](src/contexts/WebSocketContext.tsx) publishes connection state through React context and delivers every incoming frame through synchronous subscriptions. Consume events with `subscribe`, project them into feature state, and batch rendering at the feature boundary. Never use a single latest-message React state slot as an event queue: unrelated frames in the same batch would overwrite updates and streaming would rerender transport-only consumers.
- Chat history search indexes text only while open or resolving a pending global content result. Session-store render notifications are frame-batched and cancelled on unmount, including notifications from late history responses.
- [SessionHistoryCache](src/stores/SessionHistoryCache.ts) retains at most eight inactive, confirmed history-only slots. Active selections, in-flight requests, incomplete tools, explicit prompts and any slot that received live, control, optimistic or active-turn snapshot data stay pinned. Revisiting an evicted history uses the existing HTTP reload and scroll-anchor path. This bounds ordinary history browsing, not total live-state memory; reconfirming previously live slots requires a separate durable-reconciliation contract, so a successful refresh alone never makes those slots evictable.
- Server entry: [server/index.js](server/index.js); HTTP routes and services live under [server](server).
- Shared contracts: [shared](shared); real browser/Electron acceptance: [e2e](e2e).
- [Form chrome](src/form-controls.css) owns select menus, checkbox/radio indicators and sliders. Keep semantic HTML controls and existing change handlers. Electron and Chromium 135+ use CSS `base-select` top-layer menus; other engines retain a functional native picker. Do not cover selects with transparent overlays. [Form events](src/lib/formControlEvents.ts) lets an open picker consume Escape before an enclosing dialog.
- [DateTimeField](src/components/ui/DateTimeField.tsx) supplies themed calendar/clock panels while retaining typed inputs, ISO date/time values and browser validation. File/directory selection and OS permission dialogs remain system-owned.
- [Usage](src/components/settings/view/usage) derives lifetime metrics, daily/weekly activity and cumulative trends from the existing numeric JSONL files in `PILOT_HOME/usage/daily` (default `~/.pilotdeck/usage/daily`). Reads, refreshes and view/year changes never rewrite or prune these records. Ordinary application updates retain this separate user directory. Daily boundaries remain Asia/Shanghai; cumulative charts include records before the selected period. Only the preferred chart view is stored in browser storage. Validate with `node ui/e2e/usage-stats.smoke.mjs` against Vite on port 5187.
- Office preview and computer-use settings reuse the General page's cards and typography. Office path examples use the preview API's host `platform`, with a localized generic hint for older servers. An empty path enables automatic detection; edited paths must save successfully before checking. Run `node ui/e2e/integration-settings.smoke.mjs` against Vite on port 5187 for platform, save/retry, permission and layout checks using isolated synthetic data.
- Web and desktop skip account registration/login by default and use the built-in local user.
- Set `PILOTDECK_DISABLE_LOCAL_AUTH=0` (or `false`) before initial startup to require account authentication. Rebuild the client and restart the server after changing this setting. Values `1`/`true` or an unset/empty value disable login; unrecognized values keep authentication enabled.
- Web services keep their default `0.0.0.0` listener when accounts are disabled. Account-free access includes HTTP APIs, chat WebSocket and terminal WebSocket access. Server deployments must supply their own access boundary, such as private networking or an authenticated reverse proxy covering both HTTP and WebSocket routes; set `HOST=127.0.0.1` when only a local proxy should connect.
- Set `PILOTDECK_DISABLE_LOCAL_AUTH=0` to use built-in authentication instead of deployment-level authentication. Native-control origin/host checks remain supported.

Run from the repository root:

```sh
pnpm --dir ui dev
pnpm --dir ui typecheck
pnpm --dir ui test
pnpm --dir ui build
```

The import audit, `node scripts/audit-ui-reachability.mjs --exports`, reports review candidates only. Dynamic consumers and intentional test helpers need manual review before deletion. See [API references](../docs/README.md) and [test guidance](../docs/testing.md).
