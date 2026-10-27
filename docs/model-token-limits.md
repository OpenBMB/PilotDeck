# Model token limit resolution (#685)

Context and output limits resolve independently in this order:

1. Explicit user configuration.
2. Positive metadata from the configured provider endpoint.
3. The engine model catalog, including aliases.
4. Protocol defaults.

`src/model/metadata/tokenLimits.ts` is a browser-safe shared normalizer and
resolver. Input-only limits from Anthropic and Gemini are used directly as
`maxContextTokens`; output is not added to input. Missing, null, fractional,
non-finite and non-positive metadata fields do not override the next layer.

## Discovery and offline behavior

`/api/config/models` retains the token metadata instead of dropping everything
except ID and name. Anthropic and Gemini lists follow cursors with a bounded
page count and reject repeated cursors. Requests retain the existing credential
scope checks and use the provider URL for all pagination requests.

DashScope's official hosts additionally query `/api/v1/models` for `model_info`.
An unavailable supplemental endpoint does not break ID discovery. Custom proxies
use the same field map without making requests to an unrelated official host.

Opening one model's settings calls `/api/config/model-limits`. For Ollama this
performs one `/api/show` request, with `num_ctx` taking precedence over the model
architecture's context length. Listing Ollama models never calls show per model.
No output limit is invented from an Ollama context limit.

Successful discoveries are cached in
`$PILOT_HOME/cache/provider-model-limits.json`, separately from `pilotdeck.yaml`.
The cache contains only model IDs and validated numeric limits, scoped by
provider ID, protocol and endpoint. Inference and discovery URLs such as `/v1`
and `/models` share a scope. Configuration parsing reads this cache synchronously
without network access, so server restarts and headless use retain the metadata.
A successful cache update requests a gateway configuration reload. Offline or
damaged-cache reads fall back to the model catalog and protocol defaults.

## Saving and legacy configuration

The dialog labels each limit's source and updates untouched fields when provider
metadata arrives. It preserves edits made during the lookup. Saving compares the
submitted values to the resolved non-user values. Equal values are omitted from
`capabilities`; differing values are stored with a per-field marker:

```yaml
models:
  deepseek-chat:
    capabilities:
      maxContextTokens: 128000
      maxOutputTokens: 32768
    tokenLimitOverrides:
      maxContextTokens: true
      maxOutputTokens: true
```

An old configuration containing exactly both protocol defaults, without an
explicit marker, stops overriding a differing provider/catalog value. This is
an in-memory interpretation, not an automatic rewrite of the user's YAML.
Other user values, including a single overridden field, retain priority. Users
can deliberately save the old default pair again after upgrading, or use
“Use automatic token limits” to remove their overrides.

## Relationship to #682

This change does not import or replace #682's remote catalog store, generated
catalog, refresh hooks, model overrides, or selection rules. The provider
metadata cache is a separate higher-priority layer and must remain separate
from #682's `model-catalog.json` cache.

Before #682 lands, UI model capabilities and aliases are derived from the engine
catalog instead of copied into a hand-maintained UI subset. Provider presentation
fields remain local. OpenRouter's small fallback suggestion list references
engine entries rather than duplicating their token limits.

Both changes touch config parsing, ProviderCard, modelListApi and the UI catalog
adapter. When merging them, retain #682's catalog snapshot injection and refresh
hooks, call the shared provider normalizer, and retain #685's metadata resolver,
cache input, explicit override markers and non-user-value save comparison.
`/model-limits` must use #682's active catalog snapshot when that store is present.
No #682 commit is required for this branch to build or run.

## Validation

Targeted tests cover provider field maps, per-field fallback, user priority,
legacy-pair recovery and deliberate pins, metadata persistence and endpoint
isolation, damaged/offline caches, pagination, DashScope enrichment, on-demand
Ollama metadata, source labels, asynchronous dialog updates, and automatic-value
omission on save. Tests inject provider responses; they do not make paid model
requests or claim validation against every live provider.

### Compatibility rehearsal

A temporary worktree combined this fix with #682 at
`5f5f9186c4774b8770acdedda2e9566d60e64085`. The four overlapping files above
required manual merge resolution. Both sets of imports and parsing inputs were
retained; #682's UI catalog adapter and refresh hooks were kept, and the new
`/model-limits` lookup was changed to pass `readCatalogSnapshot().catalog` to
`lookupCatalogModel`. The combined engine type check, 145 model tests, 149 config
route tests, 74 UI tests and Web production build passed. This is an integration rehearsal,
not a merge of #682 into the repair branch; later changes to that PR need a new
check.

### Main-branch checks

The repair branch passed 135 model-layer tests, 149 config-route tests and 89
settings/onboarding/shared-API UI tests, engine TypeScript compilation, and engine
and Web production builds. The full UI type check still reports 546 existing
errors, mainly React 18/19 type incompatibilities. Running the same check on
unmodified `main` at `5862db79` produced the identical diagnostic set after
normalizing source paths and line numbers; this fix adds no UI type errors.
