# Search settings API

Search settings live at tools.webSearch. GET/PUT `/api/config` and POST `/api/config/validate` share the authenticated [configuration snapshot/write contract](../model-pool-settings-api.md#configuration-reads-and-writes). Provider wire formats and custom result mapping are canonical in [Web search providers](../web-search-providers.md).

## Configuration

| Field | Contract |
| --- | --- |
| enabled | Explicit false disables the tool and skips validation of inactive search subfields |
| provider | deepseek, glm, tavily, serper, brave, baidu, bocha, exa, serpapi or custom |
| providers.<provider> | Separate saved apiKey, endpoint, searchEngine and customProvider per provider |
| searchEngine | SerpAPI engine, default google, with bing, baidu, duckduckgo, yahoo and yandex also supported |
| apiKey | Legacy/current provider key, masked on read; environment injection remains supported |
| endpoint | Optional built-in endpoint override; must be HTTP(S); custom requires one at runtime/test time |
| customProvider | Request/auth/result mapping for custom services |

Switching providers preserves other saved entries. Existing per-provider values take precedence over legacy top-level fields; form editing migrates legacy values into their original provider. Mask reuse requires matching provider, endpoint and authentication scope for both saving and probing.

Unknown fields warn. Malformed providers and active non-HTTP(S) endpoints are fatal. Inactive raw YAML is retained by the general configuration layer. An explicit provider wins. A legacy key without a provider defaults to glm. Otherwise the first available environment credential follows the order in [resolveProvider](../../src/tool/builtin/webSearch.ts). Supported IDs and SerpAPI engines are defined by the shared [provider registry](../../src/pilot/config/webSearchProviders.ts).

Custom mapping defaults: name=custom, auth=bearer (also bodyApiKey/queryApiKey/none), method=POST (or GET), queryParam=query, apiKeyParam=api_key, empty resultsPath for common-field fallback, and title/url/snippet/source/publishedAt field names. See the provider reference for request examples.

## Connectivity probe

`POST /api/config/test-web-search` accepts provider, apiKey, endpoint, optional customProvider and optional searchEngine. Omitted provider defaults to glm for this compatibility endpoint. A `********` key may resolve the caller's saved credential only in the same provider/endpoint/auth scope. Changes require a new key. Responses redact the key.

The server probes the fixed query hello, with a 15-second timeout and at most two network retries. Each request is independent. It writes no configuration and creates no persistent test ID or result binding.

- Success returns HTTP 200 `{ "ok": true, "latencyMs": 123, "organicCount": 3 }`.
- Upstream HTTP/business errors and timeouts return HTTP 200 with ok=false, error and optional latencyMs.
- Unsupported providers, missing required keys, a missing custom endpoint, invalid HTTP(S) URLs or unsafe mask reuse return HTTP 400 with ok=false/error.

The runtime web_search tool uses the same provider contracts and normalizes results to `{ query, organic[] }`. Serper places gl in its body; Brave maps it to the country query parameter.

Implementation: [config routes](../../ui/server/routes/config.js), [search parser](../../src/pilot/config/parseToolsConfig.ts), [search tool](../../src/tool/builtin/webSearch.ts), [settings UI](../../ui/src/components/settings/view/agentSearch). Cover all provider methods/authentication, defaults, result normalization, error/timeout paths and form switching with deterministic fixtures. Live service checks require explicit opt-in.
