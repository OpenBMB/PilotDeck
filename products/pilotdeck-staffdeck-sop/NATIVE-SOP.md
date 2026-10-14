# Native PilotDeck SOP host

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
