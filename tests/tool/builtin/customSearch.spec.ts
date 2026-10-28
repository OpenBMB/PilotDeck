import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { customSearchRequest, customSearchResults, validateCustomSearch } from '../../../src/pilot/config/customSearch.js';
import { customSearchPreset, CUSTOM_SEARCH_PRESETS } from '../../../src/pilot/config/customSearchPresets.js';
import { createWebSearchTool } from '../../../src/tool/builtin/webSearch.js';
import { additionalSearchRequest } from '../../../src/tool/builtin/additionalWebSearch.js';

const query = '中文 "\\\n& x=1 {{apiKey}}';
const input = { query, limit: 8, gl: 'cn', apiKey: 'secret+/?' };
const endpoint = 'https://example.test/search?fixed=yes';
const context = { env: {}, cwd: '/', projectRoot: '/' } as any;
test('templates safely interpolate nested JSON, preserve number/boolean types and never recursively interpret queries', () => {
  const request = customSearchRequest(endpoint, { auth: 'headerApiKey', apiKeyParam: 'X-Key', requestBody: {
    messages: [{ role: 'user', content: '{{query}}' }], count: '{{limit}}', flag: true, prompt: 'Find: {{query}}', token: '{{apiKey}}',
  } }, input);
  assert.deepEqual(JSON.parse(request.init.body!), { messages: [{ role: 'user', content: query }], count: 8, flag: true, prompt: `Find: ${query}`, token: input.apiKey });
  assert.equal(request.init.headers['x-key'], input.apiKey);
});
test('GET and form bodies encode query/key exactly once and preserve fixed URL parameters', () => {
  const config = { method: 'GET' as const, auth: 'queryApiKey' as const, queryParams: { q: '{{query}}', count: '{{limit}}', country: '{{gl}}' } };
  const get = customSearchRequest(endpoint, config, input);
  const url = new URL(get.url);
  assert.equal(url.searchParams.get('q'), query); assert.equal(url.searchParams.get('api_key'), input.apiKey);
  assert.equal(url.searchParams.get('fixed'), 'yes'); assert.equal(url.searchParams.get('count'), '8');
  assert.equal(get.init.body, undefined);
  const form = customSearchRequest(endpoint, { auth: 'bodyApiKey', bodyEncoding: 'form', requestBody: { q: '{{query}}', count: '{{limit}}' } }, input);
  assert.equal(new URLSearchParams(form.init.body).get('q'), query);
  assert.equal(new URLSearchParams(form.init.body).get('api_key'), input.apiKey);
});
test('response mappings support root arrays, nested fields, indexes and string-array snippets', () => {
  const results = customSearchResults([{ meta: { title: 'Title' }, links: [{ href: 'https://example.test' }], chunks: ['one', 'two'] }],
    { resultsPath: '$', titleField: 'meta.title', urlField: 'links[0].href', snippetField: 'chunks' }, 1);
  assert.deepEqual(results[0], { title: 'Title', link: 'https://example.test', snippet: 'one\ntwo', source: undefined, publishedAt: undefined });
  assert.deepEqual(customSearchResults({ data: { results: [] } }, {}, 3), []);
  assert.throws(() => customSearchResults({ wrong: [] }, { resultsPath: 'data.results' }, 3), /result list/);
  assert.throws(() => customSearchResults({ results: [{ href: 'https://example.test' }] }, {}, 3), /URL/);
  assert.throws(() => customSearchResults({ error: { message: 'denied' } }, {}, 3), /provider error/);
  assert.deepEqual(customSearchResults({ code: 200, data: { results: [] } }, {}, 3), []);
});
test('rejects invalid templates, prototype access and invalid HTTP requests before fetching', () => {
  for (const config of [
    { requestBody: { q: '{{unknown}}' } }, { requestBody: { q: '{{unknown-name}}' } }, { requestBody: { q: '{{query' } }, { method: 'GET', requestBody: {} }, { requestBody: [] },
    { headers: { Host: 'evil' } }, { headers: { 'X-Key': 'line\nbreak' } },
    { headers: { 'X-Key': 1 } }, { queryParams: { q: {} } }, { resultsPath: '__proto__.results' },
    { resultsPath: 'items[*]' }, { bodyEncoding: 'form', requestBody: { nested: {} } },
    { requestBody: JSON.parse('{"__proto__":{"evil":true}}') }, { method: 'DELETE' },
  ]) assert.throws(() => validateCustomSearch(config as any));
  assert.throws(() => customSearchRequest('file:///secret', {}, input), /HTTP/);
  assert.throws(() => customSearchRequest('https://user:pass@example.test', {}, input), /credentials/);
  assert.throws(() => customSearchRequest(endpoint, { auth: 'none', headers: { 'X-Key': '{{apiKey}}' } }, { ...input, apiKey: '' }), /key is required/);
});
test('local HTTP server receives rendered requests and runtime enforces timeout without credentials leaking', async () => {
  const received: any[] = [];
  const server = createServer(async (req, res) => {
    if (req.url === '/slow') return;
    let body = ''; for await (const part of req) body += part;
    received.push({ method: req.method, headers: req.headers, body });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: { hits: [{ url: 'https://example.test', title: 'Local test', snippet: 'ok' }] } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const tool = createWebSearchTool({ provider: 'custom', endpoint: base + '/search', apiKey: input.apiKey,
      customProvider: { auth: 'headerApiKey', apiKeyParam: 'X-Key', bodyEncoding: 'form', requestBody: { q: '{{query}}', count: '{{limit}}' }, resultsPath: 'data.hits' } });
    const result = await tool.execute({ query }, context);
    assert.equal(result.data?.organic[0]?.title, 'Local test');
    assert.equal(received[0].headers['x-key'], input.apiKey);
    assert.equal(new URLSearchParams(received[0].body).get('q'), query);
    await assert.rejects(createWebSearchTool({ provider: 'custom', endpoint: base + '/slow', timeoutMs: 50, customProvider: { auth: 'none' } }).execute({ query: 'test' }, context), (error: any) => error.code === 'tool_timeout');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
for (const id of CUSTOM_SEARCH_PRESETS) test(`${id} preset builds a valid request and passes query/count correctly`, () => {
  const preset = customSearchPreset(id);
  const request = customSearchRequest(preset.endpoint || endpoint, preset.customProvider, input);
  assert.ok(request.url.startsWith('https://'));
  assert.ok(request.init.method === 'GET' ? [...new URL(request.url).searchParams.values()].includes(query) : request.init.body!.includes(JSON.stringify(query).slice(1, -1)));
  if (['deepseek', 'baidu', 'bocha', 'exa', 'serpapi'].includes(id)) {
    const builtin = additionalSearchRequest(id as any, { endpoint: preset.endpoint, ...input });
    assert.equal(new URL(request.url).origin + new URL(request.url).pathname, new URL(builtin.url).origin + new URL(builtin.url).pathname);
    assert.deepEqual(Object.fromEntries(new URL(request.url).searchParams), Object.fromEntries(new URL(builtin.url).searchParams));
    assert.deepEqual(new Headers(request.init.headers), new Headers(builtin.init.headers));
    assert.equal(request.init.body, builtin.init.body);
  }
});
test('real tool and shared adapter produce identical requests and redact failures', async () => {
  const custom = customSearchPreset('baidu').customProvider;
  const expected = customSearchRequest(endpoint, custom, input);
  const tool = createWebSearchTool({ provider: 'custom', endpoint, apiKey: input.apiKey, customProvider: custom, fetchImpl: async (url, init) => {
    assert.equal(url, expected.url); assert.equal(init?.body, expected.init.body);
    return new Response(JSON.stringify({ references: [{ title: 'Title', url: 'https://example.test', content: 'snippet' }] }));
  } });
  // The public tool trims whitespace around a query, but preserves embedded text.
  const output = await tool.execute({ query, gl: 'cn' }, context);
  assert.equal(output.data?.organic[0]?.snippet, 'snippet');
  for (const response of [new Response(`key=${input.apiKey}`, { status: 401 }), new Response(JSON.stringify({ error: `bad ${input.apiKey}` }))]) {
    await assert.rejects(createWebSearchTool({ provider: 'custom', endpoint, apiKey: input.apiKey, fetchImpl: async () => response }).execute({ query: 'test' }, context), error => {
      assert.ok(!String(error).includes(input.apiKey)); return true;
    });
  }
});
