# PilotDeck + StaffDeck SOP

Seven-slot external example: `profiles/example-seven-external.yaml` binds every
slot to an unregistered implementation. The exporter preserves these bindings
and lists the required external endpoints in the generated README.

> 当前验收状态：**NOT READY**（七插槽可插拔目标尚未签收）。本目录已
> 具备固定 PilotDeck AgentLoop + Tools + Model Provider + StaffDeck SOP
> 的部分 glue、导出和真实部署证据；这不等于 Skill、Context/Compaction
> 或 StaffDeck Knowledge Management 已支持未知实现接入。

This product profile keeps AgentLoop, model providers, tools, sessions and
durable state in PilotDeck. The StaffDeck container is a stateless SOP
transition service. PilotDeck snapshots every session's selected SOP
definition and state under `PILOT_HOME/sop`.

From this directory:

```bash
cp .env.example .env
docker compose up --build
```

## Exported Deployment

The shipped `profiles/staffdeck-sop.yaml` selects the supported composition:
PilotDeck AgentLoop, model provider and tools plus the StaffDeck SOP module.
Create a self-contained deployment directory with:

```bash
npm run export:staffdeck-sop -- --profile products/pilotdeck-staffdeck-sop/profiles/staffdeck-sop.yaml --out /tmp/pilotdeck-staffdeck-export
```

The export copies the required PilotDeck and StaffDeck sources, writes a
container-local module profile, and includes only the SOP runtime when the YAML
enables it. Start it from the output directory with the generated `compose.yaml`.
The generated Compose file keeps `sop-runtime` and each configured model
provider host out of any Docker-inherited outbound proxy, so in-network SOP
requests and direct provider access remain routable. For the non-exported
local Compose profile, set `PILOTDECK_NO_PROXY` when using a non-OpenAI
provider endpoint.

Set `PILOTDECK_API_KEY` in `.env`. The default `STAFFDECK_SOP_RUNTIME_CONTEXT`
expects the `codex/portable-sop-runtime` checkout beside the PilotDeck
checkout. An exported deployment can point it at the released portable SOP
runtime source, or replace the `sop-runtime.build` block with a published
image.

The shipped profile uses the generic `operator_approval` SOP. It requires only
the existing StaffDeck handoff lifecycle and no business-tool binding. Point
`modules.sop.definitionsPath` and `defaultSopId` at an organization-owned SOP
when deploying a business workflow. Any declared business capability remains a
PilotDeck tool dependency: missing capabilities fail explicitly instead of
falling back to StaffDeck-owned tools, knowledge bases, channels, or sessions.

The broader target has seven slots: `agentLoop`, `skills`, `tools`, `context`,
`modelProvider`, `sop`, and `knowledge`. Compaction is part of `context`.
Only a slot with a published contract, resolver/binding, owner parity evidence,
and an independent unknown-implementation conformance test may be called
pluggable. See [ACCEPTANCE.md](ACCEPTANCE.md) for the current decision and
[ACCEPTANCE_REQUIREMENTS.md](ACCEPTANCE_REQUIREMENTS.md) for the release gates.

## Protocol conformance example

`profiles/example-sop-external.yaml` demonstrates an unregistered SOP
implementation. It uses the same `sop.lifecycle/v2` contract but does not
import StaffDeck or require a PilotDeck factory entry. Build PilotDeck first,
then run the independent cross-process conformance check:

```bash
PATH=/Users/a1/.nvm/versions/node/v22.13.1/bin:$PATH \
PYTHON_BIN=/path/to/python \
node products/pilotdeck-staffdeck-sop/conformance/run-sop-conformance.mjs
```

The check performs a real `prepare`, a completed `submit`, and a business
rejection. It is protocol conformance evidence only; it does not claim parity
with StaffDeck's complete SOP owner. Protocol-bound modules can declare
`deployment.mode: build`, `image`, or `external`; legacy `provider: staffdeck`
continues to emit the managed StaffDeck sidecar.

Handoff and external-task recovery is deliberately two-stage. The host first
accepts the result through `POST /api/sop/resume`; the returned message is then
submitted through the ordinary PilotDeck chat path. This keeps StaffDeck's
`prepare`/`submit` transitions and PilotDeck's AgentLoop unchanged.

SOP replies use a host-owned delivery journal in the same per-session state
file. A StaffDeck state transition and its pending reply are committed
together. If the process stops before reply durability or before the terminal
event, the next turn finishes that delivery without invoking the model or
submitting the SOP transition again. PilotDeck's transcript replay ignores the
old incomplete turn, so the recovered completed turn exposes one visible
reply.

## macOS deterministic E2E

Run `./scripts/run-local-e2e.sh` from this directory. It creates a temporary
Python environment, installs the StaffDeck backend module, starts its thin SOP
HTTP adapter, then
executes the focused composition tests, the Gateway HTTP matrix, and the
cross-process resume smoke with a deterministic model and PilotDeck tools. The
suite covers ordinary tool failure/retry, model interruption and cancellation,
the three reply/state crash windows, disabled composition, concurrent turns,
handoff/external resume, runtime HTTP/protocol/timeout faults, and restart
deduplication. The test leaves neither SOP state nor services behind. It
requires Node 22 and an installed PilotDeck dependency tree.

The historical StaffDeck semantic parity gate remains `BLOCKED` on
`codex/dsh-pluggable-runtime`: that branch does not contain
`tools/agent-loop-parity/` or `tools/real-deployment-e2e.py`. This deployment
suite is evidence for the pluggable SOP composition, not a substitute for the
missing legacy-vs-current StaffDeck harness.

## Browser smoke

Build the web application, then start the isolated browser fixture:

```bash
npm run build:web
./products/pilotdeck-staffdeck-sop/scripts/run-local-web-smoke.sh
```

Open `http://localhost:13001`, start a conversation, and send any message. The
fixture exercises a real PilotDeck `read_file` call, advances to a StaffDeck
handoff, and shows the SOP continuation control. Refresh the page while it is
waiting, enter `Browser operator approved`, select Continue, then send the
prepared message through the normal composer. The final reply is
`Browser SOP smoke completed.`

To verify that the SOP module is not an operational dependency when disabled,
run the same fixture with:

```bash
PILOTDECK_WEB_SMOKE_SOP_ENABLED=false ./products/pilotdeck-staffdeck-sop/scripts/run-local-web-smoke.sh
```

The ordinary `read_file` turn completes without starting the StaffDeck sidecar
or rendering an SOP wait control.

## Exported browser smoke

Run the self-contained exported Compose browser smoke with:

```bash
node ./products/pilotdeck-staffdeck-sop/scripts/run-exported-web-smoke.mjs
```

It launches a local deterministic OpenAI-compatible test server, exports the
generic `operator_approval` profile, builds and starts that export, and checks
desktop plus 390x844 handoff/refresh/resume completion. It removes the test
Compose project and volume on exit, while retaining completion screenshots in
its emitted temporary artifact directory. Set `PLAYWRIGHT_EXECUTABLE_PATH` when the
installed Playwright package and locally cached Chromium revisions differ.
To exercise the SOP-disabled export too, set
`PILOTDECK_EXPORTED_WEB_SOP_ENABLED=false` (and use a different
`PILOTDECK_EXPORTED_WEB_PORT` if another smoke is running).

## Real-model smoke

With a working provider already configured in a separate PilotDeck home and a
StaffDeck SOP runtime listening locally:

```bash
REAL_MODEL_SOURCE_PILOT_HOME=/path/to/configured/pilot-home \
REAL_MODEL_SMOKE_MODEL=provider/model \
STAFFDECK_SOP_SMOKE_ENDPOINT=http://127.0.0.1:8091 \
node products/pilotdeck-staffdeck-sop/scripts/run-real-model-smoke.mjs
```

This runs a real-model PilotDeck `read_file` business-tool call, StaffDeck
handoff, host resume, and completion turn without copying provider credentials
into test artifacts.

For the local PilotDeck home, run it together with the isolated StaffDeck
adapter and deterministic regression gates:

```bash
PILOTDECK_RUN_REAL_MODEL_SMOKE=1 \
REAL_MODEL_SOURCE_PILOT_HOME=/Users/a1/.pilotdeck \
./products/pilotdeck-staffdeck-sop/scripts/run-local-e2e.sh
```
