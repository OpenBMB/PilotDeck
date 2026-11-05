# Model pool settings API

Base path: `/api/config` on the UI Server (default local port 3001). Use JSON and ISO 8601 UTC timestamps. JWT Bearer authentication is required; instances configured with API_KEY also require X-API-Key. Missing credentials return 401, invalid JWT 403, using `{ "error": "..." }`.

## Configuration reads and writes

| Method | Path | Contract |
| --- | --- | --- |
| GET | `/api/config` | Masked full configuration snapshot |
| PUT | `/api/config` | Validate, persist and reload a full configuration |
| POST | `/api/config/validate` | Validate without writing or reload |
| GET | `/api/config/model-references` | Current provider/model consumers |

A read returns exists, path, raw, revision, config and validation. Secrets are masked as `********`. Missing files report exists=false. Invalid YAML still returns a 200 snapshot with configDisabled, parseError and validation.valid=false; reading must not replace it with defaults.

A write accepts either raw YAML or structured config, with optional baseRevision, providerRenames, modelRenames and modelTestBindings. Preserve unrelated sections and recover masked keys only within their valid provider/endpoint scope. A stale baseRevision returns 409 CONFIG_CONFLICT with currentRevision. Successful writes return the updated snapshot and reload result; parse/validation/mask errors return 400, and unclassified write/reload failures return 500. Validate returns `{ valid, errors, warnings }`, HTTP 200 or 400, and has no persistence side effects.

Provider IDs and model IDs are exact, case-sensitive map keys. Display-name changes do not change identity. Rename metadata disambiguates a rename from removal plus insertion:

```json
{
  "providerRenames": [{"from": "provider-old", "to": "provider-new"}],
  "modelRenames": [{"providerId": "provider-new", "from": "model-old", "to": "model-new"}]
}
```

Metadata must match both maps. Missing sources, occupied targets, repeated or cross-provider model renames return 400 RENAME_INVALID. Under the configuration write lock, rename and reference updates succeed atomically for:

- agent.model, agent.subagents.default and memory.model;
- router.scenarios.*, router.fallback.*[], router.tokenSaver.judge and router.tokenSaver.tiers.*.model;
- router.stats.modelPricing keys and router.stats.baselineModel (object or supported legacy string).

Keep pricing values unchanged. GET model-references accepts providerId and optional modelId and returns path/value/kind entries without secrets. Saving must scan references again and reject an in-use deletion with 409 MODEL_IN_USE; a prior query or frontend confirmation is not sufficient protection.

## Model discovery and single-model probes

`POST /api/config/models` accepts providerId, providerType, baseUrl and apiKey. Provider types are openai, openai-responses, anthropic and google. A mask or empty key may reuse the saved credential for that provider; never forward the mask upstream. A missing baseUrl returns 400. Normalize and deduplicate upstream data[]/models[] into `{ "ok": true, "models": [{"id": "model-a", "displayName": "Model A"}] }`. Preserve upstream error status where available; report stable timeout errors.

`POST /api/config/test-connection` additionally takes model. Ollama requires baseUrl and model; other providers require a key. It probes text then image at the same endpoint. HTTP 200 includes business ok and imageSupport (`supported`, `unsupported`, `detection_failed`), supportsImage and imageCheckSource. Text probe failure also returns 200 with ok=false/error. Missing fields return 400. This compatibility endpoint does not persist a model configuration.

## Batch capability tests

`POST /api/config/test-connections` accepts:

```json
{
  "providerId": "openai", "protocol": "openai",
  "endpoint": "https://api.openai.com/v1", "apiKey": "<key>",
  "models": ["model-a"],
  "retryPolicy": {"maxRetries": 2, "maxStreamRetries": 3, "streamIdleTimeoutMs": 30000, "baseDelayMs": 1000, "maxDelayMs": 60000}
}
```

The retryPolicy object is required; its fields may be omitted for those defaults. Values are nonnegative integers; retry counts are at most 10, idle timeout at most 300000, delays at most 60000, and baseDelayMs<=maxDelayMs. Accept 1–10 trimmed, nonempty, unique model IDs.

Built-in providers use the catalog protocol. A nonempty endpoint overrides the default; absent/empty values use the catalog. Custom providers require protocol and an HTTP(S) endpoint. Ollama may omit its key; others require one. Saved masked keys are resolved server-side without exposure to the client.

HTTP 200 returns testId, status, manualInputRequired, models, testedAt and error. Each model contains modelId, textInput, imageInput and error. Capability values are supported/unsupported/unknown. Any text failure yields failed; all text passed plus an unknown image result yields manual_input_required; otherwise passed. One failed model does not suppress other results.

Limits are three concurrent tests globally, one per user, ten requests and fifty requested models per minute per user, and a ten-minute record TTL. Disconnect cancels unfinished work. Invalid input returns 400 INVALID_REQUEST; limits return 429 RATE_LIMITED. Each creation gets a new ID.

`PUT /api/config/test-connections/{testId}/image-capabilities` takes `{ "models": [{"modelId": "model-a", "imageInput": "supported"}] }`. Cover every unknown model exactly once and no other model. Recompute status without creating a record. Invalid input returns 400, missing/foreign records 404 TEST_NOT_FOUND, and expired records 410 TEST_EXPIRED.

## Optional result binding

Testing is optional for ordinary settings saves and primary-model selection. PUT /api/config may include `modelTestBindings: [{ "testId": "..." }]`. When supplied, each record must belong to the caller, be unexpired/passed and match the saved provider, effective endpoint, key and model set. Failures return TEST_NOT_FOUND, TEST_EXPIRED, TEST_NOT_PASSED or CONFIGURATION_MISMATCH without partial writes.

Valid binding persists per-model connectionTest metadata and synchronizes multimodal.input to `["text", "image"]` or `["text"]`. No test key is returned. An omitted provider URL resolves to its catalog default for runtime/Memory consumers; explicit URLs take precedence.

## Server-owned settings tasks

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/config/connection-test-tasks` | List the caller's tasks; no-store response |
| POST | `/api/config/connection-test-tasks` | Start from saved providerId and optional modelId |
| POST | `/api/config/connection-test-tasks/:id/retry` | Retry retained work/save |
| PUT | `/api/config/connection-test-tasks/:id/image-capabilities` | Supply manual image choices |
| POST | `/api/config/connection-test-tasks/:id/acknowledge` | Acknowledge a result |
| POST | `/api/config/connection-test-tasks/:id/cancel` | Cancel owned work |

Actions return 202 `{ task, tasks }` or a structured error. Snapshots are user-scoped and contain no credentials. Navigation and refresh reconnect to the backend-owned task; backend restart ends in-memory tasks. Manual/save-error states expire after ten minutes, other terminal states after an hour. Save under the latest configuration lock, preserve unrelated edits and reject changed provider inputs. Cancellation releases its slot after the probe settles.

Implementation: [config routes](../ui/server/routes/config.js), [model reference rewriting](../ui/server/services/modelReferences.js), [task manager](../ui/server/services/connectionTestTasks.js). Validation: [config route tests](../ui/server/routes/config.test.js). First-run compatibility paths are documented in [onboarding](onboarding-api.md).
