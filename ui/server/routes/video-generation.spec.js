import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { VideoStore } from '../../../src/tool/builtin/videos/VideoStore.js';
import { createVideoGenerationRouter } from './video-generation.js';

const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(64)]);
async function fixture(run, fetchImpl) {
  const root = await mkdtemp(join(tmpdir(), 'video-route-')); const store = new VideoStore(root);
  const config = { enabled: false, apiKey: 'private-key', baseUrl: 'https://videos.example/v1', model: 'minimax-h3', extraParams: { task: 't2va', aspect_ratio: '16:9' } };
  const app = express(); app.use(express.json()); app.use(createVideoGenerationRouter({ store, readConfig: () => ({ tools: { videoGeneration: config } }), fetchImpl }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  try { await run({ base, store, config }); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
}
it('probes a real video while disabled with masked credentials without mutating saved opt-in', async () => {
  const upstream = vi.fn(async url => String(url).endsWith("/content") ? new Response(mp4) : new Response(JSON.stringify({ id: "one", status: "completed" })));
  await fixture(async ({ base, store, config }) => {
    const r = await fetch(base + '/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...config, apiKey: '********' }) });
    expect(await r.json()).toMatchObject({ ok: true, bytes: mp4.length });
    expect(config.enabled).toBe(false); expect(await store.list('connection-test')).toEqual([]);
    expect(upstream).toHaveBeenCalledTimes(2); expect(upstream.mock.calls[0][0]).toBe(config.baseUrl + "/videos");
    expect(upstream.mock.calls[0][1].headers.authorization).toBe('Bearer private-key');
    expect(JSON.parse(upstream.mock.calls[0][1].body.get('extra_params'))).toEqual(config.extraParams);
  }, upstream);
});
it('supports Range playback, downloads and session isolation even while generation is off', async () => {
  await fixture(async ({ base, store }) => {
    const video = await store.save('session', new Response(mp4)); const url = `${base}/session/${video.videoId}`;
    const response = await fetch(url, { headers: { range: 'bytes=4-11' } });
    expect(response.status).toBe(206); expect(response.headers.get('content-type')).toContain('video/mp4');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(mp4.subarray(4, 12));
    expect(response.headers.get('content-range')).toBe(`bytes 4-11/${mp4.length}`);
    expect((await fetch(url, { method: 'HEAD' })).headers.get('accept-ranges')).toBe('bytes');
    expect((await fetch(url, { headers: { range: 'bytes=9999-' } })).status).toBe(416);
    expect((await fetch(url + '?download=1')).headers.get('content-disposition')).toContain('.mp4');
    expect((await fetch(`${base}/other/${video.videoId}`)).status).toBe(404);
  });
});
it('rejects changed masked-key addresses and redacts errors from provider-specific envelopes', async () => {
  const upstream = vi.fn(async () => new Response(JSON.stringify({ code: 'disabled', message: 'disabled private-key' }), { status: 400 }));
  await fixture(async ({ base, config }) => {
    const post = v => fetch(base + '/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(v) });
    expect((await post({ ...config, apiKey: '********', baseUrl: 'https://other.example/v1' })).status).toBe(400);
    expect(upstream).not.toHaveBeenCalled();
    const result = await (await post({ ...config, apiKey: '********' })).json();
    expect(result.ok).toBe(false); expect(result.error).toContain('disabled'); expect(result.error).not.toContain('private-key');
    expect(upstream).toHaveBeenCalledTimes(1);
  }, upstream);
});
