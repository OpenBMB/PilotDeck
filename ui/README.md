# Web application

React/Vite client and Express server used by browser and Electron deployments.

- Client entry: [src/main.jsx](src/main.jsx); active shell and screens live under [src/components](src/components).
- Server entry: [server/index.js](server/index.js); HTTP routes and services live under [server](server).
- Shared contracts: [shared](shared); real browser/Electron acceptance: [e2e](e2e).
- [Form chrome](src/form-controls.css) owns select menus, checkbox/radio indicators and sliders. Keep semantic HTML controls and existing change handlers. Electron and Chromium 135+ use CSS `base-select` top-layer menus; other engines retain a functional native picker. Do not cover selects with transparent overlays. [Form events](src/lib/formControlEvents.ts) lets an open picker consume Escape before an enclosing dialog.
- [DateTimeField](src/components/ui/DateTimeField.tsx) supplies themed calendar/clock panels while retaining typed inputs, ISO date/time values and browser validation. File/directory selection and OS permission dialogs remain system-owned.
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
