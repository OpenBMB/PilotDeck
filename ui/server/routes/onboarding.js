import express from 'express';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { constants as fsConstants, promises as fs } from 'fs';
import path from 'path';
import { readPilotDeckConfigFile, withPilotDeckConfigWrite, writePilotDeckConfig } from '../services/pilotdeckConfig.js';
import { reloadPilotDeckConfig } from '../services/pilotdeckConfigReloader.js';
import { suppressNextWatchEvent } from '../services/pilotdeckConfigWatcher.js';
import { probeModelConnection } from '../services/modelConnectionProbe.js';

const router = express.Router();
const TEST_TTL_MS = 10 * 60 * 1000;
const MAX_MODELS_PER_TEST = 10;
const MAX_RETRIES_PER_PROBE = 10;
const MAX_STREAM_RETRIES_PER_PROBE = 10;
const MAX_RETRY_DELAY_MS = 60_000;
const MAX_STREAM_IDLE_TIMEOUT_MS = 5 * 60_000;
const TEST_RATE_WINDOW_MS = 60 * 1000;
const TEST_RATE_MAX_REQUESTS = 20;
const CONNECTION_TEST_TIMEOUT_MS = 60 * 1000;
const PROBE_GLOBAL_LIMIT = 3;
const PROBE_PER_USER_LIMIT = 1;
const CLONE_GLOBAL_LIMIT = 2;
const CLONE_PER_USER_LIMIT = 1;
const CLONE_TIMEOUT_MS = 5 * 60 * 1000;
const tests = new Map();
const testRateBuckets = new Map();
const testKeySecret = randomBytes(32);
const ALIASES = { gemini: 'google', kimi: 'moonshot', volcengine: 'volc_ark', bailian: 'dashscope' };
const PRESETS = {
  anthropic: { protocol: 'anthropic', endpoint: 'https://api.anthropic.com' },
  openai: { protocol: 'openai', endpoint: 'https://api.openai.com/v1' },
  'openai-responses': { protocol: 'openai-responses', endpoint: 'https://api.openai.com/v1' },
  dashscope: { protocol: 'openai', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  deepseek: { protocol: 'openai', endpoint: 'https://api.deepseek.com/v1' },
  google: { protocol: 'google', endpoint: 'https://generativelanguage.googleapis.com' },
  moonshot: { protocol: 'openai', endpoint: 'https://api.moonshot.cn/v1' },
  minimax: { protocol: 'openai', endpoint: 'https://api.minimax.io/v1' },
  volc_ark: { protocol: 'openai', endpoint: 'https://ark.cn-beijing.volces.com/api/v3' },
  zhipu: { protocol: 'openai', endpoint: 'https://api.z.ai/api/paas/v4' },
  openrouter: { protocol: 'openai', endpoint: 'https://openrouter.ai/api/v1' },
  ollama: { protocol: 'openai', endpoint: 'http://localhost:11434/v1' },
};
const PROVIDER_CATALOG = [
  { id: 'anthropic', displayName: 'Anthropic', logoUrl: '/onboarding/providers/anthropic.svg' },
  { id: 'openai', displayName: 'OpenAI', logoUrl: '/onboarding/providers/openai.svg' },
  { id: 'openai-responses', displayName: 'OpenAI (Responses API)', logoUrl: '/onboarding/providers/openai.svg' },
  { id: 'dashscope', displayName: '阿里云百炼 (DashScope)', logoUrl: '/onboarding/providers/bailian-color.svg' },
  { id: 'deepseek', displayName: 'DeepSeek', logoUrl: '/onboarding/providers/deepseek-color.svg' },
  { id: 'google', displayName: 'Google AI (Gemini)', logoUrl: '/onboarding/providers/gemini-color.svg' },
  { id: 'openrouter', displayName: 'OpenRouter', logoUrl: '/onboarding/providers/openrouter-color.svg' },
  { id: 'ollama', displayName: 'Ollama', logoUrl: '/onboarding/providers/ollama.svg' },
  { id: 'minimax', displayName: 'MiniMax', logoUrl: '/onboarding/providers/minimax-color.svg' },
  { id: 'moonshot', displayName: 'Moonshot AI (Kimi)', logoUrl: '/onboarding/providers/kimi.svg' },
  { id: 'volc_ark', displayName: '火山方舟 (Volcano Ark)', logoUrl: '/onboarding/providers/volcengine-color.svg' },
  { id: 'zhipu', displayName: '智谱 Z.AI', logoUrl: '/onboarding/providers/zhipu-color.svg' },
];
const PROTOCOLS = new Set(['openai', 'openai-responses', 'anthropic', 'google']);

function createInFlightLimiter(globalLimit, perUserLimit) {
  const perUser = new Map();
  const active = new Set();
  return {
    tryAcquire(userId) {
      const key = String(userId);
      const current = perUser.get(key);
      const userCount = current?.count || 0;
      if (active.size >= globalLimit || userCount >= perUserLimit) return null;
      const entry = { startedAt: Date.now(), userId: key };
      active.add(entry);
      perUser.set(key, { count: userCount + 1, startedAt: current?.startedAt ?? entry.startedAt });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active.delete(entry);
        const perUserActive = perUser.get(key);
        const remaining = (perUserActive?.count || 1) - 1;
        if (remaining > 0) perUser.set(key, { ...perUserActive, count: remaining });
        else perUser.delete(key);
      };
    },
    retryAfterSeconds(userId, maxDurationMs) {
      const userActive = perUser.get(String(userId));
      const startedAt = userActive?.startedAt ?? [...active].reduce(
        (earliest, entry) => Math.min(earliest, entry.startedAt),
        Number.POSITIVE_INFINITY,
      );
      if (!Number.isFinite(startedAt)) return 1;
      return Math.max(1, Math.ceil((startedAt + maxDurationMs - Date.now()) / 1000));
    },
  };
}

const probeInFlight = createInFlightLimiter(PROBE_GLOBAL_LIMIT, PROBE_PER_USER_LIMIT);
const cloneInFlight = createInFlightLimiter(CLONE_GLOBAL_LIMIT, CLONE_PER_USER_LIMIT);

function abortOnDisconnect(req, res) {
  const controller = new AbortController();
  const abort = () => {
    if (res.writableEnded || controller.signal.aborted) return;
    const error = new Error('Client disconnected.');
    error.name = 'AbortError';
    error.code = 'CLIENT_DISCONNECTED';
    controller.abort(error);
  };
  req.once('aborted', abort);
  res.once('close', abort);
  return {
    signal: controller.signal,
    cleanup() {
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
    },
  };
}

function apiError(res, status, code, message, modelId = undefined) {
  return res.status(status).json({ code, message, ...(modelId ? { modelId } : {}) });
}
function text(value) { return typeof value === 'string' ? value.trim() : ''; }
function trimTrailingSlashes(value) {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) end -= 1;
  return value.slice(0, end);
}
function canonicalEndpoint(value) {
  const candidate = trimTrailingSlashes(text(value));
  if (!candidate) return '';
  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return trimTrailingSlashes(parsed.toString());
  } catch {
    return '';
  }
}
function keyFingerprint(apiKey) { return createHmac('sha256', testKeySecret).update(apiKey).digest(); }
function sameKey(fingerprint, apiKey) {
  const candidate = keyFingerprint(apiKey);
  return fingerprint?.length === candidate.length && timingSafeEqual(fingerprint, candidate);
}

// Normalize only catalog lookup; never use this value as a configuration key.
function presetIdFor(providerId) {
  const lookupId = text(providerId).toLowerCase();
  return Object.hasOwn(ALIASES, lookupId) ? ALIASES[lookupId] : lookupId;
}

export function connectionTestMatchesProvider(record, provider) {
  const presetId = presetIdFor(provider?.providerId);
  const presetEndpoint = Object.hasOwn(PRESETS, presetId) ? PRESETS[presetId].endpoint : '';
  const endpoint = canonicalEndpoint(text(provider?.url) || presetEndpoint);
  const testedEndpoint = canonicalEndpoint(record?.provider?.endpoint);
  if (!record || !provider || !endpoint || !testedEndpoint || record.provider.protocol !== provider.protocol || testedEndpoint !== endpoint) return false;
  return presetIdFor(provider.providerId) === 'ollama' || sameKey(record.keyFingerprint, text(provider.apiKey));
}
function hasOnlyKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => keys.includes(key));
}
function retryPolicy(value) {
  const keys = ['maxRetries', 'maxStreamRetries', 'streamIdleTimeoutMs', 'baseDelayMs', 'maxDelayMs'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).some((key) => !keys.includes(key))) return null;
  const output = {
    maxRetries: 2,
    maxStreamRetries: 2,
    streamIdleTimeoutMs: 30_000,
    baseDelayMs: 500,
    maxDelayMs: 5_000,
  };
  for (const key of keys) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'number' || !Number.isInteger(value[key]) || value[key] < 0) return null;
    if (key === 'maxRetries' && value[key] > MAX_RETRIES_PER_PROBE) return null;
    if (key === 'maxStreamRetries' && value[key] > MAX_STREAM_RETRIES_PER_PROBE) return null;
    if (key === 'streamIdleTimeoutMs' && value[key] > MAX_STREAM_IDLE_TIMEOUT_MS) return null;
    if ((key === 'baseDelayMs' || key === 'maxDelayMs') && value[key] > MAX_RETRY_DELAY_MS) return null;
    output[key] = value[key];
  }
  if (output.baseDelayMs > output.maxDelayMs) return null;
  return output;
}
function resolveProvider(body, { allowPresetEndpointOverride = false } = {}) {
  const providerId = text(body.providerId);
  const presetId = presetIdFor(providerId);
  if (Object.hasOwn(PRESETS, presetId)) {
    const preset = { ...PRESETS[presetId] };
    // Settings may use a custom protocol under any user-chosen provider ID.
    if (allowPresetEndpointOverride && text(body.protocol)) {
      preset.protocol = text(body.protocol).toLowerCase();
      if (!PROTOCOLS.has(preset.protocol)) return null;
    }
    const requestedEndpoint = allowPresetEndpointOverride ? text(body.endpoint) : '';
    if (!requestedEndpoint) return { providerId, ...preset, custom: false };
    try {
      const url = new URL(requestedEndpoint);
      if (!['http:', 'https:'].includes(url.protocol)) return null;
      return { providerId, ...preset, endpoint: trimTrailingSlashes(url.toString()), custom: false };
    } catch {
      return null;
    }
  }
  const protocol = text(body.protocol).toLowerCase();
  const endpoint = trimTrailingSlashes(text(body.endpoint));
  try {
    const url = new URL(endpoint);
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(providerId) || providerId === 'custom' || !PROTOCOLS.has(protocol) || !['http:', 'https:'].includes(url.protocol)) return null;
    return { providerId, protocol, endpoint: trimTrailingSlashes(url.toString()), custom: true };
  } catch { return null; }
}
function parseCloneUrl(value) {
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:', 'ssh:'].includes(parsed.protocol)) return null;
    return { url: value, path: parsed.pathname };
  } catch {
    const scpLike = /^(?:[\w.-]+@)?[\w.-]+:([^\s]+)$/.exec(value);
    return scpLike ? { url: value, path: scpLike[1] } : null;
  }
}
function testStatus(models) {
  if (models.some((model) => model.textInput !== 'supported')) return 'failed';
  return models.some((model) => model.imageInput === 'unknown') ? 'manual_input_required' : 'passed';
}
function aggregateError(models, status) {
  if (status === 'passed') return null;
  if (status === 'failed') return { code: 'TEXT_TEST_FAILED', message: 'One or more models failed the text connection test.' };
  return { code: 'IMAGE_CAPABILITY_UNKNOWN', message: 'One or more models require manual image capability input.' };
}
function publicResult(record) {
  return { testId: record.id, status: record.status, manualInputRequired: record.status === 'manual_input_required', models: record.models, testedAt: record.testedAt, error: record.error || null };
}
function getTest(req, res, testId = req.params.testId) {
  const result = getConnectionTestRecord(req.user.id, testId);
  if (result.reason === 'expired') { apiError(res, 410, 'TEST_EXPIRED', 'Connection test has expired.'); return null; }
  if (!result.record) { apiError(res, 404, 'TEST_NOT_FOUND', 'Connection test was not found.'); return null; }
  const record = result.record;
  return record;
}

/** Return a connection test only when it belongs to the caller and is alive. */
export function getConnectionTestRecord(userId, testId) {
  const record = tests.get(String(testId || ''));
  if (!record || record.userId !== userId) return { record: null, reason: 'not_found' };
  if (record.expiresAt <= Date.now()) {
    tests.delete(record.id);
    return { record: null, reason: 'expired' };
  }
  return { record, reason: null };
}
function deleteExpiredTests() { const now = Date.now(); for (const [id, record] of tests) if (record.expiresAt <= now) tests.delete(id); }
setInterval(deleteExpiredTests, TEST_TTL_MS).unref();

function consumeModelTestRateLimit(userId) {
  const now = Date.now();
  const key = String(userId || 'anonymous');
  const bucket = testRateBuckets.get(key);
  if (!bucket || now >= bucket.resetAt) {
    testRateBuckets.set(key, { count: 1, resetAt: now + TEST_RATE_WINDOW_MS });
    return 0;
  }
  if (++bucket.count <= TEST_RATE_MAX_REQUESTS) return 0;
  return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
}

router.get('/providers', (_req, res) => {
  res.json({
    providers: PROVIDER_CATALOG.map((item) => {
      const preset = PRESETS[item.id];
      return {
        id: item.id,
        displayName: item.displayName,
        protocol: preset.protocol,
        endpoint: preset.endpoint,
        logoUrl: item.logoUrl,
        requiresApiKey: item.id !== 'ollama',
      };
    }),
  });
});

// Reserve the shared probe slot synchronously; both HTTP and background tasks use it.
export function prepareConnectionTest(body, userId, allowPresetEndpointOverride = false) {
  const provider = resolveProvider(body || {}, { allowPresetEndpointOverride });
  const requestedModels = Array.isArray(body?.models) ? body.models.map(text) : [];
  const models = [...new Set(requestedModels.filter(Boolean))];
  const retry = retryPolicy(body?.retryPolicy);
  const apiKey = text(body?.apiKey);
  if (!hasOnlyKeys(body, ['providerId', 'protocol', 'endpoint', 'apiKey', 'models', 'retryPolicy']) || !provider || !models.length || models.length !== requestedModels.length || models.length > MAX_MODELS_PER_TEST || !retry || (presetIdFor(provider.providerId) !== 'ollama' && !apiKey)) {
    throw Object.assign(new Error('providerId, models, retryPolicy, and the required API key are invalid.'), { status: 400, code: 'INVALID_REQUEST' });
  }
  const release = probeInFlight.tryAcquire(userId);
  if (!release) {
    throw Object.assign(new Error('A connection test is already running.'), {
      status: 429,
      code: 'TEST_BUSY',
      retryAfterSeconds: probeInFlight.retryAfterSeconds(userId, CONNECTION_TEST_TIMEOUT_MS),
    });
  }
  const retryAfterSeconds = consumeModelTestRateLimit(userId);
  if (retryAfterSeconds > 0) {
    release();
    throw Object.assign(new Error('Too many connection tests.'), {
      status: 429,
      code: 'RATE_LIMITED',
      retryAfterSeconds,
    });
  }
  return async (signal) => {
    const timeoutController = new AbortController();
    const timeoutError = Object.assign(new Error('Connection test timed out after 60 seconds.'), { code: 'TEST_TIMEOUT' });
    const timeout = setTimeout(() => timeoutController.abort(timeoutError), CONNECTION_TEST_TIMEOUT_MS);
    timeout.unref?.();
    const probeSignal = AbortSignal.any([signal, timeoutController.signal]);
    const results = [];
    try {
      for (const modelId of models) {
        probeSignal.throwIfAborted();
        let textProbe;
        try {
          textProbe = await probeModelConnection({
            protocol: provider.protocol, baseUrl: provider.endpoint, apiKey, model: modelId, signal: probeSignal, retryPolicy: retry,
          });
        } catch (error) {
          if (probeSignal.aborted) throw error;
          textProbe = { ok: false, code: 'ENDPOINT_UNREACHABLE', error: error?.message || 'Connection failed.' };
        }
        if (!textProbe.ok) {
          results.push({ modelId, textInput: 'unsupported', imageInput: 'unknown', error: { code: textProbe.code || 'TEXT_TEST_FAILED', message: textProbe.error, modelId } });
          continue;
        }
        let imageProbe;
        try {
          imageProbe = await probeModelConnection({
            protocol: provider.protocol,
            baseUrl: provider.endpoint,
            endpointUrl: textProbe.endpointUrl,
            apiKey,
            model: modelId,
            image: true,
            signal: probeSignal,
            retryPolicy: retry,
          });
        } catch (error) {
          if (probeSignal.aborted) throw error;
          imageProbe = { ok: false, imageUnsupported: false, error: error?.message || 'Image capability could not be determined.' };
        }
        results.push(imageProbe.ok
          ? { modelId, textInput: 'supported', imageInput: 'supported', error: null }
          : imageProbe.imageUnsupported
            ? { modelId, textInput: 'supported', imageInput: 'unsupported', error: null }
            : { modelId, textInput: 'supported', imageInput: 'unknown', error: { code: 'IMAGE_CAPABILITY_UNKNOWN', message: imageProbe.error, modelId } });
      }
      probeSignal.throwIfAborted();
      const status = testStatus(results);
      const record = { id: randomUUID(), userId, provider, retry, keyFingerprint: keyFingerprint(apiKey), models: results, status, testedAt: new Date().toISOString(), expiresAt: Date.now() + TEST_TTL_MS, error: aggregateError(results, status) };
      tests.set(record.id, record);
      return publicResult(record);
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      const message = timeoutController.signal.aborted ? timeoutError.message : (error?.message || 'Unable to test the model connection.');
      const completed = new Set(results.map((model) => model.modelId));
      for (const modelId of models) {
        if (completed.has(modelId)) continue;
        results.push({ modelId, textInput: 'unsupported', imageInput: 'unknown', error: { code: 'ENDPOINT_UNREACHABLE', message, modelId } });
      }
      const status = 'failed';
      const record = { id: randomUUID(), userId, provider, retry, keyFingerprint: keyFingerprint(apiKey), models: results, status, testedAt: new Date().toISOString(), expiresAt: Date.now() + TEST_TTL_MS, error: aggregateError(results, status) };
      tests.set(record.id, record);
      return publicResult(record);
    } finally {
      clearTimeout(timeout);
      release();
    }
  };
}

export async function modelConnectionTestsHandler(req, res) {
  let run;
  try { run = prepareConnectionTest(req.body || {}, req.user.id, req.allowPresetEndpointOverride === true); }
  catch (error) {
    if (error.status === 429) res.setHeader('Retry-After', String(error.retryAfterSeconds || 1));
    return apiError(res, error.status || 500, error.code, error.message);
  }
  const requestAbort = abortOnDisconnect(req, res);
  try { res.json(await run(requestAbort.signal)); }
  catch (error) { if (!requestAbort.signal.aborted) apiError(res, 500, 'TEST_FAILED', error.message); }
  finally { requestAbort.cleanup(); }
}

export function applyImageCapabilities(record, body) {
  const supplied = Array.isArray(body?.models) ? body.models : [];
  const normalizedSupplied = supplied.map((model) => ({
    ...model,
    modelId: text(model?.modelId),
  }));
  const unknown = record.models.filter((model) => model.imageInput === 'unknown').map((model) => model.modelId).sort();
  const received = normalizedSupplied.map((model) => model.modelId).sort();
  const validPayload = hasOnlyKeys(body, ['models'])
    && normalizedSupplied.every((model) => hasOnlyKeys(model, ['modelId', 'imageInput']) && model.modelId && ['supported', 'unsupported'].includes(model?.imageInput));
  if (!validPayload) {
    throw Object.assign(new Error('models must provide exactly every unknown image capability.'), { status: 400, code: 'INVALID_REQUEST' });
  }
  if (!unknown.length) {
    const manualCapabilities = record.manualImageCapabilities;
    const expected = manualCapabilities ? Object.keys(manualCapabilities).sort() : [];
    const isReplay = expected.length > 0
      && expected.length === received.length
      && expected.every((id, index) => id === received[index])
      && normalizedSupplied.every((model) => manualCapabilities[model.modelId] === model.imageInput);
    if (isReplay) return publicResult(record);
    throw Object.assign(new Error('models must provide exactly every unknown image capability.'), { status: 400, code: 'INVALID_REQUEST' });
  }
  if (unknown.length !== received.length || unknown.some((id, index) => id !== received[index])) {
    throw Object.assign(new Error('models must provide exactly every unknown image capability.'), { status: 400, code: 'INVALID_REQUEST' });
  }
  for (const model of record.models) {
    const suppliedModel = normalizedSupplied.find((item) => item.modelId === model.modelId);
    if (suppliedModel) { model.imageInput = suppliedModel.imageInput; model.error = null; }
  }
  record.manualImageCapabilities = Object.fromEntries(normalizedSupplied.map((model) => [model.modelId, model.imageInput]));
  record.status = testStatus(record.models);
  record.error = aggregateError(record.models, record.status);
  return publicResult(record);
}

export function imageCapabilitiesHandler(req, res) {
  const record = getTest(req, res); if (!record) return;
  try { return res.json(applyImageCapabilities(record, req.body)); }
  catch (error) { return apiError(res, error.status || 500, error.code, error.message); }
}

router.post('/model-connection-tests', modelConnectionTestsHandler);

router.put('/model-connection-tests/:testId/image-capabilities', imageCapabilitiesHandler);

router.put('/model-configuration', async (req, res) => {
  const record = getTest(req, res, text(req.body?.testId)); if (!record) return;
  if (record.status !== 'passed') return apiError(res, 409, 'TEST_NOT_PASSED', 'Complete a passing connection test before saving.');
  const provider = resolveProvider(req.body || {});
  const retry = retryPolicy(req.body?.retryPolicy);
  const submittedModels = Array.isArray(req.body?.models) ? req.body.models : [];
  if (!hasOnlyKeys(req.body, ['testId', 'providerId', 'protocol', 'endpoint', 'apiKey', 'models', 'retryPolicy']) || !provider || !retry || provider.providerId !== record.provider.providerId || provider.protocol !== record.provider.protocol || provider.endpoint !== record.provider.endpoint || submittedModels.length !== record.models.length || Object.keys(retry).some((key) => retry[key] !== record.retry[key])) {
    return apiError(res, 409, 'CONFIGURATION_MISMATCH', 'Configuration does not match the tested provider and models.');
  }
  const expected = new Map(record.models.map((model) => [model.modelId, model]));
  const submittedIds = submittedModels.map((model) => text(model?.modelId));
  if (new Set(submittedIds).size !== submittedIds.length || submittedIds.some((id) => !expected.has(id))) {
    return apiError(res, 409, 'CONFIGURATION_MISMATCH', 'Configuration does not match the tested provider and models.');
  }
  for (const submitted of submittedModels) {
    const tested = expected.get(text(submitted?.modelId));
    if (!hasOnlyKeys(submitted, ['modelId', 'textInput', 'imageInput']) || !tested || submitted.textInput !== true || submitted.imageInput !== (tested.imageInput === 'supported')) return apiError(res, 409, 'CONFIGURATION_MISMATCH', 'Model capabilities do not match the connection test.');
  }
  try {
    const outcome = await withPilotDeckConfigWrite(async () => {
      const recordConfig = readPilotDeckConfigFile();
      if (recordConfig.parseError) return { error: ['CONFIGURATION_MISMATCH', 'pilotdeck.yaml is invalid and must be repaired before saving.'] };
      const existingProvider = recordConfig.config?.model?.providers?.[provider.providerId] || {};
      const suppliedKey = req.body?.apiKey;
      let apiKey;
      if (presetIdFor(provider.providerId) === 'ollama') {
        if (typeof suppliedKey === 'string' && suppliedKey.trim()) {
          return { error: ['INVALID_REQUEST', 'Ollama does not use an apiKey.'] };
        }
        apiKey = '';
      } else if (suppliedKey === null) {
        apiKey = text(existingProvider.apiKey);
      } else if (typeof suppliedKey === 'string' && suppliedKey.trim()) {
        apiKey = suppliedKey.trim();
      } else {
        return { error: ['INVALID_REQUEST', 'apiKey is required for this provider.'] };
      }
      if (presetIdFor(provider.providerId) !== 'ollama' && !sameKey(record.keyFingerprint, apiKey)) {
        return { error: ['CONFIGURATION_MISMATCH', 'apiKey does not match the credential used for testing.'] };
      }
      const configurationId = `cfg_${randomUUID()}`;
      const savedAt = new Date().toISOString();
      const existingModels = existingProvider.models && typeof existingProvider.models === 'object' ? existingProvider.models : {};
      const modelsConfig = Object.fromEntries(record.models.map((model) => {
        const existingModel = existingModels[model.modelId] && typeof existingModels[model.modelId] === 'object' ? existingModels[model.modelId] : {};
        const existingMultimodal = existingModel.multimodal && typeof existingModel.multimodal === 'object' ? existingModel.multimodal : {};
        return [model.modelId, {
          ...existingModel,
          multimodal: { ...existingMultimodal, input: model.imageInput === 'supported' ? ['text', 'image'] : ['text'] },
        }];
      }));
      const defaultModelId = text(submittedModels[0]?.modelId);
      const savedProvider = {
        ...existingProvider,
        protocol: provider.protocol,
        url: provider.endpoint,
        retry: { ...(existingProvider.retry && typeof existingProvider.retry === 'object' ? existingProvider.retry : {}), requestMaxRetries: retry.maxRetries, streamMaxRetries: retry.maxStreamRetries, streamIdleTimeoutMs: retry.streamIdleTimeoutMs, baseDelayMs: retry.baseDelayMs, maxDelayMs: retry.maxDelayMs },
        models: { ...existingModels, ...modelsConfig },
      };
      if (presetIdFor(provider.providerId) === 'ollama') delete savedProvider.apiKey;
      else savedProvider.apiKey = apiKey;
      const nextConfig = {
        ...recordConfig.config,
        agent: { ...recordConfig.config.agent, model: `${provider.providerId}/${defaultModelId}` },
        model: { ...recordConfig.config.model, providers: { ...recordConfig.config.model.providers, [provider.providerId]: savedProvider } },
        webui: { ...recordConfig.config.webui, onboarding: { modelConfigurationId: configurationId, savedAt } },
      };
      suppressNextWatchEvent();
      const saved = await writePilotDeckConfig(nextConfig);
      return { saved, configurationId, savedAt };
    });
    if (outcome.error) return apiError(res, outcome.error[0] === 'INVALID_REQUEST' ? 400 : 409, outcome.error[0], outcome.error[1]);
    await reloadPilotDeckConfig(outcome.saved.config);
    tests.delete(record.id);
    return res.json({ configurationId: outcome.configurationId, savedAt: outcome.savedAt });
  } catch (error) {
    return apiError(res, 409, 'CONFIGURATION_MISMATCH', error?.message || 'Unable to save configuration.');
  }
});

router.post('/workspaces', async (req, res) => {
  const { addProjectManually } = await import('../projects.js');
  const { validateWorkspacePath, cloneGitHubRepository } = await import('./projects.js');
  const type = text(req.body?.type);
  const requestedPath = text(req.body?.path);
  if (!hasOnlyKeys(req.body, ['type', 'path', 'githubUrl', 'modelConfigurationId']) || !['existing', 'new'].includes(type) || !requestedPath || !path.isAbsolute(requestedPath)) return apiError(res, 400, 'INVALID_REQUEST', 'type and an absolute path are required.');
  if (type === 'existing' && req.body?.githubUrl != null) return apiError(res, 400, 'INVALID_REQUEST', 'githubUrl is only valid for new workspaces.');
  let cloneUrl = null;
  if (type === 'new' && Object.hasOwn(req.body || {}, 'githubUrl') && req.body.githubUrl !== null) {
    if (typeof req.body.githubUrl !== 'string' || !text(req.body.githubUrl)) return apiError(res, 400, 'INVALID_REQUEST', 'githubUrl must be a non-empty HTTP(S) or SSH URL.');
    cloneUrl = parseCloneUrl(text(req.body.githubUrl));
    if (!cloneUrl) return apiError(res, 400, 'INVALID_REQUEST', 'githubUrl must use HTTP(S) or SSH.');
  }
  if (Object.hasOwn(req.body || {}, 'modelConfigurationId') && req.body.modelConfigurationId !== null) {
    if (!text(req.body.modelConfigurationId)) return apiError(res, 400, 'INVALID_REQUEST', 'modelConfigurationId must be a non-empty string or null.');
    const configId = readPilotDeckConfigFile().config?.webui?.onboarding?.modelConfigurationId;
    if (req.body.modelConfigurationId !== configId) return apiError(res, 409, 'CONFIGURATION_MISMATCH', 'modelConfigurationId is not the active configuration.');
  }
  const validation = await validateWorkspacePath(requestedPath);
  if (!validation.valid) return apiError(res, 400, 'PATH_NOT_WRITABLE', validation.error || 'Invalid workspace path.');
  const workspacePath = validation.resolvedPath;
  try {
    if (type === 'existing') {
      const stat = await fs.stat(workspacePath);
      if (!stat.isDirectory()) return apiError(res, 400, 'PATH_NOT_FOUND', 'Workspace path is not a directory.');
      await fs.access(workspacePath, fsConstants.W_OK);
      const project = await addProjectManually(workspacePath);
      return res.status(201).json({ id: project.name, type, path: workspacePath, status: 'ready' });
    }
    try {
      const existing = await fs.stat(workspacePath);
      if (!existing.isDirectory()) return apiError(res, 409, 'WORKSPACE_CONFLICT', 'Workspace path already exists and is not a directory.');
      if ((await fs.readdir(workspacePath)).length > 0) return apiError(res, 409, 'WORKSPACE_CONFLICT', 'New workspace path must be empty.');
      await fs.access(workspacePath, fsConstants.W_OK);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await fs.mkdir(workspacePath, { recursive: true });
    }
    let projectPath = workspacePath;
    if (cloneUrl) {
      const release = cloneInFlight.tryAcquire(req.user.id);
      if (!release) {
        res.setHeader('Retry-After', '1');
        return apiError(res, 429, 'RATE_LIMITED', 'Too many workspace clones are already running.');
      }
      const requestAbort = abortOnDisconnect(req, res);
      const repoName = path.basename(cloneUrl.path.replace(/\/$/, '').replace(/\.git$/, '')) || 'repository';
      projectPath = path.join(workspacePath, repoName);
      try {
        try { await fs.access(projectPath); return apiError(res, 409, 'WORKSPACE_CONFLICT', 'Clone destination already exists.'); } catch { /* expected */ }
        const lockPath = `${projectPath}.pilotdeck-clone.lock`;
        let lockHandle;
        try {
          lockHandle = await fs.open(lockPath, 'wx');
          await lockHandle.close();
        } catch {
          return apiError(res, 409, 'WORKSPACE_CONFLICT', 'A clone is already in progress for this destination.');
        }
        const stagingPath = path.join(workspacePath, `.${repoName}.pilotdeck-clone-${randomUUID()}`);
        try {
          await cloneGitHubRepository(cloneUrl.url, stagingPath, null, { signal: requestAbort.signal, timeoutMs: CLONE_TIMEOUT_MS });
          requestAbort.signal.throwIfAborted();
          await fs.rename(stagingPath, projectPath);
        } catch (error) {
          try { await fs.rm(stagingPath, { recursive: true, force: true }); } catch { /* Staging path is owned by this request. */ }
          if (requestAbort.signal.aborted) return;
          if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') {
            return apiError(res, 409, 'WORKSPACE_CONFLICT', 'Clone destination already exists.');
          }
          return apiError(res, 409, 'GIT_CLONE_FAILED', error?.code === 'GIT_CLONE_TIMEOUT' ? 'Repository clone timed out.' : 'Unable to clone the repository.');
        } finally {
          try { await fs.unlink(lockPath); } catch { /* Do not mask the clone result if lock cleanup fails. */ }
        }
      } finally {
        requestAbort.cleanup();
        release();
      }
    }
    const project = await addProjectManually(projectPath);
    return res.status(201).json({ id: project.name, type, path: projectPath, status: 'ready' });
  } catch (error) {
    if (['EACCES', 'EPERM', 'EROFS'].includes(error?.code)) return apiError(res, 400, 'PATH_NOT_WRITABLE', 'Workspace path is not writable.');
    if (error?.code === 'ENOENT') return apiError(res, 400, 'PATH_NOT_FOUND', 'Workspace path does not exist.');
    return apiError(res, 409, 'WORKSPACE_CONFLICT', error?.message || 'Unable to create workspace.');
  }
});

export { CLONE_TIMEOUT_MS, TEST_TTL_MS, tests };
export default router;
