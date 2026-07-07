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
  vi.resetModules();
  delete process.env.PILOT_HOME;
  delete process.env.PILOTDECK_CONFIG_PATH;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('config routes invalid YAML fallback', () => {
  it('returns raw invalid YAML instead of failing GET /api/config', async () => {
    const brokenRaw = 'schemaVersion: 1\nmodel:\n  providers: [\n';
    const { request } = await createConfigApp(brokenRaw);

    const response = await request('/api/config');

    expect(response.status).toBe(200);
    expect(response.body.raw).toBe(brokenRaw);
    expect(response.body.configDisabled).toBe(true);
    expect(response.body.parseError).toEqual(expect.any(String));
    expect(response.body.validation.valid).toBe(false);
    expect(response.body.validation.errors[0]).toMatch(/^Invalid YAML:/);
  });

  it('saves repaired raw YAML after the existing file is invalid', async () => {
    const { request, configPath } = await createConfigApp('schemaVersion: 1\nmodel:\n  providers: [\n');
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
});

async function createConfigApp(initialRaw) {
  const pilotHome = mkdtempSync(join(tmpdir(), 'pilotdeck-config-route-'));
  tempDirs.push(pilotHome);
  const configPath = join(pilotHome, 'pilotdeck.yaml');
  writeFileSync(configPath, initialRaw, 'utf8');

  process.env.PILOT_HOME = pilotHome;
  process.env.PILOTDECK_CONFIG_PATH = configPath;

  vi.resetModules();
  vi.doMock('../services/pilotdeckConfigWatcher.js', () => ({
    suppressNextWatchEvent: vi.fn(),
  }));
  vi.doMock('../services/pilotdeckConfigReloader.js', () => ({
    reloadPilotDeckConfig: vi.fn(async () => ({ processEnv: { reloaded: true } })),
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
    request: (path, init) => requestJson(app, path, init),
  };
}

async function requestJson(app, path, init = {}) {
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
