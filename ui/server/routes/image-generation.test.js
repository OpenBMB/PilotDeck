import express from 'express';
import sharp from 'sharp';
import { expect, it, vi } from 'vitest';
import { createImageGenerationRouter } from './image-generation.js';

async function probe(run, upstream) {
  const saved = { enabled: false, baseUrl: 'https://images.example/v1', apiKey: 'private-key', model: 'saved-model' };
  const store = { save: vi.fn() };
  const app = express(); app.use(express.json());
  app.use(createImageGenerationRouter({ store, readConfig: () => ({ tools: { imageGeneration: saved } }), fetchImpl: upstream }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const url = 'http://127.0.0.1:' + server.address().port + '/test';
    const post = async submitted => {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: '********', baseUrl: saved.baseUrl, model: 'draft-model', ...submitted }) });
      return { status: response.status, body: await response.json() };
    };
    await run(post, saved, store);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
async function imageResponse() {
  const png = await sharp({ create: { width: 24, height: 16, channels: 3, background: 'blue' } }).png().toBuffer();
  return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }));
}

it('tests a real image request with the draft model while disabled, without saving an attachment or changing config', async () => {
  const upstream = vi.fn(imageResponse);
  await probe(async (post, saved, store) => {
    const result = await post({});
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, width: 24, height: 16 });
    expect(result.body.latencyMs).toBeGreaterThanOrEqual(0);
    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, init] = upstream.mock.calls[0];
    expect(url).toBe('https://images.example/v1/images/generations');
    expect(init.method).toBe('POST');
    expect(init.headers.authorization).toBe('Bearer private-key');
    expect(JSON.parse(init.body)).toEqual({ model: 'draft-model', prompt: expect.any(String), n: 1 });
    expect(saved.enabled).toBe(false); expect(saved.model).toBe('saved-model');
    expect(store.save).not.toHaveBeenCalled();
    expect(result.body).not.toHaveProperty('imageId');
  }, upstream);
});

it('rejects a missing model or a masked key at a changed API address before sending a request', async () => {
  const upstream = vi.fn(imageResponse);
  await probe(async post => {
    expect((await post({ model: '' })).status).toBe(400);
    const changed = await post({ baseUrl: 'https://other.example/v1' });
    expect(changed.status).toBe(400);
    expect(changed.body.error).toContain('new API key');
    expect(upstream).not.toHaveBeenCalled();
  }, upstream);
});

it('allows a new draft key and address without changing saved credentials', async () => {
  const upstream = vi.fn(imageResponse);
  await probe(async (post, saved) => {
    expect((await post({ apiKey: 'new-key', baseUrl: 'https://other.example/v1' })).body.ok).toBe(true);
    expect(upstream.mock.calls[0][0]).toBe('https://other.example/v1/images/generations');
    expect(upstream.mock.calls[0][1].headers.authorization).toBe('Bearer new-key');
    expect(saved.apiKey).toBe('private-key');
  }, upstream);
});

it.each([{}, { data: [{ b64_json: Buffer.from('not an image').toString('base64') }] }])('rejects an HTTP 200 response without decodable image data: %j', async payload => {
  const upstream = vi.fn(async () => new Response(JSON.stringify(payload)));
  await probe(async post => {
    const result = await post({});
    expect(result.status).toBe(400); expect(result.body.ok).toBe(false);
    expect(result.body.error.length).toBeGreaterThan(0);
    expect(upstream).toHaveBeenCalledTimes(1);
  }, upstream);
});

it('reports provider errors with credentials redacted and never retries image creation', async () => {
  const upstream = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'model unavailable for private-key' } }), { status: 400 }));
  await probe(async post => {
    const result = await post({});
    expect(result.body.error).toContain('HTTP 400');
    expect(result.body.error).toContain('model unavailable');
    expect(JSON.stringify(result.body)).not.toContain('private-key');
    expect(upstream).toHaveBeenCalledTimes(1);
  }, upstream);
});
