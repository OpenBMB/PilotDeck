# Model catalog

The engine, onboarding flow and model settings share one catalog. The application ships a generated baseline so config parsing and the initial model list work offline. Public metadata refreshes add current models without removing the metadata needed to resolve saved model IDs.

## Refresh and fallback

Opening model settings or onboarding reads the server cache and refreshes stale metadata in the background. The refresh button forces a refresh. CLI users can run `pilotdeck models refresh`; the next config load uses the new metadata.

The cache is `$PILOT_HOME/cache/model-catalog.json` (under the default PilotDeck home when `PILOT_HOME` is unset). Each source has a four-hour freshness interval and its own ETag. Concurrent refresh calls share a request. Responses have a 12-second timeout and a 32 MiB limit. Invalid responses and network failures retain the last valid data; a missing or damaged cache falls back to the bundled catalog. A newer bundled catalog takes precedence over an older cache.

Set `PILOTDECK_MODEL_CATALOG_NETWORK=0` to disable public catalog requests. Provider-specific model discovery still uses the configured provider endpoint and credentials when requested.

`GET /api/config/model-catalog` returns the cached selection list. `POST /api/config/model-catalog` refreshes it, accepting `{ "force": true }`. Both return `providers`, `updatedAt` and source-specific `errors`. Successful source updates can be used even if another source fails.

## Metadata and compatibility

The generator reads models.dev metadata for built-in providers and OpenRouter's public model list for OpenRouter. It normalizes token limits, input modalities, tool support, reasoning levels, prices and lifecycle status. Provider URLs, protocols and credential environment-variable names remain application-owned. Public catalog requests never include provider API keys.

Selection lists show active tool-capable models, plus the local Ollama presets. Deprecated and missing models remain resolvable for existing configurations but do not appear as new suggestions. Model searches match IDs, display names and aliases. Custom endpoints can discover their own models or use manually entered IDs.

New OpenAI configurations default to the Responses API. Existing explicit `protocol: openai` configurations continue to use Chat Completions. The protocol must support the chosen model's tool-calling API; changing a catalog entry does not rewrite saved protocol choices.

## Configuration precedence

For configured models, values resolve in this order, from lowest to highest priority:

1. Bundled model metadata (or protocol defaults for unknown models).
2. Valid, newer cached metadata.
3. Provider `modelOverrides` for the model ID.
4. Explicit values in the provider's `models` entry.

For example:

```yaml
model:
  providers:
    openai:
      modelOverrides:
        gpt-4.1-mini:
          capabilities:
            maxOutputTokens: 8192
      models:
        gpt-4.1-mini:
          capabilities:
            maxOutputTokens: 4096
```

The effective output limit is 4096. Overrides do not enable additional models; models must still be listed under `models`. Custom models remain text-only unless their configuration explicitly enables other input modalities.

## Updating the shipped baseline

Run `npm run models:update` to fetch, normalize and validate all sources, then atomically replace `src/model/catalog/bundled.generated.ts`. Review the resulting metadata changes before committing. A failed source prevents generation from replacing the existing file.

Run `npm run models:check` for offline validation. Web regression CI runs this check before building. The shared UI projection lives in `src/model/catalog/view.ts`; the runtime cache and refresh implementation live in `src/model/catalog/store.ts`.
