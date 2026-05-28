import express from 'express';
import fsPromises from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { parse as parseYaml } from 'yaml';
import {
  buildDefaultPilotDeckConfig,
  configToYaml,
  getPilotDeckConfigPath,
  maskSecrets,
  parseConfigYaml,
  preserveMaskedSecrets,
  rawYamlToMaskedString,
  readPilotDeckConfigFile,
  validatePilotDeckConfig,
  writePilotDeckConfig,
  writeRawPilotDeckYaml,
} from '../services/pilotdeckConfig.js';
import { reloadPilotDeckConfig } from '../services/pilotdeckConfigReloader.js';
import { suppressNextWatchEvent } from '../services/pilotdeckConfigWatcher.js';
import { getPilotDeckGateway } from '../pilotdeck-bridge.js';

async function notifyGatewayConfigReload() {
  try {
    const gw = await getPilotDeckGateway();
    if (gw?.reloadConfig) await gw.reloadConfig();
  } catch { /* gateway unreachable — self-watch will pick up the change */ }
}

const router = express.Router();

function serializeConfigResponse(record, reloadResult = null) {
  const validation = validatePilotDeckConfig(record.config);
  const maskedConfig = maskSecrets(record.config);
  // Prefer the disk's actual YAML for the "raw" view so non-ui-internal
  // top-level segments (router/gateway/adapters/extension/cron/alwaysOn)
  // survive the trip from disk → UI. Fall back to the lossy template
  // only when there's no disk file yet (fresh install), so the editor
  // still has something editable to render.
  const hasDiskYaml = record.rawYaml && typeof record.rawYaml === 'object' && Object.keys(record.rawYaml).length > 0;
  const raw = hasDiskYaml ? rawYamlToMaskedString(record.rawYaml) : configToYaml(maskedConfig);
  return {
    exists: record.exists,
    path: record.configPath,
    raw,
    config: maskedConfig,
    validation: {
      valid: validation.valid,
      errors: validation.errors,
      warnings: validation.warnings,
    },
    ...(reloadResult ? { reload: reloadResult } : {}),
  };
}

function broadcastConfigEvent(payload) {
  process.emit('pilotdeck:config-broadcast', payload);
}

router.get('/', (_req, res) => {
  try {
    const record = readPilotDeckConfigFile();
    res.json(serializeConfigResponse(record));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/validate', (req, res) => {
  try {
    const raw = typeof req.body?.raw === 'string' ? req.body.raw : '';
    const config = raw ? parseConfigYaml(raw) : req.body?.config;
    const validation = validatePilotDeckConfig(config);
    res.status(validation.valid ? 200 : 400).json(validation);
  } catch (error) {
    res.status(400).json({ valid: false, errors: [error instanceof Error ? error.message : String(error)], warnings: [] });
  }
});

router.put('/', async (req, res) => {
  try {
    // Two submission shapes coexist:
    //
    //   • `{ raw: "..." }` from the Raw YAML editor → write the
    //     parsed YAML object to disk verbatim via
    //     writeRawPilotDeckYaml. This is the only path that preserves
    //     router/gateway/adapters/extension/cron/alwaysOn edits,
    //     because the ui-internal schema doesn't model them.
    //
    //   • `{ config: {...} }` from structured editors (provider
    //     picker, memory editor, onboarding LLM step) → run through
    //     writePilotDeckConfig, which round-trips through
    //     ui-internal but read-modify-writes the rest from disk so
    //     non-ui segments aren't dropped.
    //
    // Removing the `config` branch is what got 5ad9f29 reverted;
    // never collapse the two paths into one — they have different
    // semantics and different callers.
    const diskRecord = readPilotDeckConfigFile();
    const rawString = typeof req.body?.raw === 'string' ? req.body.raw : null;

    let saved;
    if (rawString !== null) {
      let parsed;
      try {
        parsed = parseYaml(rawString);
      } catch (parseErr) {
        return res.status(400).json({
          error: `Invalid YAML: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
        });
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return res.status(400).json({ error: 'raw YAML must parse to an object' });
      }
      // Re-hydrate any field the UI received as "********" with the
      // original disk value so saving the masked view back is a no-op
      // for secrets the user didn't actually touch.
      const restored = preserveMaskedSecrets(parsed, diskRecord.rawYaml ?? {});
      suppressNextWatchEvent();
      saved = await writeRawPilotDeckYaml(restored);
    } else if (req.body?.config && typeof req.body.config === 'object') {
      const restored = preserveMaskedSecrets(req.body.config, diskRecord.config);
      suppressNextWatchEvent();
      saved = await writePilotDeckConfig(restored);
    } else {
      return res.status(400).json({ error: 'raw YAML or config object is required' });
    }

    const reloadResult = await reloadPilotDeckConfig(saved.config);
    void notifyGatewayConfigReload();
    // Re-read disk so the response's `raw` field comes from the actual
    // (lossless) file rather than the lossy round-trip output, and so
    // `serializeConfigResponse` has a `rawYaml` to render the full view.
    const freshRecord = readPilotDeckConfigFile();
    const response = serializeConfigResponse(freshRecord, reloadResult);
    broadcastConfigEvent({ source: 'ui-save', ...response, timestamp: new Date().toISOString() });
    res.json(response);
  } catch (error) {
    if (error?.validation) {
      return res.status(400).json({ error: error.message, validation: error.validation });
    }
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/reload', async (_req, res) => {
  try {
    const record = readPilotDeckConfigFile();
    const validation = validatePilotDeckConfig(record.config);
    if (!validation.valid) {
      return res.status(400).json({ error: 'Invalid config', validation });
    }
    const reloadResult = await reloadPilotDeckConfig(record.config);
    void notifyGatewayConfigReload();
    const response = serializeConfigResponse(record, reloadResult);
    broadcastConfigEvent({ source: 'ui-reload', ...response, timestamp: new Date().toISOString() });
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.get('/provider', (_req, res) => {
  try {
    const record = readPilotDeckConfigFile();
    const providers = record.config?.model?.providers;
    if (!providers || typeof providers !== 'object') {
      return res.json({ exists: false, provider: null });
    }

    const mainRef = typeof record.config?.agent?.model === 'string'
      ? record.config.agent.model.trim()
      : '';
    let providerId = '';
    let modelId = '';
    if (mainRef) {
      const slash = mainRef.indexOf('/');
      if (slash > 0 && slash < mainRef.length - 1) {
        providerId = mainRef.slice(0, slash);
        modelId = mainRef.slice(slash + 1);
      }
    }
    if (!providerId) {
      providerId = Object.keys(providers)[0] || '';
      if (providerId) {
        const firstModels = providers[providerId]?.models;
        modelId = firstModels && typeof firstModels === 'object'
          ? (Object.keys(firstModels)[0] || '')
          : '';
      }
    }
    if (!providerId) return res.json({ exists: false, provider: null });

    const provider = providers[providerId] || {};

    res.json({
      exists: true,
      provider: {
        type: provider.protocol || '',
        baseUrl: provider.url || '',
        apiKey: provider.apiKey || '',
        model: modelId,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/test-connection', async (req, res) => {
  const { providerType, baseUrl, apiKey, model } = req.body || {};
  if (!baseUrl || !apiKey || !model) {
    return res.status(400).json({ ok: false, error: 'baseUrl, apiKey, and model are required' });
  }

  // Accept V2 protocols ('openai' | 'anthropic') as well as the legacy
  // onboarding values ('openai-chat' | 'anthropic') for compatibility.
  const normalizedType = String(providerType || '').toLowerCase();
  const isAnthropic = normalizedType === 'anthropic';
  const timeout = 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    let url;
    let fetchOptions;

    if (isAnthropic) {
      url = `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
      fetchOptions = {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
        signal: controller.signal,
      };
    } else {
      const base = baseUrl.replace(/\/+$/, '');
      const hasV1 = /\/v1\/?$/i.test(base);
      url = hasV1 ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
      fetchOptions = {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
        signal: controller.signal,
      };
    }

    const response = await fetch(url, fetchOptions);
    clearTimeout(timer);

    if (response.ok) {
      return res.json({ ok: true, message: `Connected successfully — Model ${model} is available.` });
    }

    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body?.error?.message) detail = body.error.message;
      else if (body?.error?.type) detail = `${body.error.type}: ${body.error.message || ''}`;
    } catch { /* ignore parse errors */ }

    return res.json({ ok: false, error: `${detail}` });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return res.json({ ok: false, error: `Connection timed out after ${timeout / 1000}s. Check your network and API URL.` });
    }
    return res.json({ ok: false, error: err.message || String(err) });
  }
});

/**
 * Probe the configured web-search provider. Mirrors
 * `src/tool/builtin/webSearch.ts`'s GLM/Tavily/custom request shape. Returns:
 * `{ ok, error?, latencyMs?, organicCount? }` to match the convention
 * established by `/test-connection`.
 */
router.post('/test-web-search', async (req, res) => {
  const { provider, apiKey, endpoint, customProvider } = req.body || {};
  const selectedProvider = provider === 'tavily' || provider === 'custom' ? provider : 'glm';
  const custom = customProvider && typeof customProvider === 'object' ? customProvider : {};
  const customAuth = typeof custom.auth === 'string' ? custom.auth : 'bearer';
  const customMethod = custom.method === 'GET' ? 'GET' : 'POST';
  const queryParam = typeof custom.queryParam === 'string' && custom.queryParam.trim() ? custom.queryParam.trim() : 'query';
  const apiKeyParam = typeof custom.apiKeyParam === 'string' && custom.apiKeyParam.trim() ? custom.apiKeyParam.trim() : 'api_key';
  const resultsPath = typeof custom.resultsPath === 'string' ? custom.resultsPath.trim() : '';
  const trimmedKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!trimmedKey && !(selectedProvider === 'custom' && customAuth === 'none')) {
    return res.status(400).json({ ok: false, error: 'API key is required.' });
  }
  const trimmedEndpoint = typeof endpoint === 'string' ? endpoint.trim() : '';
  if (selectedProvider === 'custom' && !trimmedEndpoint) {
    return res.status(400).json({ ok: false, error: 'Custom provider endpoint is required.' });
  }
  const effectiveEndpoint = trimmedEndpoint || (
    selectedProvider === 'tavily'
      ? 'https://api.tavily.com/search'
      : 'https://api.z.ai/api/paas/v4/web_search'
  );

  let requestUrl;
  let requestInit;
  try {
    const url = new URL(effectiveEndpoint);
    if (selectedProvider === 'tavily') {
      requestUrl = effectiveEndpoint;
      requestInit = {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            api_key: trimmedKey,
            query: 'hello',
            max_results: 3,
            include_answer: true,
            search_depth: 'basic',
          }),
        };
    } else if (selectedProvider === 'custom') {
      const headers = { Accept: 'application/json' };
      const body = {};
      if (customMethod === 'GET') {
        url.searchParams.set(queryParam, 'hello');
      } else {
        headers['Content-Type'] = 'application/json';
        body[queryParam] = 'hello';
      }
      if (customAuth === 'bearer' && trimmedKey) {
        headers.Authorization = `Bearer ${trimmedKey}`;
      } else if (customAuth === 'queryApiKey' && trimmedKey) {
        url.searchParams.set(apiKeyParam, trimmedKey);
      } else if (customAuth === 'bodyApiKey' && trimmedKey) {
        if (customMethod === 'GET') url.searchParams.set(apiKeyParam, trimmedKey);
        else body[apiKeyParam] = trimmedKey;
      }
      requestUrl = url.toString();
      requestInit = {
        method: customMethod,
        headers,
        ...(customMethod === 'POST' ? { body: JSON.stringify(body) } : {}),
      };
    } else {
      requestUrl = effectiveEndpoint;
      requestInit = {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${trimmedKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            search_engine: 'search-prime',
            search_query: 'hello',
            count: 3,
            search_recency_filter: 'noLimit',
          }),
        };
    }
  } catch {
    return res.status(400).json({ ok: false, error: `Invalid endpoint URL: ${effectiveEndpoint}` });
  }

  const timeout = 15_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const t0 = Date.now();

  try {
    const response = await fetch(requestUrl, { ...requestInit, signal: controller.signal });
    clearTimeout(timer);
    const latencyMs = Date.now() - t0;

    let raw = null;
    try {
      raw = await response.json();
    } catch { /* not JSON */ }

    if (!response.ok) {
      const detail = (raw && (raw.error || raw.msg)) || `${response.status} ${response.statusText}`;
      return res.json({ ok: false, error: String(detail), latencyMs });
    }
    if (raw && typeof raw.error === 'string' && raw.error.length > 0) {
      return res.json({ ok: false, error: raw.error, latencyMs });
    }
    if (raw && typeof raw.code === 'number' && raw.code !== 0) {
      const msg = typeof raw.msg === 'string' ? raw.msg : 'proxy error';
      return res.json({ ok: false, error: `code=${raw.code}: ${msg}`, latencyMs });
    }

    const organic = selectedProvider === 'tavily'
      ? raw?.results
      : selectedProvider === 'custom' && resultsPath
        ? readPath(raw, resultsPath)
        : (raw?.search_result ?? raw?.results ?? raw?.items ?? raw?.data);
    const organicCount = Array.isArray(organic) ? organic.length : 0;
    return res.json({ ok: true, latencyMs, organicCount });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return res.json({ ok: false, error: `Connection timed out after ${timeout / 1000}s.` });
    }
    return res.json({ ok: false, error: err.message || String(err) });
  }
});

function readPath(value, pathValue) {
  return pathValue.split('.').reduce((current, segment) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    return current[segment];
  }, value);
}

router.post('/open', async (_req, res) => {
  const configPath = getPilotDeckConfigPath();
  try {
    await fsPromises.mkdir(path.dirname(configPath), { recursive: true });
    try {
      await fsPromises.access(configPath);
    } catch {
      await fsPromises.writeFile(configPath, configToYaml(buildDefaultPilotDeckConfig()), 'utf8');
    }

    const command = process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open';
    const args = process.platform === 'darwin'
      ? ['-R', configPath]
      : process.platform === 'win32'
        ? ['/c', 'start', '', configPath]
        : [path.dirname(configPath)];
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.unref();
    res.json({ success: true, path: configPath });
  } catch (error) {
    res.json({ success: false, path: configPath, error: error instanceof Error ? error.message : String(error) });
  }
});

export default router;
