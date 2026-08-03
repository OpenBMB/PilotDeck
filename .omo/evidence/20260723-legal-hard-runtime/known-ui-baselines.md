# Known UI Baselines

The complete UI test command and UI typecheck expose failures that are present on `origin/main` and are outside PR #437's runtime-hardening scope.

## Full UI Test

- Four `streamSmoother` assertions expect the previous synchronous-first-frame behavior.
- Four memory-route tests attempt to bundle `node:sqlite` under jsdom.
- Vitest collects Playwright files under `e2e/`.
- The implicated tests and configuration are byte-identical to `origin/main`.
- Excluding only those three baseline groups yields 293/293 passing tests.

## UI Typecheck

- The monorepo resolves both React 18 and React 19 type trees and reports existing source errors.
- Dependency and TypeScript configuration files are unchanged from `origin/main`.
- The production Vite build passes.

These are documented as upstream regression debt, not reclassified as successes and not folded into the legal-runtime PR.
