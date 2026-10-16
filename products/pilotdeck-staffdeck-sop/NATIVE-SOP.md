# Native PilotDeck SOP host

## One-command startup without Docker

Requires Node 22.13+ (22.x), pnpm, Python 3.11+ with venv/pip, and an existing PD
profile with model credentials and normal owner login. Install JS dependencies
once using `pnpm install`. Add the following to the native SOP binding below:

```yaml
    localRuntime:
      enabled: true
      python: python3
      knowledgeEnabled: false
      versionManagementEnabled: true
```

Then run from the PD repository:

```bash
PILOTDECK_CONFIG_PATH=/absolute/path/pilotdeck.yaml pnpm start:sop
```

This builds Gateway/Web with that profile and starts managed SOP + Web + Gateway.
The SOP endpoint in YAML must be a free loopback HTTP origin, for example
`http://127.0.0.1:8091`. No StaffDeck checkout or Docker daemon is needed.
On first start PD creates `$PILOT_HOME/sop-runtime/venv`, installs its bundled
`packages/sop-runtime` Python package (network needed for initial dependencies),
and waits for Runtime health before starting Web. Later starts reuse the venv.
SQLite and the generated publisher token remain under `$PILOT_HOME/sop-runtime`
(default `~/.pilotdeck/sop-runtime`); stopping PD preserves them.
Ctrl+C stops all owned processes. A failed Runtime startup prevents PD startup;
an unexpected Runtime exit stops the managed PD processes. An occupied endpoint
is rejected rather than silently using another Runtime. Existing independent
services should keep `localRuntime` absent/disabled, or be stopped first.
Existing `pnpm dev` and `pnpm --dir ui start:built` also manage Runtime when enabled.
Changing local Runtime options requires restarting the supervisor.

The bundled Python source is synchronized from the standalone portable package
using `node scripts/sync-sop-runtime.mjs /path/to/portable_sop`; only Python Core
and Runtime files are copied, never the StaffDeck backend.

Set `modules.sop.hostAdapter: pilotdeck` to use PD owner identity, native management and automatic continuation. Existing profiles default to `staffdeck` and retain their normal StaffDeck approval adapter.

```yaml
modules:
  sop:
    enabled: true
    hostAdapter: pilotdeck
    implementationId: portable-sop
    contract: sop.lifecycle/v3
    transport: sop-http-v3
    endpoint: http://127.0.0.1:8091
    manifestPath: /healthz
    defaultSopId: release
    capabilityBindings:
      - kind: tool
        capabilityId: release-evidence
        toolName: read_file
  knowledge:
    enabled: false
```

Install `portable_sop` in its own Python environment. Runtime uses `SOP_RUNTIME_DB` and `SOP_PUBLISH_TOKEN`; PD Web uses the matching server-only `SOP_RUNTIME_PUBLISH_TOKEN`. Keep the Gateway token, model credentials and installation JWT secret in PD. Build Web with the same `PILOTDECK_CONFIG_PATH` used by Web and Gateway. No StaffDeck origin, admission credential, user token or API key is needed. Enable normal owner login with `PILOTDECK_DISABLE_LOCAL_AUTH=0`.

The native `/sop` page lists drafts and publications, generates and rewrites using PD's model port, edits the shared graph, publishes immutable versions, displays version details, archives, deletes and moves the publication pointer back to an existing version. Local JSON files enter through explicit import. Generated content is saved as a draft and never automatically published. Draft writes include their original revision. Subflows resolve published immutable child versions at publication.

Use `/sop release` in a project conversation. New sessions read the published Runtime catalog; ongoing sessions retain their saved version. Required Tool/Skill/Knowledge declarations use `node.capability_refs.required_tool_ids`, `required_general_skill_ids` and `required_knowledge_base_ids`. Each logical ID must bind to a callable PD tool of the declared kind. Successful calls produce scoped receipts; missing bindings or failed calls cannot satisfy the requirement. Knowledge is replaceable through this binding and does not start a StaffDeck authority.

Human nodes set `assignee_ref: pilotdeck:owner`. Management normalizes this to the Core node field. Only the active owner authenticated by the existing PD login can approve an admitted project session. The approval form retains the original wait, revision and request ID. The Web outbox persists the resume command before calling Gateway, returns after the Runtime receipt, and automatically submits continuation through the normal Web/Gateway path. A persisted Gateway run ID prevents accepted executions from being submitted again after Web restarts. Unaccepted tasks retry after restart; definitively rejected commands remain failed. An interrupted already accepted Gateway run is not silently rerun.

The Web bridge also persists its server-owned interaction binding. After a Web restart, continuation reconnects with that exact proof before submitting; stale proofs remain rejected by Gateway. Browser input cannot supply or replace this binding.

Generation jobs and SSE event sequences live in Runtime SQLite. A new PD worker marks former unfinished jobs interrupted; the user retries them. One invalid model result receives one repair attempt. Neither failure nor cancellation overwrites the saved draft. Browser reconnects replay persisted events.

Focused validation includes `portable_sop/tests`, `tests/sop/portable-sop-runtime.spec.ts`, `tests/composition/pilotdeck-native-approval.spec.ts`, and `ui/server/{native-sop-service,sop-continuations,pilotdeck-approval-authority}.test.mjs`. Real Knowledge queries, production migration and Feishu acceptance are separate from native SOP acceptance.

Runtime deployment switches `SOP_KNOWLEDGE_ENABLED` and
`SOP_VERSION_MANAGEMENT_ENABLED` default to `true` and take effect after Runtime
restart. Native capabilities, generation and the graph editor use the same
`features` policy. Knowledge-off rejects knowledge-dependent publications and
execution, including child SOPs. Version-off hides manual version/history/rollback
and rejects history/rollback API calls; editing and publishing still create
immutable internal snapshots. Reenabling restores historical versions.
The accepted local deployment uses knowledge **off**, version management **on**.
See [incremental acceptance](ACCEPTANCE-FEATURES-1014.zh-CN.md) for the four-policy,
desktop/mobile and real-model evidence; real knowledge queries were cancelled.
