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

describe('gateway WeCom routes', () => {
  it('returns WeCom status from pilotdeck.yaml', async () => {
    const { request } = await createGatewayApp({
      adapters: {
        wecom: {
          enabled: true,
          token: 'bot-1234567890',
          extra: {
            secret: 'secret',
            websocket_url: 'wss://custom.example',
            dm_policy: 'open',
            group_policy: 'disabled',
            allow_from: ['user-a'],
            group_allow_from: ['group-a'],
          },
        },
      },
    });

    const status = await request('/api/gateway/status');

    expect(status.wecom).toEqual({
      enabled: true,
      botId: 'bot-…7890',
      hasSecret: true,
      websocketUrl: 'wss://custom.example',
      dmPolicy: 'open',
      groupPolicy: 'disabled',
      allowFrom: ['user-a'],
      groupAllowFrom: ['group-a'],
    });
  });

  it('saves manual WeCom config to pilotdeck.yaml', async () => {
    const { request, configPath } = await createGatewayApp({});

    const result = await request('/api/gateway/wecom/save', {
      method: 'POST',
      body: JSON.stringify({
        botId: 'bot-manual',
        secret: 'secret-manual',
        websocketUrl: 'wss://custom.example',
        dmPolicy: 'allowlist',
        groupPolicy: 'allowlist',
        allowFrom: 'user-a, user-b',
        groupAllowFrom: ['group-a', 'group-b'],
      }),
    });

    expect(result.ok).toBe(true);
    const config = parseYaml(readFileSync(configPath, 'utf-8'));
    expect(config.adapters.wecom).toEqual({
      enabled: true,
      token: 'bot-manual',
      extra: {
        secret: 'secret-manual',
        websocket_url: 'wss://custom.example',
        dm_policy: 'allowlist',
        group_policy: 'allowlist',
        allow_from: ['user-a', 'user-b'],
        group_allow_from: ['group-a', 'group-b'],
      },
    });
  });

  it('preserves existing WeCom credentials on settings-only saves', async () => {
    const { request, configPath } = await createGatewayApp({
      adapters: {
        wecom: {
          enabled: true,
          token: 'bot-existing',
          extra: {
            secret: 'secret-existing',
            websocket_url: 'wss://old.example',
            dm_policy: 'open',
            group_policy: 'disabled',
          },
        },
      },
    });

    const result = await request('/api/gateway/wecom/save', {
      method: 'POST',
      body: JSON.stringify({
        websocketUrl: 'wss://new.example',
        dmPolicy: 'disabled',
        groupPolicy: 'open',
      }),
    });

    expect(result.ok).toBe(true);
    const config = parseYaml(readFileSync(configPath, 'utf-8'));
    expect(config.adapters.wecom).toEqual({
      enabled: true,
      token: 'bot-existing',
      extra: {
        secret: 'secret-existing',
        websocket_url: 'wss://new.example',
        dm_policy: 'disabled',
        group_policy: 'open',
      },
    });
  });

  it('disables WeCom config', async () => {
    const { request, configPath } = await createGatewayApp({
      adapters: {
        wecom: {
          enabled: true,
          token: 'bot-id',
          extra: { secret: 'secret' },
        },
      },
    });

    const result = await request('/api/gateway/wecom/disable', { method: 'POST' });

    expect(result.ok).toBe(true);
    const config = parseYaml(readFileSync(configPath, 'utf-8'));
    expect(config.adapters.wecom.enabled).toBe(false);
  });

  it('writes WeCom config after successful QR polling', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      const href = String(url);
      if (href.includes('/generate')) {
        return jsonResponse({
          data: {
            scode: 'scan-code',
            auth_url: 'https://work.weixin.qq.com/scan',
          },
        });
      }
      return jsonResponse({
        data: {
          status: 'success',
          bot_info: {
            botid: 'bot-from-qr',
            secret: 'secret-from-qr',
          },
        },
      });
    }));
    const { request, configPath } = await createGatewayApp({});

    const begin = await request('/api/gateway/wecom/qr-begin', { method: 'POST' });
    expect(begin.ok).toBe(true);
    expect(begin.qrUrl).toBe('https://work.weixin.qq.com/scan');

    const poll = await request('/api/gateway/wecom/qr-poll');
    expect(poll).toEqual({ ok: true, botId: 'bot-…m-qr' });

    const config = parseYaml(readFileSync(configPath, 'utf-8'));
    expect(config.adapters.wecom).toEqual({
      enabled: true,
      token: 'bot-from-qr',
      extra: {
        secret: 'secret-from-qr',
        websocket_url: 'wss://openws.work.weixin.qq.com',
        dm_policy: 'open',
        group_policy: 'disabled',
      },
    });
  });
});

async function createGatewayApp(initialConfig) {
  const pilotHome = mkdtempSync(join(tmpdir(), 'pilotdeck-wecom-gateway-'));
  tempDirs.push(pilotHome);
  const configPath = join(pilotHome, 'pilotdeck.yaml');
  writeFileSync(configPath, stringifyYaml(initialConfig), 'utf-8');

  process.env.PILOT_HOME = pilotHome;
  process.env.PILOTDECK_CONFIG_PATH = configPath;
  vi.resetModules();
  vi.doMock('../services/pilotdeckConfigWatcher.js', () => ({
    suppressNextWatchEvent: vi.fn(),
  }));
  vi.doMock('../services/pilotdeckConfigReloader.js', () => ({
    reloadPilotDeckConfig: vi.fn(async () => undefined),
  }));
  vi.doMock('../services/pilotdeckConfig.js', () => ({
    readPilotDeckConfigFile: vi.fn(() => ({ config: {} })),
  }));
  vi.doMock('../pilotdeck-bridge.js', () => ({
    getPilotDeckGateway: vi.fn(async () => ({ reloadConfig: vi.fn(async () => undefined) })),
  }));

  const { default: gatewayRoutes } = await import('./gateway.js');
  const app = express();
  app.use(express.json());
  app.use('/api/gateway', gatewayRoutes);

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
    return response.json();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
  };
}
