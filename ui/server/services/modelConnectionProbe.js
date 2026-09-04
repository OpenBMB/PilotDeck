import {
  buildProviderChatEndpointCandidates,
  isExpectedProviderResponseShape,
} from '../../../src/model/providerEndpoint.js';
import { NetworkFetchError, networkFetch } from '../../../src/network/fetch.js';
import { deflateSync } from 'node:zlib';
import { randomInt } from 'node:crypto';

const TIMEOUT_MS = 30_000;
const IMAGE_COLORS = {
  red: [220, 48, 48],
  blue: [40, 96, 220],
  green: [36, 168, 72],
  yellow: [232, 196, 40],
};
const IMAGE_COLOR_NAMES = Object.keys(IMAGE_COLORS);
const IMAGE_PROMPT = 'What color is the shape in this image? Reply with one English color word.';

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodeSolidPng([red, green, blue], size = 32) {
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x += 1) {
      row[1 + x * 3] = red;
      row[2 + x * 3] = green;
      row[3 + x * 3] = blue;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function createImageCapabilityProbe() {
  const color = process.env.VITEST ? 'red' : IMAGE_COLOR_NAMES[randomInt(IMAGE_COLOR_NAMES.length)];
  return {
    color,
    prompt: IMAGE_PROMPT,
    data: encodeSolidPng(IMAGE_COLORS[color]).toString('base64'),
  };
}

function hasErrorFinish(body, protocol) {
  if (body?.error || body?.status === 'failed') return true;
  if (protocol === 'google') {
    return (body?.candidates || []).some((candidate) => String(candidate?.finishReason || '').toLowerCase() === 'error');
  }
  if (protocol === 'openai') {
    return (body?.choices || []).some((choice) => String(choice?.finish_reason || '').toLowerCase() === 'error');
  }
  return String(body?.stop_reason || '').toLowerCase() === 'error';
}

function extractProbeText(body, protocol) {
  const chunks = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim()) chunks.push(value);
  };
  if (protocol === 'anthropic') {
    for (const part of body?.content || []) push(part?.text);
  } else if (protocol === 'google') {
    for (const candidate of body?.candidates || []) {
      for (const part of candidate?.content?.parts || []) push(part?.text);
    }
  } else if (protocol === 'openai-responses') {
    push(body?.output_text);
    for (const item of body?.output || []) {
      for (const part of item?.content || []) {
        push(part?.text);
        push(part?.output_text);
      }
    }
  } else {
    for (const choice of body?.choices || []) {
      const content = choice?.message?.content;
      if (typeof content === 'string') push(content);
      else if (Array.isArray(content)) {
        for (const part of content) push(part?.text);
      }
      push(choice?.message?.reasoning_content);
      push(choice?.message?.reasoning);
      push(choice?.text);
    }
  }
  return chunks.join(' ');
}

function hasUsableOutput(body, protocol) {
  return Boolean(extractProbeText(body, protocol).trim());
}

function describedTestImage(body, protocol, color) {
  const words = extractProbeText(body, protocol).toLowerCase().match(/[a-z]+/g) || [];
  return words.includes(String(color).toLowerCase());
}

function isFallbackStatus(status) {
  return status === 400 || status === 404 || status === 405;
}

function responseDetail(responseText, response) {
  try {
    const body = JSON.parse(responseText);
    return body?.error?.message || body?.error?.type || body?.message || `${response.status} ${response.statusText}`;
  } catch {
    return responseText || `${response.status} ${response.statusText}`;
  }
}

function looksLikeImageUnsupported(detail) {
  return /(?:image|vision|multimodal).{0,60}(?:not supported|unsupported|not enabled|not available)|(?:not supported|unsupported|does not support).{0,60}(?:image|vision|multimodal)|(?:content\.type|content type).{0,60}allowed values?\s*:\s*\[\s*['"]text['"]\s*\]/i.test(detail);
}

function classifyProbeError(detail, status) {
  if (status === 401 || status === 403 || /api.?key|authentication|unauthori[sz]ed/i.test(detail)) return 'INVALID_API_KEY';
  if (status === 404 || /model.+not found|unknown model|does not exist/i.test(detail)) return 'MODEL_NOT_FOUND';
  return 'ENDPOINT_UNREACHABLE';
}

function requestFor({ protocol, apiKey, model, image, maxTokens, imageProbe }) {
  const text = image ? imageProbe.prompt : 'Reply exactly: 1';
  const imageData = imageProbe?.data;
  if (protocol === 'google') {
    return {
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      body: { contents: [{ role: 'user', parts: image
        ? [{ text }, { inlineData: { mimeType: 'image/png', data: imageData } }]
        : [{ text }] }], generationConfig: { maxOutputTokens: maxTokens } },
    };
  }
  if (protocol === 'anthropic') {
    return {
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: { model, max_tokens: maxTokens, messages: [{ role: 'user', content: image
        ? [{ type: 'text', text }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } }]
        : text }] },
    };
  }
  if (protocol === 'openai-responses') {
    return {
      headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), 'content-type': 'application/json' },
      body: { model, max_output_tokens: maxTokens, store: false, input: image
        ? [{ role: 'user', content: [{ type: 'input_text', text }, { type: 'input_image', image_url: `data:image/png;base64,${imageData}` }] }]
        : text },
    };
  }
  return {
    headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), 'content-type': 'application/json' },
    body: { model, max_tokens: maxTokens, messages: [{ role: 'user', content: image
      ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: `data:image/png;base64,${imageData}` } }]
      : text }] },
  };
}

/**
 * Executes one text or image probe without retaining API keys or upstream bodies.
 */
// Onboarding needs enough output budget for reasoning models to emit their
// visible answer. The legacy config endpoint passes its historical 8/16 value.
export async function probeModelConnection({ protocol, baseUrl, endpointUrl, apiKey = '', model, image = false, maxTokens = 256, signal, retryPolicy = {} }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new NetworkFetchError('network_timeout', 'Connection timed out.')), TIMEOUT_MS);
  const forwardAbort = () => controller.abort(signal.reason);
  if (signal?.aborted) forwardAbort();
  else signal?.addEventListener('abort', forwardAbort, { once: true });
  const imageProbe = image ? createImageCapabilityProbe() : null;
  try {
    const urls = endpointUrl ? [endpointUrl] : buildProviderChatEndpointCandidates({ protocol, baseUrl, model });
    const request = requestFor({ protocol, apiKey, model, image, maxTokens, imageProbe });
    let last = null;
    for (const url of urls) {
      const response = await networkFetch(url, {
        method: 'POST', headers: request.headers, body: JSON.stringify(request.body), signal: controller.signal,
      }, {
        signal: controller.signal, fetchImpl: fetch,
        retry: {
          maxRetries: Number.isInteger(retryPolicy?.maxRetries) ? retryPolicy.maxRetries : 2,
          baseDelayMs: Number.isInteger(retryPolicy?.baseDelayMs) ? retryPolicy.baseDelayMs : 500,
          maxDelayMs: Number.isInteger(retryPolicy?.maxDelayMs) ? retryPolicy.maxDelayMs : 5_000,
          retryOnPost: true,
        },
      });
      const responseText = await response.text();
      if (response.ok) {
        let body;
        try { body = JSON.parse(responseText); } catch { body = null; }
        if (isExpectedProviderResponseShape(protocol, body) && !hasErrorFinish(body, protocol) && hasUsableOutput(body, protocol)) {
          if (image && imageProbe && !describedTestImage(body, protocol, imageProbe.color)) {
            return {
              ok: false,
              imageUnsupported: false,
              code: 'IMAGE_CAPABILITY_UNKNOWN',
              error: 'The model replied without describing the test image.',
            };
          }
          return { ok: true, endpointUrl: url };
        }
        last = { detail: isExpectedProviderResponseShape(protocol, body)
          ? hasErrorFinish(body, protocol)
            ? 'Endpoint returned an error finish status.'
            : 'Endpoint returned a valid completion response, but the model did not produce any chat text.'
          : 'The endpoint returned an invalid completion response.' };
        continue;
      }
      const detail = responseDetail(responseText, response);
      if (image && looksLikeImageUnsupported(detail)) {
        return { ok: false, imageUnsupported: true, code: 'IMAGE_TEST_FAILED', error: detail };
      }
      if (urls.length > 1 && isFallbackStatus(response.status)) {
        last = { detail };
        continue;
      }
      return { ok: false, imageUnsupported: false, code: classifyProbeError(detail, response.status), error: detail };
    }
    const detail = last?.detail || 'Connection failed.';
    return { ok: false, imageUnsupported: image && looksLikeImageUnsupported(detail), code: classifyProbeError(detail), error: detail };
  } catch (error) {
    if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : error;
    const timedOut = controller.signal.aborted
      || error?.name === 'AbortError'
      || error?.code === 'network_timeout';
    return { ok: false, imageUnsupported: false, code: 'ENDPOINT_UNREACHABLE', error: timedOut ? 'Connection timed out after 30s.' : (error?.message || String(error)) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}
