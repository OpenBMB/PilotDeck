# Quality Gates

PilotDeck uses one local command and one stable aggregate CI status for visibility.
CI currently runs on PRs but is not configured as a merge-required check.

The phased coverage and regression plan is maintained in
[`docs/test-quality-roadmap.md`](test-quality-roadmap.md). It defines which
pure modules may target 100%, which stateful modules use thresholds and
mutation proof, and which external paths remain nightly/deferred.

Durable behavior contracts are recorded in
[`docs/agent-notes/`](agent-notes/README.md). A code change that affects a
Gateway, router, model, file safety, tool, or UI state invariant must update
the relevant note together with its tests.

## Local Check

Use Node.js 22 and the pnpm version declared in the root `package.json`:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm check
```

`pnpm check` runs the root build and deterministic tests (including the
real-process Gateway smoke), UI lint and strict type checking, UI unit tests,
and the UI production build. Playwright and credentialed external tests remain
outside this deterministic check.

The repository also exposes focused layers used by CI and for local diagnosis:

```bash
corepack pnpm test:contract
corepack pnpm test:artifact
```

`test:contract` exercises the Gateway wire/event contract. `test:artifact`
loads only the compiled `dist` entry points and performs a plain Node Gateway
smoke, so a source-only test pass cannot hide a packaging or export failure.

Run the controlled browser smoke separately:

```bash
corepack pnpm --dir ui e2e
```

For manual historical regression evidence, run the mutation proof runner:

```bash
corepack pnpm test:regression-proof
corepack pnpm test:regression-proof -- --list
corepack pnpm test:regression-proof -- --case weixin-busy-queue
```

The runner builds a clean temporary copy for the baseline and every selected
case, reuses dependencies read-only, and removes all copies on exit. A case is
successful only when its baseline target passes and one exact reverse mutation
makes that named target fail. This is an audit command, not a required PR
check.

It creates a temporary `PILOT_HOME`, fake streaming provider and local stack;
no manually started Gateway or API is required. The non-blocking
`.github/workflows/browser-smoke.yml` job uses one Chromium worker, retries
once in CI, and retains traces/screenshots only on failure.

Credentialed tests use an explicit group and acknowledgement switch:

```bash
PILOTDECK_RUN_EXTERNAL=1 \
PILOTDECK_EXTERNAL_GROUP=model-protocol \
PILOT_HOME=/path/to/isolated-home \
corepack pnpm test:external
```

Valid groups are `model-protocol`, `agent-context-web`, `router-classify`, and
`wcb-docker`. Missing configuration or a required web-search key is an error,
not a skipped test. The `wcb-docker` group also requires
`PILOTDECK_EXTERNAL_DOCKER_IMAGE` and verifies that the freshly built image can
load the packaged Gateway runtime. `.github/workflows/external-nightly.yml`
runs all groups on a schedule or manual dispatch and uploads only redacted logs.

## Continuous Integration

`.github/workflows/ci.yml` runs static, unit, contract, build, and artifact gates
for pull requests targeting `main` and for pushes to `main`. The final
`All checks pass` job uses `if: always()` and fails unless every upstream gate
is successful. CI uses an isolated `PILOT_HOME` under the runner's temporary
directory and never reads a developer's local PilotDeck configuration. The
workflow is informational for merging until repository administrators enable
Branch Protection for it.

Browser smoke is intentionally non-required during its stabilization period.
The external nightly does not run for pull requests.

The stable aggregate status-check name, if enabled later, is:

```text
CI / All checks pass
```

## Branch Protection (Deferred)

A repository administrator can later configure the `main` branch or its ruleset to:

1. Require a pull request before merging.
2. Require `CI / All checks pass` to pass before merging.
3. Require branches to be up to date with `main` before merging.
4. Dismiss stale approvals when new commits are pushed, if review approval is enabled.

Branch protection is repository configuration and is intentionally not changed
by this workflow at the current stage.
