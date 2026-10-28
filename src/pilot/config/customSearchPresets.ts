import { WEB_SEARCH_ENDPOINTS, type WebSearchProvider } from './webSearchProviders.js';
import type { WebSearchCustomProviderConfig } from './webSearchConfig.js';

export const CUSTOM_SEARCH_PRESETS = ['deepseek', 'glm', 'tavily', 'serper', 'brave', 'baidu', 'bocha', 'exa', 'serpapi', 'searxng', 'openwebui'] as const;
export function customSearchPreset(id: typeof CUSTOM_SEARCH_PRESETS[number]): { endpoint: string; customProvider: WebSearchCustomProviderConfig } {
  const base: WebSearchCustomProviderConfig = { method: 'POST', auth: 'bearer', titleField: 'title', urlField: 'url', snippetField: 'snippet' };
  const configs: Record<typeof id, WebSearchCustomProviderConfig> = {
    deepseek: { requestBody: { query: '{{query}}', count: '{{limit}}', need_content: false }, resultsPath: 'results', snippetField: 'summary', sourceField: 'site_name', publishedAtField: 'date' },
    glm: { requestBody: { search_query: '{{query}}', count: '{{limit}}', search_engine: 'search-prime', search_recency_filter: 'noLimit' }, resultsPath: 'search_result', snippetField: 'content' },
    tavily: { auth: 'bodyApiKey', requestBody: { query: '{{query}}', max_results: '{{limit}}', include_answer: true, search_depth: 'basic' }, resultsPath: 'results', snippetField: 'content' },
    serper: { auth: 'headerApiKey', apiKeyParam: 'X-API-KEY', requestBody: { q: '{{query}}', num: '{{limit}}', gl: '{{gl}}' }, resultsPath: 'organic', urlField: 'link' },
    brave: { method: 'GET', auth: 'headerApiKey', apiKeyParam: 'X-Subscription-Token', queryParams: { q: '{{query}}', count: '{{limit}}', country: '{{gl}}' }, resultsPath: 'web.results', snippetField: 'description' },
    baidu: { requestBody: { messages: [{ role: 'user', content: '{{query}}' }], search_source: 'baidu_search_v2', resource_type_filter: [{ type: 'web', top_k: '{{limit}}' }] }, resultsPath: 'references', snippetField: 'content', publishedAtField: 'date' },
    bocha: { requestBody: { query: '{{query}}', count: '{{limit}}', freshness: 'noLimit', summary: true }, resultsPath: 'data.webPages.value', titleField: 'name', snippetField: 'summary', sourceField: 'siteName', publishedAtField: 'datePublished' },
    exa: { auth: 'headerApiKey', apiKeyParam: 'x-api-key', requestBody: { query: '{{query}}', numResults: '{{limit}}', type: 'auto', contents: { highlights: true, text: false } }, resultsPath: 'results', snippetField: 'highlights', publishedAtField: 'publishedDate' },
    serpapi: { method: 'GET', auth: 'queryApiKey', queryParams: { engine: 'google', q: '{{query}}', gl: '{{gl}}' }, resultsPath: 'organic_results', urlField: 'link' },
    searxng: { method: 'GET', auth: 'none', queryParams: { q: '{{query}}', format: 'json' }, resultsPath: 'results', snippetField: 'content' },
    openwebui: { requestBody: { query: '{{query}}', count: '{{limit}}' }, resultsPath: '$', urlField: 'link' },
  };
  return { endpoint: id === 'searxng' || id === 'openwebui' ? '' : WEB_SEARCH_ENDPOINTS[id as Exclude<WebSearchProvider, 'custom'>], customProvider: { ...base, ...configs[id] } };
}
