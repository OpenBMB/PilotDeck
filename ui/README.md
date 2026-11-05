# Web application

React/Vite client and Express server used by browser and Electron deployments.

- Client entry: [src/main.jsx](src/main.jsx); active shell and screens live under [src/components](src/components).
- Server entry: [server/index.js](server/index.js); HTTP routes and services live under [server](server).
- Shared contracts: [shared](shared); real browser/Electron acceptance: [e2e](e2e).
- Account authentication remains required for supported self-hosted deployments. Desktop local-auth bypass is an explicit runtime policy, not a reason to remove login code.

Run from the repository root:

```sh
pnpm --dir ui dev
pnpm --dir ui typecheck
pnpm --dir ui test
pnpm --dir ui build
```

The import audit, `node scripts/audit-ui-reachability.mjs --exports`, reports review candidates only. Dynamic consumers and intentional test helpers need manual review before deletion. See [API references](../docs/README.md) and [test guidance](../docs/testing.md).
