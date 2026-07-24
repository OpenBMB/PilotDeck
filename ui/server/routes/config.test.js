import express from 'express';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = globalThis.fetch;
const tempDirs = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  delete process.env.PILOT_HOME;
  delete process.env.PILOTDECK_CONFIG_PATH;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('config test-connection route', () => {
  it('uses protocol-versioned chat completions when the root base URL works', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      calls.push(String(url));
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    }));

    const { request } = await createConfigApp();
    const data = await request('/api/config/test-connection', {
      method: 'POST',
      body: JSON.stringify({
        providerType: 'openai',
        baseUrl: 'https://api.openai.com',
        apiKey: 'sk-test',
        model: 'gpt-test',
      }),
    });

    expect(data.ok).toBe(true);
    expect(calls).toEqual(['https://api.openai.com/v1/chat/completions']);
  });

  it('falls back to unversioned chat completions when protocol-versioned probing misses', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url) === 'https://api.openai.com/v1/chat/completions') {
        return jsonResponse({ error: { message: 'not found' } }, { ok: false, status: 404, statusText: 'Not Found' });
      }
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    }));

    const { request } = await createConfigApp();
    const data = await request('/api/config/test-connection', {
      method: 'POST',
      body: JSON.stringify({
        providerType: 'openai',
        baseUrl: 'https://api.openai.com',
        apiKey: 'sk-test',
        model: 'gpt-test',
      }),
    });

    expect(data.ok).toBe(true);
    expect(calls).toEqual([
      'https://api.openai.com/v1/chat/completions',
      'https://api.openai.com/chat/completions',
    ]);
  });

  it('falls back to unversioned chat completions when protocol-versioned probing returns unexpected JSON', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url) === 'https://api.openai.com/v1/chat/completions') {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    }));

    const { request } = await createConfigApp();
    const data = await request('/api/config/test-connection', {
      method: 'POST',
      body: JSON.stringify({
        providerType: 'openai',
        baseUrl: 'https://api.openai.com',
        apiKey: 'sk-test',
        model: 'gpt-test',
      }),
    });

    expect(data.ok).toBe(true);
    expect(calls).toEqual([
      'https://api.openai.com/v1/chat/completions',
      'https://api.openai.com/chat/completions',
    ]);
  });

  it('falls back to unversioned messages for Anthropic when protocol-versioned probing returns unexpected JSON', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url) === 'https://api.anthropic.com/v1/messages') {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ type: 'message', content: [{ type: 'text', text: 'ok' }] });
    }));

    const { request } = await createConfigApp();
    const data = await request('/api/config/test-connection', {
      method: 'POST',
      body: JSON.stringify({
        providerType: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-test',
        model: 'claude-test',
      }),
    });

    expect(data.ok).toBe(true);
    expect(calls).toEqual([
      'https://api.anthropic.com/v1/messages',
      'https://api.anthropic.com/messages',
    ]);
  });

  it('falls back to unversioned Gemini endpoint when protocol-versioned probing returns unexpected JSON', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url) === 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent') {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    }));

    const { request } = await createConfigApp();
    const data = await request('/api/config/test-connection', {
      method: 'POST',
      body: JSON.stringify({
        providerType: 'google',
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKey: 'sk-test',
        model: 'gemini-pro',
      }),
    });

    expect(data.ok).toBe(true);
    expect(calls).toEqual([
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent',
      'https://generativelanguage.googleapis.com/models/gemini-pro:generateContent',
    ]);
  });

  it('does not duplicate existing version paths', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      calls.push(String(url));
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    }));

    const { request } = await createConfigApp();
    const data = await request('/api/config/test-connection', {
      method: 'POST',
      body: JSON.stringify({
        providerType: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-test',
      }),
    });

    expect(data.ok).toBe(true);
    expect(calls).toEqual(['https://api.openai.com/v1/chat/completions']);
  });

  it('accepts full OpenAI-compatible endpoint URLs', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      calls.push(String(url));
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    }));

    const { request } = await createConfigApp();
    const data = await request('/api/config/test-connection', {
      method: 'POST',
      body: JSON.stringify({
        providerType: 'openai',
        baseUrl: 'https://api.openai.com/v1/chat/completions',
        apiKey: 'sk-test',
        model: 'gpt-test',
      }),
    });

    expect(data.ok).toBe(true);
    expect(calls).toEqual(['https://api.openai.com/v1/chat/completions']);
  });

  it('fails when the provider returns no chat text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ choices: [{ message: { content: '' } }] })));

    const { request } = await createConfigApp();
    const data = await request('/api/config/test-connection', {
      method: 'POST',
      body: JSON.stringify({
        providerType: 'openai',
        baseUrl: 'https://api.openai.com',
        apiKey: 'sk-test',
        model: 'gpt-test',
      }),
    });

    expect(data.ok).toBe(false);
    expect(data.error).toContain('did not produce any chat text');
  });

  it('accepts Responses API output_text content parts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      object: 'response',
      output: [{
        type: 'message',
        content: [{ type: 'output_text', output_text: 'ok' }],
      }],
    })));

    const { request } = await createConfigApp();
    const data = await request('/api/config/test-connection', {
      method: 'POST',
      body: JSON.stringify({
        providerType: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-test',
      }),
    });

    expect(data.ok).toBe(true);
  });

  it('allows Ollama connection tests without an API key', async () => {
    const calls = [];
    const authHeaders = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      calls.push(String(url));
      authHeaders.push(init?.headers?.Authorization ?? init?.headers?.authorization);
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    }));

    const { request } = await createConfigApp();
    const data = await request('/api/config/test-connection', {
      method: 'POST',
      body: JSON.stringify({
        providerId: 'ollama',
        providerType: 'openai',
        baseUrl: 'http://localhost:11434/v1',
        apiKey: '',
        model: 'qwen3:0.6b',
      }),
    });

    expect(data.ok).toBe(true);
    expect(calls).toEqual(['http://localhost:11434/v1/chat/completions']);
    expect(authHeaders).toEqual([undefined]);
  });
});

describe('config test-web-search route', () => {
  it('resolves a masked API key from the saved web-search config', async () => {
    const authorizationHeaders = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      authorizationHeaders.push(init?.headers?.Authorization);
      return jsonResponse({ search_result: [{ title: 'result' }] });
    }));

    const { request } = await createConfigApp({
      config: {
        tools: {
          webSearch: {
            provider: 'glm',
            apiKey: 'saved-search-key',
          },
        },
      },
    });
    const data = await request('/api/config/test-web-search', {
      method: 'POST',
      body: JSON.stringify({
        provider: 'glm',
        apiKey: '********',
        endpoint: 'https://api.z.ai/api/paas/v4/web_search',
      }),
    });

    expect(data.ok).toBe(true);
    expect(data.organicCount).toBe(1);
    expect(authorizationHeaders).toEqual(['Bearer saved-search-key']);
  });

  it('prefers a newly entered API key over the saved key', async () => {
    const authorizationHeaders = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      authorizationHeaders.push(init?.headers?.Authorization);
      return jsonResponse({ search_result: [] });
    }));

    const { request } = await createConfigApp({
      config: {
        tools: {
          webSearch: {
            provider: 'glm',
            apiKey: 'saved-search-key',
          },
        },
      },
    });
    const data = await request('/api/config/test-web-search', {
      method: 'POST',
      body: JSON.stringify({
        provider: 'glm',
        apiKey: 'new-search-key',
        endpoint: 'https://api.z.ai/api/paas/v4/web_search',
      }),
    });

    expect(data.ok).toBe(true);
    expect(authorizationHeaders).toEqual(['Bearer new-search-key']);
  });

  it('rejects a masked API key when no saved key exists', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const { request } = await createConfigApp();
    const data = await request('/api/config/test-web-search', {
      method: 'POST',
      body: JSON.stringify({
        provider: 'glm',
        apiKey: '********',
        endpoint: 'https://api.z.ai/api/paas/v4/web_search',
      }),
    });

    expect(data.ok).toBe(false);
    expect(data.error).toBe('API key is required.');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('does not send a saved masked API key to a caller-controlled provider endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const { request } = await createConfigApp({
      config: {
        tools: {
          webSearch: {
            provider: 'glm',
            apiKey: 'saved-search-key',
          },
        },
      },
    });
    const data = await request('/api/config/test-web-search', {
      method: 'POST',
      body: JSON.stringify({
        provider: 'custom',
        apiKey: '********',
        endpoint: 'https://attacker.example/search',
        customProvider: { auth: 'bearer', method: 'POST' },
      }),
    });

    expect(data.ok).toBe(false);
    expect(data.error).toContain('Enter the Web Search API key again');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('does not preserve a masked Web Search key when its credential scope changes on save', async () => {
    const { request, writePilotDeckConfig } = await createConfigApp({
      config: {
        tools: {
          webSearch: {
            provider: 'glm',
            apiKey: 'saved-search-key',
          },
        },
      },
    });
    const data = await request('/api/config', {
      method: 'PUT',
      body: JSON.stringify({
        config: {
          tools: {
            webSearch: {
              provider: 'custom',
              apiKey: '********',
              endpoint: 'https://attacker.example/search',
              customProvider: { auth: 'bearer', method: 'POST' },
            },
          },
        },
      }),
    });

    expect(data.error).toContain('Enter the Web Search API key again');
    expect(writePilotDeckConfig).not.toHaveBeenCalled();
  });
});

describe('config provider rename secret preservation', () => {
  it('restores masked provider secrets when only the provider ID changes', async () => {
    const initial = stringifyYaml({
      schemaVersion: 1,
      agent: { model: 'old-provider/gpt-test' },
      model: {
        providers: {
          'old-provider': {
            protocol: 'openai',
            url: 'https://api.example.test/v1',
            apiKey: 'sk-saved-secret',
            models: { 'gpt-test': {} },
          },
        },
      },
    });
    const { request, configPath } = await createDiskConfigApp(initial);
    const renamed = stringifyYaml({
      schemaVersion: 1,
      agent: { model: 'new-provider/gpt-test' },
      model: {
        providers: {
          'new-provider': {
            protocol: 'openai',
            url: 'https://api.example.test/v1',
            apiKey: '********',
            models: { 'gpt-test': {} },
          },
        },
      },
    });

    const response = await request('/api/config', {
      method: 'PUT',
      body: JSON.stringify({
        raw: renamed,
        providerRenames: [{ from: 'old-provider', to: 'new-provider' }],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.body.validation.valid).toBe(true);
    expect(
      parseYaml(readFileSync(configPath, 'utf8')).model.providers['new-provider'].apiKey,
    ).toBe('sk-saved-secret');
  });

  it('requires new credentials when a rename also changes the provider scope', async () => {
    const initial = stringifyYaml({
      schemaVersion: 1,
      agent: { model: 'old-provider/gpt-test' },
      model: {
        providers: {
          'old-provider': {
            protocol: 'openai',
            url: 'https://api.example.test/v1',
            apiKey: 'sk-saved-secret',
            models: { 'gpt-test': {} },
          },
        },
      },
    });
    const { request, configPath } = await createDiskConfigApp(initial);
    const renamed = stringifyYaml({
      schemaVersion: 1,
      agent: { model: 'new-provider/gpt-test' },
      model: {
        providers: {
          'new-provider': {
            protocol: 'openai',
            url: 'https://other.example.test/v1',
            apiKey: '********',
            models: { 'gpt-test': {} },
          },
        },
      },
    });

    const response = await request('/api/config', {
      method: 'PUT',
      body: JSON.stringify({
        raw: renamed,
        providerRenames: [{ from: 'old-provider', to: 'new-provider' }],
      }),
    });

    expect(response.status).toBe(400);
    expect(response.body.error).toContain('Enter provider credentials again');
    expect(
      parseYaml(readFileSync(configPath, 'utf8')).model.providers['old-provider'].apiKey,
    ).toBe('sk-saved-secret');

    const retryWithoutRenameMetadata = await request('/api/config', {
      method: 'PUT',
      body: JSON.stringify({ raw: renamed }),
    });

    expect(retryWithoutRenameMetadata.status).toBe(400);
    expect(retryWithoutRenameMetadata.body.error).toContain(
      'masked secrets could not be restored',
    );
    expect(
      parseYaml(readFileSync(configPath, 'utf8')).model.providers['old-provider'].apiKey,
    ).toBe('sk-saved-secret');
  });
});

describe('config write revisions', () => {
  it('rejects a stale full-config save instead of overwriting a newer write', async () => {
    const initial = stringifyYaml({
      schemaVersion: 1,
      customEnv: { SAVE_VERSION: 'initial' },
    });
    const { request, configPath } = await createDiskConfigApp(initial);
    const loaded = await request('/api/config');

    expect(loaded.status).toBe(200);
    expect(loaded.body.revision).toEqual(expect.any(String));

    const firstWrite = await request('/api/config', {
      method: 'PUT',
      body: JSON.stringify({
        raw: stringifyYaml({
          schemaVersion: 1,
          customEnv: { SAVE_VERSION: 'first' },
        }),
        baseRevision: loaded.body.revision,
      }),
    });

    expect(firstWrite.status).toBe(200);
    expect(firstWrite.body.revision).not.toBe(loaded.body.revision);

    const staleWrite = await request('/api/config', {
      method: 'PUT',
      body: JSON.stringify({
        raw: stringifyYaml({
          schemaVersion: 1,
          customEnv: { SAVE_VERSION: 'stale' },
        }),
        baseRevision: loaded.body.revision,
      }),
    });

    expect(staleWrite.status).toBe(409);
    expect(staleWrite.body.code).toBe('CONFIG_CONFLICT');
    expect(
      parseYaml(readFileSync(configPath, 'utf8')).customEnv.SAVE_VERSION,
    ).toBe('first');
  });
});


describe('config routes invalid YAML fallback', () => {
  it('returns raw invalid YAML instead of failing GET /api/config', async () => {
    const brokenRaw = 'schemaVersion: 1\nmodel:\n  providers: [\n';
    const { request } = await createDiskConfigApp(brokenRaw);

    const response = await request('/api/config');

    expect(response.status).toBe(200);
    expect(response.body.raw).toBe(brokenRaw);
    expect(response.body.configDisabled).toBe(true);
    expect(response.body.parseError).toEqual(expect.any(String));
    expect(response.body.validation.valid).toBe(false);
    expect(response.body.validation.errors[0]).toMatch(/^Invalid YAML:/);
  });

  it('saves repaired raw YAML after the existing file is invalid', async () => {
    const { request, configPath } = await createDiskConfigApp('schemaVersion: 1\nmodel:\n  providers: [\n');
    const repaired = stringifyYaml({
      schemaVersion: 1,
      agent: { model: 'openai/gpt-4.1-mini' },
      model: {
        providers: {
          openai: {
            protocol: 'openai',
            url: 'https://api.openai.com/v1',
            apiKey: 'sk-test',
            models: { 'gpt-4.1-mini': {} },
          },
        },
      },
    });

    const response = await request('/api/config', {
      method: 'PUT',
      body: JSON.stringify({ raw: repaired }),
    });

    expect(response.status).toBe(200);
    expect(response.body.configDisabled).toBeUndefined();
    expect(response.body.validation.valid).toBe(true);
    expect(parseYaml(readFileSync(configPath, 'utf8')).model.providers.openai.apiKey).toBe('sk-test');
  });

  it('rejects reload without applying defaults when YAML is invalid', async () => {
    const reloadPilotDeckConfig = vi.fn(async () => ({ processEnv: { reloaded: true } }));
    const { request } = await createDiskConfigApp('schemaVersion: 1\nmodel:\n  providers: [\n', { reloadPilotDeckConfig });

    const response = await request('/api/config/reload', { method: 'POST' });

    expect(response.status).toBe(400);
    expect(response.body.configDisabled).toBe(true);
    expect(response.body.validation.valid).toBe(false);
    expect(response.body.validation.errors[0]).toMatch(/^Invalid YAML:/);
    expect(reloadPilotDeckConfig).not.toHaveBeenCalled();
  });

  it('rejects structured config saves without overwriting invalid YAML', async () => {
    const brokenRaw = 'schemaVersion: 1\nmodel:\n  providers: [\n';
    const { request, configPath } = await createDiskConfigApp(brokenRaw);

    const response = await request('/api/config', {
      method: 'PUT',
      body: JSON.stringify({ config: { schemaVersion: 1, model: { providers: {} } } }),
    });

    expect(response.status).toBe(400);
    expect(response.body.configDisabled).toBe(true);
    expect(response.body.validation.errors[0]).toMatch(/^Invalid YAML:/);
    expect(readFileSync(configPath, 'utf8')).toBe(brokenRaw);
  });
});

async function createConfigApp({ config = {} } = {}) {
  const writePilotDeckConfig = vi.fn();
  const writeRawPilotDeckYaml = vi.fn();
  vi.doMock('../services/pilotdeckConfigWatcher.js', () => ({
    suppressNextWatchEvent: vi.fn(),
  }));
  vi.doMock('../services/pilotdeckConfigReloader.js', () => ({
    reloadPilotDeckConfig: vi.fn(async () => undefined),
  }));
  vi.doMock('../services/pilotdeckConfig.js', async () => {
    const actual = await vi.importActual('../services/pilotdeckConfig.js');
    return {
      ...actual,
      readPilotDeckConfigFile: vi.fn(() => ({ exists: false, configPath: '', config, rawYaml: {} })),
      writePilotDeckConfig,
      writeRawPilotDeckYaml,
    };
  });
  vi.doMock('../pilotdeck-bridge.js', () => ({
    getPilotDeckGateway: vi.fn(async () => ({ reloadConfig: vi.fn(async () => undefined) })),
  }));

  const { default: configRoutes } = await import('./config.js');
  const app = express();
  app.use(express.json());
  app.use('/api/config', configRoutes);

  return {
    request: (path, init) => requestBodyJson(app, path, init),
    writePilotDeckConfig,
    writeRawPilotDeckYaml,
  };
}

async function requestBodyJson(app, path, init = {}) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await nativeFetch(`http://127.0.0.1:${port}${path}`, {
      headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
      ...init,
    });
    return response.json();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function createDiskConfigApp(initialRaw, overrides = {}) {
  const pilotHome = mkdtempSync(join(tmpdir(), 'pilotdeck-config-route-'));
  tempDirs.push(pilotHome);
  const configPath = join(pilotHome, 'pilotdeck.yaml');
  writeFileSync(configPath, initialRaw, 'utf8');

  process.env.PILOT_HOME = pilotHome;
  process.env.PILOTDECK_CONFIG_PATH = configPath;

  vi.resetModules();
  vi.doUnmock('../services/pilotdeckConfig.js');
  vi.doMock('../services/pilotdeckConfigWatcher.js', () => ({
    suppressNextWatchEvent: vi.fn(),
  }));
  vi.doMock('../services/pilotdeckConfigReloader.js', () => ({
    reloadPilotDeckConfig: overrides.reloadPilotDeckConfig ?? vi.fn(async () => ({ processEnv: { reloaded: true } })),
  }));
  vi.doMock('../pilotdeck-bridge.js', () => ({
    getPilotDeckGateway: vi.fn(async () => ({ reloadConfig: vi.fn(async () => undefined) })),
  }));

  const { default: configRoutes } = await import('./config.js');
  const app = express();
  app.use(express.json());
  app.use('/api/config', configRoutes);

  return {
    configPath,
    request: (path, init) => requestStatusJson(app, path, init),
  };
}

async function requestStatusJson(app, path, init = {}) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await nativeFetch(`http://127.0.0.1:${port}${path}`, {
      headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
      ...init,
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function jsonResponse(payload, overrides = {}) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    ...overrides,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  };
}
