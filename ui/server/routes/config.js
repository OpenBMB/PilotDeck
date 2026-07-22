import express from 'express';
import fsPromises from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { prepareBackgroundSpawnOptions } from '../utils/processSpawn.js';
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
import {
  buildProviderChatEndpointCandidates,
  buildProviderModelsEndpointCandidates,
  isExpectedProviderModelsResponseShape,
  isExpectedProviderResponseShape,
} from '../../../src/model/providerEndpoint.js';
import { NetworkFetchError, networkFetch } from '../../../src/network/fetch.js';
import {
  OFFICE_PREVIEW_SERVICE_LIBREOFFICE,
  OFFICE_PREVIEW_SERVICE_NONE,
  getLibreOfficeCandidateStatuses,
  getConfiguredOfficePreviewService,
  getLibreOfficeStatus,
} from '../services/officePreview.js';

async function notifyGatewayConfigReload() {
  try {
    const gw = await getPilotDeckGateway();
    if (!gw?.reloadConfig) {
      return { skipped: true, reason: 'gateway_reload_unavailable' };
    }
    const result = await gw.reloadConfig();
    return { reloaded: result?.reloaded !== false, ...(result?.changedPaths ? { changedPaths: result.changedPaths } : {}) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

const router = express.Router();

const MASKED_SECRET = '********';
const DEFAULT_GLM_WEB_SEARCH_ENDPOINT = 'https://api.z.ai/api/paas/v4/web_search';
const DEFAULT_TAVILY_WEB_SEARCH_ENDPOINT = 'https://api.tavily.com/search';

function normalizeWebSearchProvider(provider) {
  return provider === 'tavily' || provider === 'custom' ? provider : 'glm';
}

function normalizeWebSearchCustomAuth(auth) {
  return auth === 'bodyApiKey' || auth === 'queryApiKey' || auth === 'none' ? auth : 'bearer';
}

function normalizeWebSearchEndpoint(provider, endpoint) {
  const trimmed = typeof endpoint === 'string' ? endpoint.trim() : '';
  const effective = trimmed || (
    provider === 'tavily'
      ? DEFAULT_TAVILY_WEB_SEARCH_ENDPOINT
      : provider === 'glm'
        ? DEFAULT_GLM_WEB_SEARCH_ENDPOINT
        : ''
  );
  if (!effective) return '';
  try {
    return new URL(effective).toString();
  } catch {
    return effective;
  }
}

function webSearchCredentialScope(config) {
  const value = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  const provider = normalizeWebSearchProvider(value.provider);
  const scope = {
    provider,
    endpoint: normalizeWebSearchEndpoint(provider, value.endpoint),
  };
  if (provider !== 'custom') return scope;

  const custom = value.customProvider && typeof value.customProvider === 'object' && !Array.isArray(value.customProvider)
    ? value.customProvider
    : {};
  return {
    ...scope,
    auth: normalizeWebSearchCustomAuth(custom.auth),
    method: custom.method === 'GET' ? 'GET' : 'POST',
    apiKeyParam: typeof custom.apiKeyParam === 'string' && custom.apiKeyParam.trim()
      ? custom.apiKeyParam.trim()
      : 'api_key',
  };
}

function webSearchCredentialScopeMatches(nextConfig, previousConfig) {
  return JSON.stringify(webSearchCredentialScope(nextConfig)) === JSON.stringify(webSearchCredentialScope(previousConfig));
}

function validateMaskedWebSearchKeyReuse(nextConfig, previousConfig) {
  const nextWebSearch = nextConfig?.tools?.webSearch;
  if (nextWebSearch?.apiKey !== MASKED_SECRET) return null;

  const previousWebSearch = previousConfig?.tools?.webSearch;
  const previousKey = typeof previousWebSearch?.apiKey === 'string' ? previousWebSearch.apiKey.trim() : '';
  if (!previousKey || previousKey === MASKED_SECRET) {
    return 'Saved Web Search API key is unavailable. Enter the API key again.';
  }
  if (!webSearchCredentialScopeMatches(nextWebSearch, previousWebSearch)) {
    return 'Enter the Web Search API key again after changing the provider, endpoint, or authentication settings.';
  }
  return null;
}

function serializeConfigResponse(record, reloadResult = null) {
  if (record.parseError) {
    return {
      exists: record.exists,
      path: record.configPath,
      raw: record.raw,
      config: maskSecrets(record.config),
      configDisabled: true,
      parseError: record.parseError,
      validation: {
        valid: false,
        errors: [`Invalid YAML: ${record.parseError}`],
        warnings: [],
      },
      ...(reloadResult ? { reload: reloadResult } : {}),
    };
  }

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

function extractProbeText(body, providerKind) {
  if (!body || typeof body !== 'object') return '';

  if (providerKind === 'anthropic') {
    const content = Array.isArray(body.content) ? body.content : [];
    return content
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('')
      .trim();
  }

  if (providerKind === 'google') {
    const candidates = Array.isArray(body.candidates) ? body.candidates : [];
    return candidates
      .flatMap((candidate) => Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [])
      .map((part) => (typeof part?.text === 'string' ? part.text : ''))
      .join('')
      .trim();
  }

  if (providerKind === 'responses') {
    if (typeof body.output_text === 'string' && body.output_text.trim()) return body.output_text.trim();
    const output = Array.isArray(body.output) ? body.output : [];
    return output
      .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
      .map((part) => {
        if (typeof part?.text === 'string') return part.text;
        if (typeof part?.output_text === 'string') return part.output_text;
        return '';
      })
      .join('')
      .trim();
  }

  const choices = Array.isArray(body.choices) ? body.choices : [];
  return choices
    .map((choice) => {
      const content = choice?.message?.content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
      }
      if (typeof choice?.text === 'string') return choice.text;
      return '';
    })
    .join('')
    .trim();
}

function normalizeModelListItem(item) {
  if (!item || typeof item !== 'object') return null;
  const rawId = typeof item.id === 'string'
    ? item.id
    : typeof item.name === 'string'
      ? item.name
      : '';
  const id = rawId.replace(/^models\//, '').trim();
  if (!id) return null;
  const displayName = typeof item.display_name === 'string'
    ? item.display_name
    : typeof item.displayName === 'string'
      ? item.displayName
      : id;
  return { id, displayName };
}

function parseModelListResponse(body) {
  const rawModels = Array.isArray(body?.data)
    ? body.data
    : Array.isArray(body?.models)
      ? body.models
      : [];
  const seen = new Set();
  const models = [];
  for (const item of rawModels) {
    const model = normalizeModelListItem(item);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

function isEndpointFallbackStatus(status) {
  return status === 400 || status === 404 || status === 405;
}

function isNetworkTimeout(error) {
  return error?.name === 'AbortError' || error?.code === 'network_timeout' || (error instanceof NetworkFetchError && error.code === 'network_timeout');
}

async function fetchWithEndpointFallback(urls, options, isExpectedOkBody = null) {
  let lastResult = null;
  for (const url of urls) {
    const response = await networkFetch(url, options, {
      signal: options?.signal,
      fetchImpl: fetch,
      retry: {
        maxRetries: 2,
        baseDelayMs: 500,
        maxDelayMs: 5_000,
        retryOnPost: String(options?.method || 'GET').toUpperCase() === 'POST',
      },
    });
    const responseText = await response.text();
    if (response.ok) {
      if (!isExpectedOkBody || urls.length === 1 || isExpectedOkBody(responseText)) {
        return { url, response, responseText };
      }
      lastResult = { url, response, responseText };
      continue;
    }
    if (urls.length === 1 || !isEndpointFallbackStatus(response.status)) {
      return { url, response, responseText };
    }
    lastResult = { url, response, responseText };
  }
  return lastResult;
}

function isExpectedJsonBody(protocol, responseText) {
  try {
    return isExpectedProviderResponseShape(protocol, responseText ? JSON.parse(responseText) : {});
  } catch {
    return false;
  }
}

function isExpectedModelsJsonBody(protocol, responseText) {
  try {
    return isExpectedProviderModelsResponseShape(protocol, responseText ? JSON.parse(responseText) : {});
  } catch {
    return false;
  }
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

router.get('/office-preview/status', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const [libreOffice, candidates, service] = await Promise.all([
      getLibreOfficeStatus({ forceRefresh }),
      getLibreOfficeCandidateStatuses({ forceRefresh }),
      Promise.resolve(getConfiguredOfficePreviewService()),
    ]);
    res.json({
      service,
      libreOffice: {
        ...libreOffice,
        candidates,
      },
      supportedServices: [
        OFFICE_PREVIEW_SERVICE_NONE,
        OFFICE_PREVIEW_SERVICE_LIBREOFFICE,
      ],
    });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Failed to read Office preview status',
      code: 'OFFICE_PREVIEW_STATUS_FAILED',
    });
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
      const maskedKeyError = validateMaskedWebSearchKeyReuse(parsed, diskRecord.rawYaml ?? {});
      if (maskedKeyError) {
        return res.status(400).json({ error: maskedKeyError });
      }
      // Re-hydrate any field the UI received as "********" with the
      // original disk value so saving the masked view back is a no-op
      // for secrets the user didn't actually touch.
      const restored = diskRecord.parseError
        ? parsed
        : preserveMaskedSecrets(parsed, diskRecord.rawYaml ?? {});
      suppressNextWatchEvent();
      saved = await writeRawPilotDeckYaml(restored);
    } else if (req.body?.config && typeof req.body.config === 'object') {
      if (diskRecord.parseError) {
        return res.status(400).json({
          error: 'Invalid config YAML; repair raw YAML before using structured config updates',
          configDisabled: true,
          parseError: diskRecord.parseError,
          validation: {
            valid: false,
            errors: [`Invalid YAML: ${diskRecord.parseError}`],
            warnings: [],
          },
        });
      }
      const maskedKeyError = validateMaskedWebSearchKeyReuse(req.body.config, diskRecord.config);
      if (maskedKeyError) {
        return res.status(400).json({ error: maskedKeyError });
      }
      const restored = preserveMaskedSecrets(req.body.config, diskRecord.config);
      suppressNextWatchEvent();
      saved = await writePilotDeckConfig(restored);
    } else {
      return res.status(400).json({ error: 'raw YAML or config object is required' });
    }

    const reloadResult = {
      ...(await reloadPilotDeckConfig(saved.config)),
      gateway: await notifyGatewayConfigReload(),
    };
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
    if (record.parseError) {
      return res.status(400).json({
        error: 'Invalid config YAML',
        configDisabled: true,
        parseError: record.parseError,
        validation: {
          valid: false,
          errors: [`Invalid YAML: ${record.parseError}`],
          warnings: [],
        },
      });
    }
    const validation = validatePilotDeckConfig(record.config);
    if (!validation.valid) {
      return res.status(400).json({ error: 'Invalid config', validation });
    }
    const reloadResult = {
      ...(await reloadPilotDeckConfig(record.config)),
      gateway: await notifyGatewayConfigReload(),
    };
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

router.post('/models', async (req, res) => {
  const { providerId, providerType, baseUrl, apiKey } = req.body || {};
  let effectiveApiKey = typeof apiKey === 'string' ? apiKey : '';
  if ((!effectiveApiKey || effectiveApiKey === '********') && typeof providerId === 'string' && providerId.trim()) {
    try {
      const record = readPilotDeckConfigFile();
      const provider = record.config?.model?.providers?.[providerId.trim()];
      if (typeof provider?.apiKey === 'string') effectiveApiKey = provider.apiKey;
    } catch { /* fall through to validation below */ }
  }
  if (!baseUrl) {
    return res.status(400).json({ ok: false, error: 'baseUrl is required' });
  }

  const normalizedType = String(providerType || '').toLowerCase();
  const isAnthropic = normalizedType === 'anthropic';
  const isGoogle = normalizedType === 'google';
  const normalizedBaseUrl = String(baseUrl).trim().replace(/\/+$/, '');
  const protocol = isGoogle ? 'google' : isAnthropic ? 'anthropic' : 'openai';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new NetworkFetchError('network_timeout', 'Model list request timed out after 10s.')), 10_000);

  try {
    const urls = buildProviderModelsEndpointCandidates({ protocol, baseUrl: normalizedBaseUrl });
    const headers = isGoogle
      ? (effectiveApiKey && effectiveApiKey !== '********' ? { 'x-goog-api-key': effectiveApiKey } : {})
      : isAnthropic
        ? {
            ...(effectiveApiKey && effectiveApiKey !== '********' ? { 'x-api-key': effectiveApiKey } : {}),
            'anthropic-version': '2023-06-01',
          }
        : (effectiveApiKey && effectiveApiKey !== '********' ? { Authorization: `Bearer ${effectiveApiKey}` } : {});
    const { url, response, responseText } = await fetchWithEndpointFallback(
      urls,
      { method: 'GET', headers, signal: controller.signal },
      (text) => isExpectedModelsJsonBody(protocol, text),
    );
    clearTimeout(timer);
    let body;
    try {
      body = responseText ? JSON.parse(responseText) : {};
    } catch {
      return res.status(502).json({ ok: false, error: `Expected JSON from ${url}, but received non-JSON content.` });
    }

    if (!response.ok) {
      const message = body?.error?.message || body?.message || responseText || `HTTP ${response.status}`;
      return res.status(response.status).json({ ok: false, error: message });
    }

    res.json({ ok: true, models: parseModelListResponse(body) });
  } catch (error) {
    clearTimeout(timer);
    const message = isNetworkTimeout(error)
      ? 'Model list request timed out after 10s.'
      : error instanceof Error ? error.message : String(error);
    res.status(500).json({ ok: false, error: message });
  }
});

router.post('/test-connection', async (req, res) => {
  const { providerId, providerType, baseUrl, apiKey, model } = req.body || {};
  const normalizedProviderId = String(providerId || '').trim().toLowerCase();
  const effectiveApiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  const apiKeyRequired = normalizedProviderId !== 'ollama';
  if (!baseUrl || !model || (apiKeyRequired && !effectiveApiKey)) {
    return res.status(400).json({
      ok: false,
      error: apiKeyRequired ? 'baseUrl, apiKey, and model are required' : 'baseUrl and model are required',
    });
  }

  // Accept V2 protocols ('openai' | 'openai-responses' | 'anthropic' | 'google')
  // as well as legacy onboarding values for compatibility.
  const normalizedType = String(providerType || '').toLowerCase();
  const isAnthropic = normalizedType === 'anthropic';
  const isGoogle = normalizedType === 'google';
  const isOpenAIResponses = normalizedType === 'openai-responses' || normalizedType === 'responses';
  const normalizedBaseUrl = String(baseUrl).trim().replace(/\/+$/, '');
  const timeout = 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new NetworkFetchError('network_timeout', `Connection timed out after ${timeout / 1000}s.`)), timeout);

  try {
    let url;
    let fetchOptions;

    if (isGoogle) {
      url = buildProviderChatEndpointCandidates({ protocol: 'google', baseUrl: normalizedBaseUrl, model });
      fetchOptions = {
        method: 'POST',
        headers: {
          'x-goog-api-key': effectiveApiKey,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
          generationConfig: { maxOutputTokens: 8 },
        }),
        signal: controller.signal,
      };
    } else if (isAnthropic) {
      url = buildProviderChatEndpointCandidates({ protocol: 'anthropic', baseUrl: normalizedBaseUrl });
      fetchOptions = {
        method: 'POST',
        headers: {
          'x-api-key': effectiveApiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 8,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
        signal: controller.signal,
      };
    } else if (isOpenAIResponses) {
      url = buildProviderChatEndpointCandidates({ protocol: 'openai-responses', baseUrl: normalizedBaseUrl });
      fetchOptions = {
        method: 'POST',
        headers: {
          ...(effectiveApiKey ? { Authorization: `Bearer ${effectiveApiKey}` } : {}),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_output_tokens: 16,
          input: 'Hi',
          store: false,
        }),
        signal: controller.signal,
      };
    } else {
      url = buildProviderChatEndpointCandidates({ protocol: 'openai', baseUrl: normalizedBaseUrl });
      fetchOptions = {
        method: 'POST',
        headers: {
          ...(effectiveApiKey ? { Authorization: `Bearer ${effectiveApiKey}` } : {}),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 8,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
        signal: controller.signal,
      };
    }

    const responseProtocol = isGoogle
      ? 'google'
      : isAnthropic
        ? 'anthropic'
        : isOpenAIResponses
          ? 'openai-responses'
          : 'openai';
    const result = await fetchWithEndpointFallback(url, fetchOptions, (responseText) => isExpectedJsonBody(responseProtocol, responseText));
    const { response, responseText } = result;
    url = result.url;
    clearTimeout(timer);
    const expectedShape = isAnthropic
      ? 'Anthropic message'
      : isGoogle
        ? 'Google Gemini generateContent response'
        : isOpenAIResponses
          ? 'OpenAI Responses response'
          : 'OpenAI chat completion';
    const baseUrlHint = isGoogle
      ? 'For native Google Gemini, the base URL is usually https://generativelanguage.googleapis.com.'
      : 'For OpenAI-compatible and Responses API endpoints, the base URL usually ends with /v1.';

    if (response.ok) {
      let body;
      try {
        body = JSON.parse(responseText);
      } catch {
        return res.json({
          ok: false,
          error: `Expected a JSON ${expectedShape} but received non-JSON content from ${url}. ${baseUrlHint}`,
        });
      }

      const hasCompletionShape = isAnthropic
        ? Array.isArray(body?.content) || body?.type === 'message'
        : isGoogle
          ? Array.isArray(body?.candidates)
          : isOpenAIResponses
            ? body?.object === 'response' || Array.isArray(body?.output) || typeof body?.output_text === 'string'
            : Array.isArray(body?.choices);
      if (!hasCompletionShape) {
        return res.json({
          ok: false,
          error: `Endpoint returned HTTP ${response.status}, but the response was not a valid ${expectedShape}. Check the base URL path.`,
        });
      }

      const providerKind = isAnthropic ? 'anthropic' : isGoogle ? 'google' : isOpenAIResponses ? 'responses' : 'openai';
      const probeText = extractProbeText(body, providerKind);
      if (!probeText) {
        return res.json({
          ok: false,
          error: `Endpoint returned a valid ${expectedShape}, but the model did not produce any chat text. Check that ${model} supports chat completions.`,
        });
      }

      return res.json({ ok: true, message: `Connected successfully — Model ${model} is available.` });
    }

    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = JSON.parse(responseText);
      if (body?.error?.message) detail = body.error.message;
      else if (body?.error?.type) detail = `${body.error.type}: ${body.error.message || ''}`;
    } catch { /* ignore parse errors */ }

    return res.json({ ok: false, error: `${detail}` });
  } catch (err) {
    clearTimeout(timer);
    if (isNetworkTimeout(err)) {
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
  const selectedProvider = normalizeWebSearchProvider(provider);
  const custom = customProvider && typeof customProvider === 'object' ? customProvider : {};
  const customAuth = normalizeWebSearchCustomAuth(custom.auth);
  const customMethod = custom.method === 'GET' ? 'GET' : 'POST';
  const queryParam = typeof custom.queryParam === 'string' && custom.queryParam.trim() ? custom.queryParam.trim() : 'query';
  const apiKeyParam = typeof custom.apiKeyParam === 'string' && custom.apiKeyParam.trim() ? custom.apiKeyParam.trim() : 'api_key';
  const resultsPath = typeof custom.resultsPath === 'string' ? custom.resultsPath.trim() : '';
  const requestedKey = typeof apiKey === 'string' ? apiKey.trim() : '';
  const trimmedEndpoint = typeof endpoint === 'string' ? endpoint.trim() : '';
  let trimmedKey = requestedKey === MASKED_SECRET ? '' : requestedKey;
  if (requestedKey === MASKED_SECRET) {
    try {
      const record = readPilotDeckConfigFile();
      const savedWebSearch = record.config?.tools?.webSearch;
      const savedKey = savedWebSearch?.apiKey;
      const requestedWebSearch = {
        provider: selectedProvider,
        endpoint: trimmedEndpoint,
        customProvider: custom,
      };
      if (
        typeof savedKey === 'string' &&
        savedKey.trim() !== MASKED_SECRET &&
        webSearchCredentialScopeMatches(requestedWebSearch, savedWebSearch)
      ) {
        trimmedKey = savedKey.trim();
      } else if (typeof savedKey === 'string' && savedKey.trim() !== MASKED_SECRET) {
        return res.status(400).json({
          ok: false,
          error: 'Enter the Web Search API key again after changing the provider, endpoint, or authentication settings.',
        });
      }
    } catch { /* fall through to validation below */ }
  }
  if (!trimmedKey && !(selectedProvider === 'custom' && customAuth === 'none')) {
    return res.status(400).json({ ok: false, error: 'API key is required.' });
  }
  if (selectedProvider === 'custom' && !trimmedEndpoint) {
    return res.status(400).json({ ok: false, error: 'Custom provider endpoint is required.' });
  }
  const effectiveEndpoint = normalizeWebSearchEndpoint(selectedProvider, trimmedEndpoint);

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
  const timer = setTimeout(() => controller.abort(new NetworkFetchError('network_timeout', `Connection timed out after ${timeout / 1000}s.`)), timeout);
  const t0 = Date.now();

  try {
    const response = await networkFetch(requestUrl, { ...requestInit, signal: controller.signal }, {
      timeoutMs: timeout,
      signal: controller.signal,
      fetchImpl: fetch,
      retry: {
        maxRetries: 2,
        baseDelayMs: 500,
        maxDelayMs: 5_000,
        retryOnPost: requestInit.method === 'POST',
      },
    });
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
    if (isNetworkTimeout(err)) {
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
    const child = spawn(command, args, prepareBackgroundSpawnOptions({ stdio: 'ignore', detached: true }));
    child.unref();
    res.json({ success: true, path: configPath });
  } catch (error) {
    res.json({ success: false, path: configPath, error: error instanceof Error ? error.message : String(error) });
  }
});

export default router;
