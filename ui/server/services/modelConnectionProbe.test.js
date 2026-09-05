import { afterEach, describe, expect, it, vi } from 'vitest';
import { isValidImageColorAnswer, probeModelConnection } from './modelConnectionProbe.js';

afterEach(() => vi.restoreAllMocks());

describe('model connection probe request formats', () => {
  it.each([
    ['red', true],
    ['**red**', true],
    ['The color is red.', true],
    ['No, red.', false],
    ['I cannot tell whether it is red.', false],
    ['Not sure, maybe red.', false],
    ['red or blue', false],
    ['blue', false],
    ['infrared', false],
  ])('strictly validates the image-probe answer %j', (answer, expected) => {
    expect(isValidImageColorAnswer(answer, 'red')).toBe(expected);
  });

  for (const [protocol, response, assertBody] of [
    ['openai', { choices: [{ message: { content: 'red' } }] }, (body) => expect(body.messages[0].content[1].type).toBe('image_url')],
    ['openai-responses', { object: 'response', output_text: 'red' }, (body) => expect(body.input[0].content[1].type).toBe('input_image')],
    ['anthropic', { type: 'message', content: [{ type: 'text', text: 'red' }] }, (body) => expect(body.messages[0].content[1].source.type).toBe('base64')],
    ['google', { candidates: [{ content: { parts: [{ text: 'red' }] } }] }, (body) => expect(body.contents[0].parts[1].inlineData.mimeType).toBe('image/png')],
  ]) {
    it(`uses the ${protocol} image request shape`, async () => {
      let requestBody;
      vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify(response) };
      }));
      const result = await probeModelConnection({ protocol, baseUrl: 'https://example.test/v1', apiKey: 'key', model: 'test-model', image: true });
      expect(result).toMatchObject({ ok: true });
      assertBody(requestBody);
    });
  }

  it('returns the endpoint URL that passed the text probe after fallback', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url) === 'https://example.test/v1/chat/completions') {
        return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ ok: true }) };
      }
      return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) };
    }));

    const result = await probeModelConnection({ protocol: 'openai', baseUrl: 'https://example.test', apiKey: 'key', model: 'test-model' });

    expect(result).toMatchObject({
      ok: true,
      endpointUrl: 'https://example.test/chat/completions',
    });
    expect(calls).toEqual([
      'https://example.test/v1/chat/completions',
      'https://example.test/chat/completions',
    ]);
  });

  it('uses only the provided endpoint URL for image probes', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      calls.push(String(url));
      return { ok: true, status: 200, statusText: 'OK', text: async () => JSON.stringify({ choices: [{ message: { content: 'red' } }] }) };
    }));

    const result = await probeModelConnection({
      protocol: 'openai',
      baseUrl: 'https://example.test',
      endpointUrl: 'https://example.test/chat/completions',
      apiKey: 'key',
      model: 'test-model',
      image: true,
    });

    expect(result).toMatchObject({ ok: true, endpointUrl: 'https://example.test/chat/completions' });
    expect(calls).toEqual(['https://example.test/chat/completions']);
  });

  it.each(['colored', 'infrared'])(
    'does not accept %s as the red image-probe answer',
    async (content) => {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ choices: [{ message: { content } }] }),
      })));

      const result = await probeModelConnection({
        protocol: 'openai',
        baseUrl: 'https://example.test',
        endpointUrl: 'https://example.test/chat/completions',
        apiKey: 'key',
        model: 'test-model',
        image: true,
      });

      expect(result).toMatchObject({
        ok: false,
        imageUnsupported: false,
        code: 'IMAGE_CAPABILITY_UNKNOWN',
      });
    },
  );

  it('preserves an explicit image-unsupported response before endpoint fallback', async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 400, statusText: 'Bad Request', text: async () => JSON.stringify({ error: { message: 'This model does not support image input' } }) }));
    vi.stubGlobal('fetch', fetch);
    const result = await probeModelConnection({ protocol: 'anthropic', baseUrl: 'https://example.test', apiKey: 'key', model: 'test-model', image: true });
    expect(result).toMatchObject({ ok: false, imageUnsupported: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('classifies text-only content-type validation as image unsupported', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({ error: { message: "messages.content.type is invalid, allowed values: ['text']" } }),
    })));
    const result = await probeModelConnection({ protocol: 'openai', baseUrl: 'https://example.test', apiKey: 'key', model: 'test-model', image: true });
    expect(result).toMatchObject({ ok: false, imageUnsupported: true, code: 'IMAGE_TEST_FAILED' });
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

  it('reports its own timeout as a connection timeout instead of retry abort', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      })));
      const pending = probeModelConnection({
        protocol: 'openai',
        baseUrl: 'https://example.test/v1',
        apiKey: 'key',
        model: 'test-model',
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        code: 'ENDPOINT_UNREACHABLE',
        error: 'Connection timed out after 30s.',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
