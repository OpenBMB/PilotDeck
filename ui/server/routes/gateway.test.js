import express from 'express';
import { createHash } from 'node:crypto';
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
  it('reports every message channel off when no adapters are configured', async () => {
    const { request } = await createGatewayApp({});
    const status = await request('/api/gateway/status');
    for (const channel of ['feishu', 'weixin', 'wecom']) {
      expect(status[channel].enabled).toBe(false);
    }
  });

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

  it('broadcasts the latest config revision after a channel save', async () => {
    const broadcasts = [];
    const onBroadcast = (payload) => broadcasts.push(payload);
    process.on('pilotdeck:config-broadcast', onBroadcast);
    try {
      const { request, configPath } = await createGatewayApp({});

      const result = await request('/api/gateway/wecom/save', {
        method: 'POST',
        body: JSON.stringify({ botId: 'bot-broadcast', secret: 'secret-broadcast' }),
      });

      expect(result.ok).toBe(true);
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0]).toMatchObject({
        source: 'gateway-save',
        exists: true,
        validation: { valid: true },
      });
      expect(broadcasts[0].revision).toBe(
        createHash('sha256').update(readFileSync(configPath, 'utf8')).digest('hex'),
      );
      expect(broadcasts[0].raw).toContain('wecom:');
    } finally {
      process.off('pilotdeck:config-broadcast', onBroadcast);
    }
  });

  it('preserves hand-written model indentation when saving a channel', async () => {
    const raw = [
      '# hand-maintained config',
      'model:',
      '    providers:',
      '        custom:',
      '            protocol: openai',
      '            url: https://example.test/v1',
      '            apiKey: REDACTED',
      '            models:',
      '                demo: {}',
      'adapters:',
      '    # keep this channel untouched',
      '    weixin:',
      '        enabled: false',
      '',
    ].join('\n');
    const { request, configPath } = await createGatewayApp(raw);

    const result = await request('/api/gateway/wecom/save', {
      method: 'POST',
      body: JSON.stringify({ botId: 'bot-manual', secret: 'secret-manual' }),
    });

    expect(result.ok).toBe(true);
    const saved = readFileSync(configPath, 'utf8');
    expect(saved).toContain('# hand-maintained config');
    expect(saved).toContain('            apiKey: REDACTED');
    expect(saved).toContain('                demo: {}');
    expect(saved).toContain('    # keep this channel untouched\n    weixin:\n        enabled: false');
    expect(() => parseYaml(saved)).not.toThrow();
  });

  it('rejects channel saves without changing invalid YAML', async () => {
    const raw = 'schemaVersion: 1\nmodel:\n    providers: [\n';
    const { request, configPath } = await createGatewayApp(raw);

    const result = await request('/api/gateway/wecom/save', {
      method: 'POST',
      body: JSON.stringify({ botId: 'bot-manual', secret: 'secret-manual' }),
    });

    expect(result).toMatchObject({ ok: false, code: 'INVALID_CONFIG_YAML' });
    expect(readFileSync(configPath, 'utf8')).toBe(raw);
  });
});

async function createGatewayApp(initialConfig) {
  const pilotHome = mkdtempSync(join(tmpdir(), 'pilotdeck-wecom-gateway-'));
  tempDirs.push(pilotHome);
  const configPath = join(pilotHome, 'pilotdeck.yaml');
  writeFileSync(
    configPath,
    typeof initialConfig === 'string' ? initialConfig : stringifyYaml(initialConfig),
    'utf-8',
  );

  process.env.PILOT_HOME = pilotHome;
  process.env.PILOTDECK_CONFIG_PATH = configPath;
  vi.resetModules();
  vi.doMock('../services/pilotdeckConfigWatcher.js', () => ({
    suppressNextWatchEvent: vi.fn(),
  }));
  vi.doMock('../services/pilotdeckConfigReloader.js', () => ({
    reloadPilotDeckConfig: vi.fn(async () => undefined),
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
