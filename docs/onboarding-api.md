# Onboarding API

Local first-run configuration on the UI Server. Base URL: `http://127.0.0.1:{SERVER_PORT}/api/v1` (default port 3001). The [OpenAPI schema](pilotdeck-onboarding-api.openapi.yaml) is the canonical field/type reference; this guide records workflow and safety rules.

## Authentication and errors

Use `Authorization: Bearer <JWT>` and, when the instance sets `API_KEY`, `X-API-Key`. Missing JWT or invalid instance key returns 401; invalid JWT returns 403. Authentication uses `{ "error": "..." }`. Business errors use `{ "code": "...", "message": "...", "modelId": "..." }` where modelId may be absent/null. JSON is UTF-8; timestamps are ISO 8601 UTC. Credentials must not appear in responses or logs.

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/model-connection-tests` | Probe text and image support for 1–10 models |
| PUT | `/model-connection-tests/{testId}/image-capabilities` | Resolve every unknown image result |
| PUT | `/model-configuration` | Save a configuration matching a passed test |
| POST | `/workspaces` | Register an existing directory or create a workspace |

## Connection tests

Request fields are `providerId`, optional `protocol`/`endpoint`/`apiKey`, `models`, and a required `retryPolicy` object. Protocol values are `openai`, `openai-responses`, `anthropic`, `google`.

- Model IDs are trimmed, nonempty and unique; accept 1–10 entries.
- Built-in providers use the server catalog protocol/endpoint. Custom providers require their actual provider ID, a protocol and an absolute HTTP(S) endpoint; `custom` is reserved.
- API key is required except for Ollama. Settings-page masked-key reuse is a separate compatibility behavior; first-run clients do not submit a mask as a secret.
- Retry defaults: `maxRetries=2`, `maxStreamRetries=3`, `streamIdleTimeoutMs=30000`, `baseDelayMs=1000`, `maxDelayMs=60000`. Values are nonnegative integers; retry counts are at most 10, idle timeout at most 300000, delays at most 60000, and baseDelayMs must not exceed maxDelayMs.
- Text and image probes run for each model. HTTP 200 means execution completed; inspect business `status`: `passed`, `failed`, or `manual_input_required`. Text failure makes the aggregate fail; otherwise an unknown image result requires manual input. One model failure does not discard other results.
- Limits: three concurrent tests globally, one per user, ten requests and fifty requested models per minute per user. Test records expire after ten minutes. Disconnect cancels unfinished probes and releases the slot. Each new test request gets a new testId.

A result contains `testId`, `status`, `manualInputRequired`, per-model `textInput`/`imageInput` (`supported`, `unsupported`, `unknown`), `testedAt`, and optional errors. Input errors return 400; rate/concurrency limits return 429.

Manual confirmation submits `{ "models": [{ "modelId": "model-a", "imageInput": "supported" }] }`. Include every unknown model exactly once and no other model; only supported/unsupported are accepted. The updated record becomes passed only when text succeeds for every model and no image result remains unknown. A retry action can open this confirmation without repeating the probe. Repeating a complete confirmation does not create another record. Unknown/foreign records return 404; expired records return 410.

## Saving model configuration

`PUT /model-configuration` requires the testId, provider, complete model capability choices and retryPolicy from a passed, unexpired test owned by the caller. Provider, protocol, endpoint, model set, capabilities and retry policy must match. `models` entries contain `modelId`, boolean `textInput` and boolean `imageInput`.

- A new provider requires apiKey except for Ollama. For an existing provider, apiKey=null preserves its saved key; an empty string is invalid.
- The first model becomes agent.model. Keys are stored locally in pilotdeck.yaml and are never returned.
- Fresh onboarding leaves routing, memory and search disabled, resident projects inactive, and messaging integrations disabled. Re-onboarding preserves existing switches, resident projects and channels. Existing blocks without an enabled flag retain their legacy meaning; absent blocks default off.
- HTTP 200 returns configurationId and savedAt. Invalid input returns 400, an unknown/foreign test 404, an unpassed test 409 TEST_NOT_PASSED, mismatched content 409 CONFIGURATION_MISMATCH, and an expired test 410 TEST_EXPIRED.

## Workspaces

`POST /workspaces` accepts `type: existing|new`, an absolute local `path`, optional `githubUrl`, and optional `modelConfigurationId`.

- Existing paths must be accessible directories and cannot include githubUrl.
- New paths are created; a Git URL clones into the selected target and registers the actual repository directory. Clone is limited to one per user/two globally and five minutes. Disconnect stops owned Git processes and cleans only the staging directory created by that request.
- Omitted/null modelConfigurationId uses the current default; an explicit value must match the most recently saved configuration. Empty strings are invalid.
- Folder selection belongs to the desktop native picker; this HTTP API does not enumerate folders.
- HTTP 201 returns id, type, actual path and status=ready. Invalid/missing/unwritable paths return 400; conflicting paths/configuration return 409, and clone concurrency limits return 429. Authentication retains the 401/403 rules above. See the schema for full error definitions.

## Client workflow and resources

Probe, resolve unknown image capabilities, save the matching configuration, then register the workspace. A client must discard a stale tested snapshot if the form changes before saving, and disable snapshot-changing controls throughout a save. Custom provider IDs must not collide with built-in IDs or aliases.

Public brand resources are `/pilotdeck-logo-lockup-transparent.png`, `/pilotdeck-p-mark-transparent.png`, `/pilotdeck-p-mark-transparent-v2.png`, and provider SVGs under `/onboarding/providers/`. Provider paths and all schema components are verified by [resource tests](../ui/server/routes/onboardingResources.test.js). The image probe remains server-internal at `ui/server/assets/onboarding/image-capability-probe.png`.

Implementation: [onboarding routes](../ui/server/routes/onboarding.js), [shared model probes](../ui/server/services/modelConnectionProbe.js). Settings clients use the [model-pool API](model-pool-settings-api.md), whose persisted task workflow is separate from first-run onboarding.
