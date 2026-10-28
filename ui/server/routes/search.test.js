import assert from 'node:assert/strict';
import { test } from 'node:test';
import express from 'express';
import { createSearchRouter } from './search.js';
import { emptyResults } from '../services/search/searchCommon.js';

test('streaming and JSON share the authenticated search contract and validate before streaming', async () => {
  const app = express(); app.use(express.json());
  const calls = [];
  app.use('/search', (req, _res, next) => { req.user = { id: 42 }; next(); }, createSearchRouter(async (input, options) => {
    calls.push({ input, userKey: options.userKey }); const result = emptyResults();
    options.onUpdate?.(result); return result;
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/search/global';
  try {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'hello', stream: true }) });
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const text = await response.text(); assert.match(text, /event: snapshot/); assert.match(text, /event: done/);
    assert.equal(calls[0].userKey, '42');
    const json = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"query":"hello"}' });
    assert.deepEqual((await json.json()).counts, { chats: 0, files: 0 });
    const invalid = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"query":"","stream":true}' });
    assert.equal(invalid.status, 400); assert.match(invalid.headers.get('content-type'), /application\/json/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
