# Web application

React/Vite client and Express server used by browser and Electron deployments.

- Client entry: [src/main.jsx](src/main.jsx); active shell and screens live under [src/components](src/components).
- Server entry: [server/index.js](server/index.js); HTTP routes and services live under [server](server).
- Shared contracts: [shared](shared); real browser/Electron acceptance: [e2e](e2e).
- Chat Markdown renders Mermaid diagrams after a response finishes, with source/copy controls and a source fallback for invalid diagrams or external image nodes. The renderer is loaded on demand and uses strict security settings. Search locates diagram messages without modifying SVG labels; source view supports text highlighting.
- Account authentication remains required for supported self-hosted deployments. Desktop local-auth bypass is an explicit runtime policy, not a reason to remove login code.

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
