# Web search providers

Enable **Settings → Search**, select a provider, enter its API key, then use
**Test connection**. API documentation/key links appear beside the provider.
Switching providers clears the previous credentials. Keys remain in the local
configuration and masked keys are reused only for the same provider/endpoint.

| Provider | Credential environment variable | Official API contract |
| --- | --- | --- |
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
    searchEngine: bing  # google (default), bing, baidu, duckduckgo, yahoo, yandex
    # apiKey can instead come from SERPAPI_API_KEY
```

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
