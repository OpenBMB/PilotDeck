# Project binding acceptance

Run only against disposable local data. These scripts create projects, resources,
accounts and agents; stop/restart their services; and temporarily mutate the fixture
database. They do not operate on a production deployment. Never point them at an
existing user installation. Do not run mutation, restart, compatibility, or browser
workflow scripts concurrently in one environment.
Do not rebuild PD while acceptance services are loading `dist`; the core build
removes and regenerates that directory. Finish the build before starting services.

## Prerequisites

- PD and sibling SD candidate checkouts; Node 22.13-22.x and their dependencies.
- SD Python environment with the backend, portable SOP runtime, SQLModel, uvicorn
  and pytest dependencies installed.
- `HARNESS_V3_ROOT` pointing to the prepared Harness checkout.
- Chrome or Playwright Chromium; `@playwright/test` is loaded from PD UI dependencies.
- Five free loopback ports. Database validation here is SQLite; it does not prove
  acceptance for another release database backend. The release backend for this
  recorded acceptance was confirmed by the user to be SQLite.

```sh
export STAFFDECK_CHECKOUT=/absolute/path/to/StaffDeck
export BINDING_QA_PYTHON=/absolute/path/to/prepared/venv/bin/python
export HARNESS_V3_ROOT=/absolute/path/to/deepseek-harness
```

Use `env -u NODE_OPTIONS` before Node/npm commands when the local preload is absent.
No credentials are printed. Runtime configuration and credentials remain private in
the generated `$QA_ROOT`, with restrictive file permissions.

## Reproduction

First build and run the focused L1 collection in a new private result directory:

```sh
export BINDING_QA_ROOT=$(mktemp -d -t binding-regression)
env -u NODE_OPTIONS node scripts/staffdeck-binding/regression.mjs
```

Then unset `BINDING_QA_ROOT` so `run.mjs` allocates a fresh full-service environment:

```sh
unset BINDING_QA_ROOT
BINDING_QA_PORT=25910 env -u NODE_OPTIONS node scripts/staffdeck-binding/run.mjs --keep
```

Set `BINDING_QA_ROOT` to the printed evidence directory. Run sequentially:

```sh
env -u NODE_OPTIONS node scripts/staffdeck-binding/concurrency.mjs
env -u NODE_OPTIONS node scripts/staffdeck-binding/gateway-crash.mjs
env -u NODE_OPTIONS node scripts/staffdeck-binding/integration.mjs
env -u NODE_OPTIONS node scripts/staffdeck-binding/faults.mjs
env -u NODE_OPTIONS node scripts/staffdeck-binding/jobs.mjs
env -u NODE_OPTIONS node scripts/staffdeck-binding/browser.mjs
env -u NODE_OPTIONS node scripts/staffdeck-binding/browser-switch.mjs
env -u NODE_OPTIONS node scripts/staffdeck-binding/browser-workflow.mjs
```

`integration.mjs` runs runtime, sync, SOP lifecycle, compatibility and upgrade in
order. `compatibility.mjs` intentionally creates C/D while project binding is off,
tests manual/explicit binding, temporarily selects a legacy fixed profile, then
restores the project profile. `upgrade.py` backs up SQLite into a separate copy,
removes the newly added mapping table from that copy, and boots the formal SD app.

`faults.mjs` temporarily revokes/reduces fixture credentials, archives/removes B,
checks ordinary chat and resource denial, restores the saved row, and redirects
the Web bridge to an unavailable loopback Gateway. The private mutation snapshot
is removed after successful restoration. After an interrupted run, execute
`mutate.py restore` with the same isolated `DATABASE_URL` and SD `PYTHONPATH`.

The concurrency worker's `before-commit` phase kills PD before its HTTP request,
not SD inside a transaction. SD's independent process-kill tests in
`backend/tests/test_project_agent_binding.py` cover flushed/uncommitted and
committed transaction boundaries. Workers substitute Gateway activation; formal
Gateway loading is checked separately by full-service registration/fault tests.
`gateway-crash.mjs` uses a transparent WebSocket proxy with the real compiled
Gateway and shared PILOT_HOME. It kills PD while reload is outstanding and after
the successful response is held, then checks stable recovery and database counts.

`browser-workflow.mjs` performs UI project creation, binding retry, refresh,
knowledge upload and SOP publication. The SOP draft is seeded through the real
management API; complete graphical SOP authoring is not asserted. `browser-switch`
delays a real A status response and switches to B using the sidebar. Unit tests
cover late ensure responses and duplicate-click merging.

The completion scripts must run sequentially in that environment:

```sh
export BINDING_QA_RUN_LABEL=completion
env -u NODE_OPTIONS node scripts/staffdeck-binding/faults-complete.mjs
env -u NODE_OPTIONS node scripts/staffdeck-binding/identity-complete.mjs
env -u NODE_OPTIONS node scripts/staffdeck-binding/resources-complete.mjs
env -u NODE_OPTIONS node scripts/staffdeck-binding/browser-editor.mjs
env -u NODE_OPTIONS node scripts/staffdeck-binding/discovery-faults.mjs
```

`browser-editor.mjs` performs graphical authoring from a blank UI project at both
viewport sizes, edits a unique SOP ID and node instruction, saves, publishes and
archives. It installs a deterministic loopback authoring model in SD's isolated
database. Build the browser with the formal host profile before starting it:

```sh
PILOTDECK_CONFIG_PATH="$PWD/products/pilotdeck-staffdeck-sop/profiles/formal-host.yaml" \
  env -u NODE_OPTIONS -u PILOTDECK_FRONTEND_PROFILE npm --prefix ui run build
```

The private runtime config initially disables SOP/knowledge until a project is
bound; it is not the static frontend build profile. `regression.mjs` selects the
formal host frontend profile when running against an existing QA environment.
`discovery-faults.mjs` needs SD backend `PYTHONPATH` for its database count reader.
It verifies the complete binding file and counts, so no other script may mutate
that environment during its delay.

## Real Model

Allocate another environment/port range. Supply a valid private model config and
choose its registered provider/model ID; the config is read locally and never
exported. Real queries can incur provider charges.

```sh
unset BINDING_QA_ROOT
BINDING_QA_PORT=25710 BINDING_QA_REAL_CONFIG=/private/path/pilotdeck.yaml \
  BINDING_QA_REAL_MODEL=provider/model env -u NODE_OPTIONS \
  node scripts/staffdeck-binding/run.mjs --real --keep
export BINDING_QA_ROOT=/printed/real/environment
env -u NODE_OPTIONS node scripts/staffdeck-binding/knowledge.mjs
BINDING_QA_REPETITIONS=3 env -u NODE_OPTIONS node scripts/staffdeck-binding/runtime.mjs
env -u NODE_OPTIONS node scripts/staffdeck-binding/chat.mjs
BINDING_QA_RUN_LABEL=first BINDING_QA_REQUIRED_KNOWLEDGE=true \
  env -u NODE_OPTIONS node scripts/staffdeck-binding/special-runtime.mjs
```

Every case uses a new session. `special-runtime` creates the real PD owner through
the existing registration route, publishes a private knowledge SOP and approval
SOP, switches to B, restarts SD/Gateway, and uses the existing approval receipt
plus a normal follow-up turn. `BINDING_QA_ONLY=knowledge|approvals` selects a group;

Run `chat.mjs` before publishing the private SOP: otherwise discovery can legally
select that SOP and invalidate the ordinary-chat negative fixture. Labels preserve
the first results. Browser approval and legacy compatibility use the same supported
approval routes and real model:

```sh
BINDING_QA_RUN_LABEL=browser BINDING_QA_ONLY=approvals \
  BINDING_QA_BROWSER_APPROVAL=true BINDING_QA_REPETITIONS=2 \
  env -u NODE_OPTIONS node scripts/staffdeck-binding/special-runtime.mjs
BINDING_QA_RUN_LABEL=legacy BINDING_QA_ONLY=approvals \
  BINDING_QA_LEGACY=true BINDING_QA_REPETITIONS=1 \
  env -u NODE_OPTIONS node scripts/staffdeck-binding/special-runtime.mjs
```

Browser repetitions select desktop then mobile and run both decisions. Legacy
mode restores the original config in `finally`, requires `bound` with the same
agent and unchanged database counts, and exports its separate persisted states.

`observe.mjs` temporarily places loopback proxies before SD and the selected model,
then runs three repetitions of ordinary chat before publishing private SOPs and
running authorized retrieval/approvals. Use a fresh fixture. It records wire tool
choice, returned tool names, finish reasons, catalog/model/JSON repair/plan repair
timing, and route/session/request correlation,
without headers or conversation content. It restores the private config and service
ports in `finally`. Set `BINDING_QA_RUN_LABEL` to preserve previous results and
`BINDING_QA_OBSERVE_PORT` to a free pair of ports (default 26710/26711).

```sh
BINDING_QA_RUN_LABEL=discovery90 BINDING_QA_OBSERVE_PORT=26720 \
  env -u NODE_OPTIONS node scripts/staffdeck-binding/observe.mjs
```

`discovery-faults.mjs` checks delayed requests, cancellation, injected HTTP 503 and
recovery through the formal SD route, asserting unchanged bindings/database counts.
Project mode defaults to a separate 90000ms discovery deadline; SOP runtime calls
retain their 30000ms default. Explicit valid timeouts override their own defaults.
`BINDING_QA_RUN_LABEL` preserves results across corrective runs. Keep the first
failure. A later successful repetition does not waive it.

After the observer finishes, validate the existing trace without making new model
requests. This asserts all six scenario groups passed three times, completed SOP
states, route deadlines and one-to-one callback/wire correlation:

```sh
BINDING_QA_RUN_LABEL=discovery90 env -u NODE_OPTIONS \
  node scripts/staffdeck-binding/validate-observation.mjs
```

## Evidence And Cleanup

```sh
env -u NODE_OPTIONS node scripts/staffdeck-binding/export.mjs \
  "$BINDING_QA_ROOT" docs/testing/evidence/staffdeck-binding-2026-10-13/run-name
```

The exporter allows result JSON, selected event JSON, sanitized PD state and
reviewed screenshots. It excludes databases, raw logs, env/config, credentials and
model captures. Review screenshots and exported JSON before sharing. Private L1
logs are retained outside the repo; exported summaries include commands/timings.

After exporting completion environments under `l2-completion` and `l3-completion`,
generate the per-case index:

```sh
env -u NODE_OPTIONS node scripts/staffdeck-binding/completion-report.mjs \
  docs/testing/evidence/staffdeck-binding-2026-10-13
```

Without `--keep`, `run.mjs` stops its own services after finishing. Kept services
are identified in `$QA_ROOT/pids.json`; stop only those task PIDs, wait for exit,
then use SIGKILL for a remaining task process. `restart.mjs` applies this sequence
and launches the same isolated entrypoints. Verify listener PID after restarting.
Do not stop another checkout's services or delete fixture data before retaining
the required evidence.

Current acceptance status: see the dated report in `docs/testing/`.
