import type { WebSearchCustomProviderConfig } from './webSearchConfig.js';

const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const variables = ['query', 'limit', 'gl', 'apiKey'];
const token = /\{\{\s*([^{}]*?)\s*\}\}/g;
const forbidden = ['__proto__', 'prototype', 'constructor'];

/** JSON values are substituted before serialization, never evaluated as code. */
function render(value: unknown, vars: Record<string, string | number>, depth = 0): unknown {
  if (depth > 20) throw new Error('Search template nesting exceeds 20 levels.');
  if (typeof value === 'string') {
    const exact = /^\{\{\s*(\w+)\s*\}\}$/.exec(value);
    const get = (key: string) => {
      if (!variables.includes(key.trim())) throw new Error(`Unknown search variable: ${key}`);
      return vars[key.trim()];
    };
    if (exact) return get(exact[1]!);
    if (/\{\{|\}\}/.test(value.replace(token, ''))) throw new Error('Unclosed search template variable.');
    return value.replace(token, (_, key: string) => String(get(key)));
  }
  if (Array.isArray(value)) return value.map(item => render(item, vars, depth + 1));
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (forbidden.includes(key)) throw new Error('Unsafe search template property.');
    return [key, render(child, vars, depth + 1)];
  }));
  return value;
}

export function validateCustomSearch(config: WebSearchCustomProviderConfig): void {
  if (!record(config)) throw new Error('Custom search configuration must be an object.');
  if (config.auth && !['bearer', 'bodyApiKey', 'queryApiKey', 'headerApiKey', 'none'].includes(config.auth)) throw new Error('Invalid search authentication.');
  if (config.method && !['GET', 'POST'].includes(config.method)) throw new Error('Search method must be GET or POST.');
  if (config.bodyEncoding && !['json', 'form'].includes(config.bodyEncoding)) throw new Error('Search body encoding must be json or form.');
  for (const field of ['headers', 'queryParams', 'requestBody'] as const) {
    const value = config[field];
    if (value === undefined) continue;
    if (!record(value)) throw new Error(`${field} must be a JSON object.`);
    if (JSON.stringify(value).length > 32768) throw new Error(`${field} exceeds 32 KB.`);
    render(value, { query: 'test', limit: 3, gl: 'us', apiKey: 'test' });
    if (field !== 'requestBody' || config.bodyEncoding === 'form') {
      for (const item of Object.values(value)) {
        if (!['string', 'number', 'boolean'].includes(typeof item) || (field === 'headers' && typeof item !== 'string')) throw new Error(`${field} values must be ${field === 'headers' ? 'strings' : 'strings, numbers or booleans'}.`);
      }
    }
  }
  if (config.method === 'GET' && config.requestBody !== undefined) throw new Error('GET requests cannot have a request body. Use query parameters.');
  for (const key of Object.keys(config.headers ?? {})) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || /^(host|content-length|connection|transfer-encoding|cookie)$/i.test(key)) throw new Error('Invalid or unsupported search header name.');
  }
  if (config.auth === 'headerApiKey' && config.apiKeyParam && (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(config.apiKeyParam.trim()) || /^(host|content-length|connection|transfer-encoding|cookie)$/i.test(config.apiKeyParam.trim()))) throw new Error('Invalid API key header name.');
  if (Object.values(config.headers ?? {}).some(value => /[\r\n]/.test(value))) throw new Error('Search headers cannot contain line breaks.');
  for (const field of ['resultsPath', 'titleField', 'urlField', 'snippetField', 'sourceField', 'publishedAtField'] as const) {
    if (config[field]) pathSegments(config[field]);
  }
}

function pathSegments(path: string): string[] {
  if (path === '$') return [];
  const normalized = path.replace(/^\$\./, '').replace(/\[(\d+)\]/g, '.$1');
  if (!/^[\w-]+(?:\.[\w-]+)*$/.test(normalized) || normalized.split('.').some(key => forbidden.includes(key))) throw new Error('Invalid response path. Use dotted fields or array indexes, e.g. data.results or items[0].url.');
  return normalized.split('.');
}
export function readSearchPath(value: unknown, path: string): unknown {
  return pathSegments(path).reduce<unknown>((current, key) => current !== null && typeof current === 'object' && own(current, key) ? (current as Record<string, unknown>)[key] : undefined, value);
}

export function customSearchRequest(endpoint: string, config: WebSearchCustomProviderConfig, input: { query: string; limit: number; gl?: string; apiKey: string }) {
  validateCustomSearch(config);
  const vars = { ...input, gl: input.gl?.trim() || 'us' };
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Search endpoint must be an HTTP(S) URL without embedded credentials.');
  const method = config.method ?? 'POST';
  const auth = config.auth ?? 'bearer';
  const apiKeyParam = config.apiKeyParam?.trim() || 'api_key';
  if (forbidden.includes(apiKeyParam)) throw new Error('Invalid API key parameter.');
  if (!input.apiKey && (auth !== 'none' || /\{\{\s*apiKey\s*\}\}/.test(JSON.stringify(config)))) throw new Error('Search API key is required.');
  const headers = new Headers({ Accept: 'application/json' });
  for (const [key, value] of Object.entries(render(config.headers ?? {}, vars) as Record<string, string>)) headers.set(key, String(value));
  for (const [key, value] of Object.entries(render(config.queryParams ?? {}, vars) as Record<string, unknown>)) url.searchParams.set(key, String(value));
  const body = render(config.requestBody ?? {}, vars) as Record<string, unknown>;
  // Explicit templates describe the complete request; legacy settings keep their old defaults.
  if (config.queryParams === undefined && config.requestBody === undefined) {
    const queryParam = config.queryParam?.trim() || 'query';
    if (forbidden.includes(queryParam)) throw new Error('Invalid query parameter.');
    if (method === 'GET') { url.searchParams.set(queryParam, input.query); if (input.gl) url.searchParams.set('gl', input.gl); }
    else { body[queryParam] = input.query; if (input.gl) body.gl = input.gl; }
  }
  if (auth === 'bearer') headers.set('Authorization', `Bearer ${input.apiKey}`);
  if (auth === 'headerApiKey') headers.set(apiKeyParam, input.apiKey);
  if (auth === 'queryApiKey' || (auth === 'bodyApiKey' && method === 'GET')) url.searchParams.set(apiKeyParam, input.apiKey);
  if (auth === 'bodyApiKey' && method === 'POST') body[apiKeyParam] = input.apiKey;
  let serialized: string | undefined;
  if (method === 'POST') {
    headers.set('Content-Type', config.bodyEncoding === 'form' ? 'application/x-www-form-urlencoded' : 'application/json');
    serialized = config.bodyEncoding === 'form' ? new URLSearchParams(Object.entries(body).map(([key, value]) => [key, String(value)])).toString() : JSON.stringify(body);
  }
  return { url: url.toString(), init: { method, headers: Object.fromEntries(headers.entries()), ...(serialized === undefined ? {} : { body: serialized }) } satisfies RequestInit };
}

function autoResults(raw: unknown, depth = 0): unknown[] | undefined {
  if (depth > 20) return undefined;
  if (Array.isArray(raw)) return raw;
  if (!record(raw)) return undefined;
  for (const key of ['search_result', 'results', 'items', 'organic', 'organic_results', 'webPages', 'value', 'data']) {
    if (own(raw, key)) { const found = autoResults(raw[key], depth + 1); if (found) return found; }
  }
  return undefined;
}
export function customSearchResults(raw: unknown, config: WebSearchCustomProviderConfig, limit: number) {
  if (record(raw) && (raw.error || (raw.code !== undefined && ![0, '0', 200, '200'].includes(raw.code as string | number)))) throw new Error(`Search provider error: ${JSON.stringify(raw.error ?? raw.message ?? raw.msg ?? raw.code)}`);
  const items = config.resultsPath?.trim() ? readSearchPath(raw, config.resultsPath.trim()) : autoResults(raw);
  if (!Array.isArray(items)) throw new Error('Search response result list was not found. Check the results path.');
  const string = (value: unknown) => typeof value === 'string' ? value : Array.isArray(value) && value.every(v => typeof v === 'string') ? value.join('\n') : undefined;
  return items.slice(0, limit).map(item => {
    if (!record(item)) throw new Error('Search result must be an object. Check the results path.');
    const link = string(readSearchPath(item, config.urlField || 'url'));
    if (!link || !/^https?:\/\//i.test(link)) throw new Error('Search result URL is missing or invalid. Check the URL field mapping.');
    return { title: string(readSearchPath(item, config.titleField || 'title')), link,
      snippet: string(readSearchPath(item, config.snippetField || 'snippet')),
      source: string(readSearchPath(item, config.sourceField || 'source')),
      publishedAt: string(readSearchPath(item, config.publishedAtField || 'publishedAt')) };
  });
}
