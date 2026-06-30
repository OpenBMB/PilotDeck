import http from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ENV_KEYS = [
  'PILOT_HOME',
  'PILOTDECK_CONFIG_PATH',
  'TAVILY_API_KEY',
  'CUSTOM_WEB_SEARCH_API_KEY',
  'GLM_WEB_SEARCH_API_KEY',
  'ZAI_API_KEY',
];

let previousEnv;
let tempRoot;

async function createConfigApp() {
  vi.resetModules();
  vi.doMock('../pilotdeck-bridge.js', () => ({
    getPilotDeckGateway: vi.fn(async () => null),
  }));
  vi.doMock('../services/pilotdeckConfigReloader.js', () => ({
    reloadPilotDeckConfig: vi.fn(async () => null),
  }));
  vi.doMock('../services/pilotdeckConfigWatcher.js', () => ({
    suppressNextWatchEvent: vi.fn(),
  }));
  const { default: configRouter } = await import('./config.js');
  const app = express();
  app.use(express.json());
  app.use('/api/config', configRouter);
  return app;
}

async function postJson(app, body) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  try {
    return await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/config/test-web-search',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        },
        (res) => {
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { raw += chunk; });
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode, body: JSON.parse(raw) });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function mockProviderFetch(responseBody = { results: [{ title: 'ok' }] }) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(responseBody), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('config web search test route', () => {
  beforeEach(() => {
    previousEnv = Object.fromEntries(TEST_ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of TEST_ENV_KEYS) delete process.env[key];
    tempRoot = mkdtempSync(join(tmpdir(), 'pilotdeck-web-search-test-'));
    process.env.PILOT_HOME = join(tempRoot, 'pilot-home');
  });

  afterEach(() => {
    for (const key of TEST_ENV_KEYS) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it('uses TAVILY_API_KEY when no inline Tavily key is provided', async () => {
    process.env.TAVILY_API_KEY = 'env-tavily';
    const fetchMock = mockProviderFetch();
    const app = await createConfigApp();

    const result = await postJson(app, { provider: 'tavily', apiKey: '' });

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.api_key).toBe('env-tavily');
  });

  it('uses GLM_WEB_SEARCH_API_KEY before ZAI_API_KEY for GLM tests', async () => {
    process.env.GLM_WEB_SEARCH_API_KEY = 'env-glm';
    process.env.ZAI_API_KEY = 'env-zai';
    const fetchMock = mockProviderFetch({ search_result: [{ title: 'ok' }] });
    const app = await createConfigApp();

    const result = await postJson(app, { provider: 'glm', apiKey: '' });

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer env-glm');
  });

  it('falls back to ZAI_API_KEY when GLM_WEB_SEARCH_API_KEY is missing', async () => {
    process.env.ZAI_API_KEY = 'env-zai';
    const fetchMock = mockProviderFetch({ search_result: [{ title: 'ok' }] });
    const app = await createConfigApp();

    const result = await postJson(app, { provider: 'glm', apiKey: '' });

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer env-zai');
  });

  it('uses request customEnv for custom bearer tests', async () => {
    const fetchMock = mockProviderFetch();
    const app = await createConfigApp();

    const result = await postJson(app, {
      provider: 'custom',
      apiKey: '',
      endpoint: 'https://example.com/search',
      customProvider: { auth: 'bearer' },
      customEnv: { CUSTOM_WEB_SEARCH_API_KEY: 'custom-env' },
    });

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer custom-env');
  });

  it('preserves saved customEnv secrets when the request contains a masked value', async () => {
    mkdirSync(process.env.PILOT_HOME, { recursive: true });
    writeFileSync(
      join(process.env.PILOT_HOME, 'pilotdeck.yaml'),
      [
        'schemaVersion: 1',
        'customEnv:',
        '  TAVILY_API_KEY: saved-tavily',
        '',
      ].join('\n'),
      'utf8',
    );
    const fetchMock = mockProviderFetch();
    const app = await createConfigApp();

    const result = await postJson(app, {
      provider: 'tavily',
      apiKey: '',
      customEnv: { TAVILY_API_KEY: '********' },
    });

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.api_key).toBe('saved-tavily');
  });

  it('does not revive saved customEnv secrets that were removed from the current request', async () => {
    mkdirSync(process.env.PILOT_HOME, { recursive: true });
    writeFileSync(
      join(process.env.PILOT_HOME, 'pilotdeck.yaml'),
      [
        'schemaVersion: 1',
        'customEnv:',
        '  TAVILY_API_KEY: saved-tavily',
        '',
      ].join('\n'),
      'utf8',
    );
    const fetchMock = mockProviderFetch();
    const app = await createConfigApp();

    const result = await postJson(app, {
      provider: 'tavily',
      apiKey: '',
      customEnv: {},
    });

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ ok: false, error: 'API key is required.' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('prefers inline API keys over environment keys', async () => {
    process.env.TAVILY_API_KEY = 'env-tavily';
    const fetchMock = mockProviderFetch();
    const app = await createConfigApp();

    const result = await postJson(app, { provider: 'tavily', apiKey: ' inline-tavily ' });

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    const requestBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(requestBody.api_key).toBe('inline-tavily');
  });

  it('rejects missing credentials when no inline or environment key is available', async () => {
    const fetchMock = mockProviderFetch();
    const app = await createConfigApp();

    const result = await postJson(app, { provider: 'glm', apiKey: '' });

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ ok: false, error: 'API key is required.' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows custom providers with auth none and sends no API key', async () => {
    const fetchMock = mockProviderFetch();
    const app = await createConfigApp();

    const result = await postJson(app, {
      provider: 'custom',
      apiKey: '',
      endpoint: 'https://example.com/search',
      customProvider: { auth: 'none', method: 'GET' },
    });

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('https://example.com/search?query=hello');
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBeUndefined();
  });
});
