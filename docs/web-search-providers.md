# Web search providers

Enable **Settings → Search**, select a provider, enter its API key, then use
**Test connection**. API documentation/key links appear beside the provider.
Each provider's key and settings remain in the local configuration when switching
providers. Switching back restores its saved settings. Masked keys are reused only
for the same provider, endpoint and authentication settings.

| Provider | Credential environment variable | Official API contract |
| --- | --- | --- |
| DeepSeek Search | `DEEPSEEK_API_KEY` | [Search](https://api-docs.deepseek.com/api/search/) |
| GLM / Z.AI | `GLM_WEB_SEARCH_API_KEY` or `ZAI_API_KEY` | [Web Search](https://docs.z.ai/api-reference/tools/web-search) |
| Tavily | `TAVILY_API_KEY` | [Search](https://docs.tavily.com/documentation/api-reference/endpoint/search) |
| Serper (Google) | `SERPER_API_KEY` | [Serper](https://serper.dev/) |
| Brave Search | `BRAVE_API_KEY` | [Web Search](https://api-dashboard.search.brave.com/app/documentation/web-search/get-started) |
| Baidu AI Search | `BAIDU_WEB_SEARCH_API_KEY` | [Baidu Search](https://ai.baidu.com/ai-doc/AppBuilder/pmaxd1hvy) |
| Bocha Web Search | `BOCHA_API_KEY` | [Provider-maintained API reference](https://github.com/Bocha-Labs/bocha-skills/tree/main/bocha-web-search) |
| Exa | `EXA_API_KEY` | [Search](https://exa.ai/docs/reference/search) |
| SerpAPI | `SERPAPI_API_KEY` | [Search API](https://serpapi.com/search-api) |
| Custom | `CUSTOM_WEB_SEARCH_API_KEY` | Your endpoint's documentation |

SerpAPI provides access to the selected engine with a **SerpAPI key**. It does
not use a Google/Bing account key. Supported engine contracts:
[Google](https://serpapi.com/search-api), [Bing](https://serpapi.com/bing-search-api),
[Baidu](https://serpapi.com/baidu-search-api),
[DuckDuckGo](https://serpapi.com/duckduckgo-search-api),
[Yahoo](https://serpapi.com/yahoo-search-api),
[Yandex](https://serpapi.com/yandex-search-api).
Yahoo uses `p` for the query, Yandex uses `text`, and the other engines use `q`.
The optional `gl` country is sent only for Google. All results are capped locally.

Example:

```yaml
tools:
  webSearch:
    enabled: true
    provider: serpapi
    providers:
      serpapi:
        searchEngine: bing  # google (default), bing, baidu, duckduckgo, yahoo, yandex
        # apiKey can instead come from SERPAPI_API_KEY
      tavily:
        apiKey: "your-tavily-key"
```

Only the selected provider is used for connection tests and searches. The legacy
flat `apiKey`, `endpoint`, `searchEngine` and `customProvider` fields are still
accepted for the selected provider; the settings UI moves them into that provider's
entry on the next edit. A saved provider entry takes precedence over legacy fields.

Baidu uses the Qianfan `web_search` endpoint with Bearer authentication,
`search_source: baidu_search_v2` and web resources. Bocha uses
`https://api.bocha.cn/v1/web-search` with Bearer authentication. Exa uses
`x-api-key` and requests highlights for snippets. The connection probe and actual
search share these request/response adapters, including provider error detection.
Query-authenticated errors redact the key before returning to the UI or model.

Contract tests use synthetic responses and never contact paid APIs. To verify a
subscription, quota and regional connectivity, run Test connection with your own
provider key. The existing implicit environment-provider precedence is preserved;
selecting `provider` explicitly is recommended when several keys are configured.

DeepSeek Search uses `POST https://api.deepseek.com/v1/tools/search` with Bearer
API-key authentication, `query` (1–128 Unicode characters), `count`, and
`need_content: false`. Results include citations, summaries, site names and dates.
It uses the same request adapter for real searches and the settings connection test.
Changing a custom endpoint removes its saved key; enter the key for the new URL
before testing or searching. Other providers retain their saved settings.

## Custom HTTP adapters

The model continues to call `web_search({ query, gl? })`. The adapter, not the
model, constructs HTTP requests and handles secrets. Settings → Search → Custom
now exposes GET/POST, Bearer/header/body/query authentication, headers, query
parameters, JSON or form bodies and response-field mappings. Save the request
configuration before running Test connection. Preview request renders locally
with a placeholder key and makes no network call.

Start with one of the nine built-in provider examples, SearXNG or the Open WebUI
external-search contract, then adjust it to the server's documentation. SerpAPI's
example uses Google; change `engine` and the query field for another engine.
Examples are editable starting points, not an API compatibility guarantee.

Templates are JSON objects. Variables are supported in **values**:

| Variable | Value |
| --- | --- |
| `{{query}}` | The model's search text |
| `{{limit}}` | Maximum results requested; a standalone placeholder retains number type |
| `{{gl}}` | Country code, default `us` |
| `{{apiKey}}` | Saved provider credential; never put the literal key in a template |

Nested arrays/objects are supported in JSON bodies. Query parameters and form
bodies accept scalar values and are URL-encoded once. Substitution occurs before
JSON serialization, so quotes/newlines cannot break JSON and query text cannot
introduce further variables. No JavaScript or executable expressions run.

```yaml
tools:
  webSearch:
    enabled: true
    provider: custom
    providers:
      custom:
        endpoint: https://search.example/api
        # apiKey: stored through Settings, or CUSTOM_WEB_SEARCH_API_KEY
        customProvider:
          method: POST
          auth: headerApiKey
          apiKeyParam: X-API-Key
          headers:
            X-Client: PilotDeck
          requestBody:
            messages:
              - role: user
                content: "{{query}}"
            count: "{{limit}}"
          resultsPath: data.hits
          titleField: headline
          urlField: links[0].url
          snippetField: summary
```

Result paths use dotted names and numeric array indexes; `$` selects a root array.
This is a bounded path syntax, not full JSONPath. String arrays (e.g. Exa
highlights) are joined as snippets. An actual empty array is a successful empty
search; a missing list or invalid URL mapping is an error in both Test connection
and real searches. HTML/XML, OAuth exchanges, request signatures and multi-step
APIs require an HTTP adapter service; they cannot be described by this JSON form.

Legacy custom configs remain valid: when both `queryParams` and `requestBody` are
absent, `queryParam` (default `query`) is populated automatically. Explicit objects
describe the complete request. GET cannot have a body. JSON objects are limited
to 32 KB and 20 levels; unknown variables and unsafe property paths are rejected
when saving and again before requests. Endpoint/auth changes require re-entering
the saved key. Masked API responses preserve the key for unchanged endpoints.

Design references reviewed:

- [SearXNG JSON engine](https://docs.searxng.org/dev/engines/json_engine.html): configurable method, headers, body and result selectors.
- [Open WebUI external search](https://docs.openwebui.com/features/chat-conversations/web-search/providers/external/): stable query/count request and normalized result contract.
- [Dify tools](https://docs.dify.ai/en/cloud/use-dify/workspace/tools): API parameters described explicitly rather than inferred from a URL.

Contract tests exercise all examples with synthetic responses and a local HTTP
server; paid providers still require a user key for live account/quota validation.
