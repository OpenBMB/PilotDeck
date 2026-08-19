import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeModelConnection } from './modelConnectionProbe.js';

afterEach(() => vi.restoreAllMocks());

describe('model connection probe request formats', () => {
  for (const [protocol, response, assertBody] of [
    ['openai', { choices: [{ message: { content: 'ok' } }] }, (body) => expect(body.messages[0].content[1].type).toBe('image_url')],
    ['openai-responses', { object: 'response', output_text: 'ok' }, (body) => expect(body.input[0].content[1].type).toBe('input_image')],
    ['anthropic', { type: 'message', content: [{ type: 'text', text: 'ok' }] }, (body) => expect(body.messages[0].content[1].source.type).toBe('base64')],
    ['google', { candidates: [{ content: { parts: [{ text: 'ok' }] } }] }, (body) => expect(body.contents[0].parts[1].inlineData.mimeType).toBe('image/png')],
  ]) {
    it(`uses the ${protocol} image request shape`, async () => {
      let requestBody;
      vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(response) };
      }));
      const result = await probeModelConnection({ protocol, baseUrl: 'https://example.test/v1', apiKey: 'key', model: 'test-model', image: true });
      expect(result).toEqual({ ok: true });
      assertBody(requestBody);
    });
  }

  it('preserves an explicit image-unsupported response before endpoint fallback', async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 400, statusText: 'Bad Request', text: async () => JSON.stringify({ error: { message: 'This model does not support image input' } }) }));
    vi.stubGlobal('fetch', fetch);
    const result = await probeModelConnection({ protocol: 'anthropic', baseUrl: 'https://example.test', apiKey: 'key', model: 'test-model', image: true });
    expect(result).toMatchObject({ ok: false, imageUnsupported: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('cancels an active probe when its caller aborts', async () => {
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
    })));
    const controller = new AbortController();
    const reason = new Error('request closed');
    const pending = probeModelConnection({ protocol: 'openai', baseUrl: 'https://example.test/v1', apiKey: 'key', model: 'test-model', signal: controller.signal });
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});
