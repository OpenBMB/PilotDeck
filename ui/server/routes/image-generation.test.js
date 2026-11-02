import express from 'express';
import { expect, it, vi } from 'vitest';
import { createImageGenerationRouter } from './image-generation.js';

it('does not reuse a masked key at a different API address or generate a billable image during a connection check', async () => {
  const upstream = vi.fn(async () => new Response('{}'));
  const app = express(); app.use(express.json());
  app.use(createImageGenerationRouter({ readConfig: () => ({ tools: { imageGeneration: { baseUrl: 'https://images.example/v1', apiKey: 'private-key' } } }), fetchImpl: upstream }));
  const server = app.listen(0);
  try {
    const url = `http://127.0.0.1:${server.address().port}/test`;
    const changed = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: '********', baseUrl: 'https://other.example/v1' }) });
    expect(changed.status).toBe(400); expect(upstream).not.toHaveBeenCalled();
    const same = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: '********', baseUrl: 'https://images.example/v1' }) });
    expect((await same.json()).ok).toBe(true);
    expect(upstream.mock.calls[0][0]).toBe('https://images.example/v1/models');
    expect(upstream.mock.calls[0][1].headers.authorization).toBe('Bearer private-key');
  } finally { await new Promise(resolve => server.close(resolve)); }
});
