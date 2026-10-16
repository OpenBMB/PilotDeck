# PR 656 review and acceptance

Review target: `ebc265f03a6936f7124b9adf47a4a548822ea817`.
Fixes and verification were performed in an isolated PilotDeck worktree.

## Reproduced defects fixed

- Local setup read the wrong authentication database and resolved SQLite from
  the root package instead of the UI package. It now follows the Web service's
  configured database precedence and selects an existing active user.
- Managed startup removed explicitly configured hosted capability credentials
  whose environment names begin with `KM_` or `STAFFDECK_`. Only names declared
  by `capabilitiesFile` are restored to the child environment.
- An empty `agentMethods` still contacted KM, and capability discovery during
  tool registration had no timeout. Empty selections now return immediately;
  discovery respects the configured timeout.
- Agent cancellation did not reach knowledge HTTP requests. Query and management
  tools now forward cancellation through discovery and the dispatched request.
- Capability-advertised routes ignored camelCase resource IDs, including the
  existing citation `chunkId`. IDs are normalized before route interpolation.
- The legacy query/citation/call HTTP facade skipped capability negotiation,
  failing against minimal instances without spaces. Its space directory also
  returned entries outside the host binding. Both paths now use the same
  negotiated contract and configured space restriction as runtime requests.

The frontend generator regression expectation was updated for the renamed
`knowledge-core` module. The real Agent acceptance script now supports an
authenticated KM binding and reads full-preset Wiki pages through the catalog
route used by that preset.

## Focused verification

- `npm run build:web`: passed, including TypeScript compilation. Vite reports
  the existing large-chunk warning.
- Eight composition/gateway test files: 80 passed.
- Six UI route/frame/composition/supervisor test files: 54 passed.
- Local provisioning and frontend profile/generator tests: 14 passed.
- `git diff --check`: passed.

## Real acceptance

The companion KM wheel was installed into a fresh Python environment, outside
the StaffDeck source tree. The run uses actual hosted
`provider1/deepseek-v4-flash-0731` inference and PD file parsing, normal PD
registration/JWT login, KM bearer authentication, and dynamic loopback ports.
No fake provider or editable Python package is used in this run.

Final run: **passed**. `report.json` records hosted inference/parser, runtime
ingestion, stale-revision rejection, citation aliases, space filtering, the full
20-step desktop/mobile browser workflow, seven real Agent turns, restart
persistence and managed shutdown. There were no browser page errors or failed
knowledge requests. `agent-summary.json` records each required tool's actual
completion event and the final empty retrieval after archival. Screenshots:
`knowledge-desktop.png` and `knowledge-mobile.png`.

The model initially called `knowledge_list_documents` without a base ID. The
full-preset route rejected that input; the model retried with the provided base
ID and succeeded. This recovered argument error is preserved in the summary;
the pass does not imply that every model-generated call succeeded first try.

Reproduce after installing the companion wheel and configuring a real PD model:

```sh
KM_REVIEW_PYTHON=/absolute/path/to/venv/bin/python \
KM_BROWSER_HARNESS=/absolute/path/to/StaffDeck/packages/knowledge-ui/browser-acceptance.mjs \
PD_MODEL_CONFIG=/absolute/path/to/pilotdeck.yaml \
PD_MODEL_ID=provider/model \
node scripts/review-knowledge-acceptance.mjs
```

Raw service logs, temporary instance data and Agent trajectories are retained
under ignored `artifacts/pr656-review/`. The report and screenshots here contain
no configured credentials. This acceptance does not migrate production data or
verify Windows/Linux or bundled desktop Python deployment.
