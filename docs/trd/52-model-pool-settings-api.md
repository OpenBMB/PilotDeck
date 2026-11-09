# Model pool configuration boundary

Canonical HTTP contract: [model pool API](../model-pool-settings-api.md). This page identifies shared ownership and invariants rather than duplicating request schemas.

- [Config routes](../../ui/server/routes/config.js) own settings saves and server-side test tasks. [Onboarding routes](../../ui/server/routes/onboarding.js) retain first-run compatibility endpoints.
- Provider/model map keys are identities; display names are labels. Explicit rename metadata and all reference rewrites share the configuration write lock.
- [Model reference scanning](../../ui/server/services/modelReferences.js) covers agent, subagent, memory, route/fallback/judge/tier selections, baseline model and pricing keys. Preserve numeric prices and reject referenced removals during the actual save.
- Testing is optional for ordinary settings saves. Supplied test bindings must match the current user, unexpired passed record and effective provider settings. They update connectionTest and multimodal.input atomically.
- Saved masks are resolved server-side only in the correct credential scope. Config changes must not expose keys through test snapshots, reference responses or logs.
- Settings tasks survive page navigation/refresh while their backend lives. Restart ends in-memory tasks. Cancellation, manual confirmation and failed-save retries retain the documented slot/expiry boundaries.

Validation: [config route tests](../../ui/server/routes/config.test.js), [onboarding tests](../../ui/server/routes/onboarding.test.js) and the [model parser](../../src/model/config/parseModelConfig.ts). External-provider acceptance is an explicit opt-in check.
