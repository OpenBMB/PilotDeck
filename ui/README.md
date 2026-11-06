# Web application

React/Vite client and Express server used by browser and Electron deployments.

- Client entry: [src/main.jsx](src/main.jsx); active shell and screens live under [src/components](src/components).
- Server entry: [server/index.js](server/index.js); HTTP routes and services live under [server](server).
- Shared contracts: [shared](shared); real browser/Electron acceptance: [e2e](e2e).
- Chat Markdown renders Mermaid diagrams after a response finishes, with source/copy controls and a source fallback for invalid diagrams or external image nodes. The renderer is loaded on demand and uses strict security settings. Search locates diagram messages without modifying SVG labels; source view supports text highlighting.
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

Mermaid browser regression: `pnpm --dir ui exec playwright test --config e2e/mermaid.config.mjs`.
It uses synthetic chat events and a local Vite server; set `PILOTDECK_TEST_BROWSER_CHANNEL=chrome` to use an installed Chrome instead of Playwright Chromium.

The import audit, `node scripts/audit-ui-reachability.mjs --exports`, reports review candidates only. Dynamic consumers and intentional test helpers need manual review before deletion. See [API references](../docs/README.md) and [test guidance](../docs/testing.md).
