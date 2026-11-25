import { afterEach, describe, expect, it, vi } from 'vitest';
import { isValidImageColorAnswer, probeModelConnection } from './modelConnectionProbe.js';

afterEach(() => vi.restoreAllMocks());

describe('model connection probe request formats', () => {
  it.each([
    ['red', true],
    ['**red**', true],
    ['The color is red.', true],
    ['No, red.', true],
    ['I cannot tell whether it is red.', true],
    ['Not sure, maybe red.', true],
    ['red or blue', true],
    ['blue', false],
    ['infrared', true],
  ])('checks whether the final answer contains the requested color in the image-probe answer %j', (answer, expected) => {
    expect(isValidImageColorAnswer(answer, 'red')).toBe(expected);
  });

  it.each([
    ['google', { candidates: [{ content: { parts: [{ thought: true, text: 'red' }, { text: 'blue' }] } }] }, false],
    ['google', { candidates: [{ content: { parts: [{ thought: true, text: 'blue' }, { text: 'red' }] } }] }, true],
    ['anthropic', { type: 'message', content: [{ type: 'thinking', text: 'red' }, { type: 'text', text: 'blue' }] }, false],
    ['openai-responses', { object: 'response', output: [{ type: 'reasoning', content: [{ text: 'red' }] }, { type: 'message', content: [{ type: 'output_text', text: 'blue' }] }] }, false],
    ['openai-responses', { object: 'response', status: 'incomplete', output_text: 'red' }, false],
  ])('uses only completed final text for %s image detection', async (protocol, response, ok) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })));
    const result = await probeModelConnection({ protocol, baseUrl: 'https://example.test/v1', image: true, model: 'reasoner' });
    expect(result.ok).toBe(ok);
    expect(result.imageUnsupported).not.toBe(true);
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

  it.each([
    ['https://api.openai.com/v1', undefined, false, 'max_completion_tokens'],
    ['https://example.test/v1', 'https://api.openai.com/v1/chat/completions', true, 'max_completion_tokens'],
    ['https://example.test/v1', undefined, false, 'max_tokens'],
    ['https://api.openai.com/v1', 'https://example.test/v1/chat/completions', true, 'max_tokens'],
  ])('uses the token limit field for the actual probe endpoint (%s, %s, image=%s)', async (baseUrl, endpointUrl, image, field) => {
    const fetch = vi.fn(async () => Response.json({ choices: [{ message: { content: image ? 'red' : '1' } }] }));
    vi.stubGlobal('fetch', fetch);
    const result = await probeModelConnection({ protocol: 'openai', baseUrl, endpointUrl, model: 'test-model', image, maxTokens: 256 });

    expect(result.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body[field]).toBe(256);
    expect(body).not.toHaveProperty(field === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens');
  });

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

  it.each(['green', 'blue'])(
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
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        code: 'ENDPOINT_UNREACHABLE',
        error: 'Connection timed out after 60s.',
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

  it.each([
    ['final red with thinking', { choices: [{ message: { content: 'RED, red.', reasoning_content: 'It could be blue.' }, finish_reason: 'stop' }] }, true],
    ['reasoning red only', { choices: [{ message: { content: '', reasoning_content: 'red' }, finish_reason: 'stop' }] }, false],
    ['wrong final despite reasoning', { choices: [{ message: { content: 'blue', reasoning_content: 'red' }, finish_reason: 'stop' }] }, false],
    ['inline reasoning', { choices: [{ message: { content: '<think>red</think>blue' }, finish_reason: 'stop' }] }, false],
    ['unclosed reasoning', { choices: [{ message: { content: '<think>red' }, finish_reason: 'stop' }] }, false],
    ['truncated answer', { choices: [{ message: { content: 'red' }, finish_reason: 'length' }] }, false],
  ])('handles %s without forcing a thinking switch', async (_name, response, ok) => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(response), {status: 200}));
    vi.stubGlobal('fetch', fetch);
    const result = await probeModelConnection({protocol:'openai',baseUrl:'https://example.test/v1',image:true,model:'reasoner'});
    expect(result.ok).toBe(ok);
    expect(result.imageUnsupported).not.toBe(true);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.max_tokens).toBe(4096);
    expect(body).not.toHaveProperty('enable_thinking');
  });
