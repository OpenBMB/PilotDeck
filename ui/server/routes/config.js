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
  hasUnresolvedMaskedSecrets,
  maskSecrets,
  parseConfigYaml,
  preserveMaskedSecrets,
  rawYamlToMaskedString,
  readPilotDeckConfigFile,
  resolveConfiguredProviderApiKey,
  serializePilotDeckConfigResponse,
  withPilotDeckConfigWrite,
  validatePilotDeckConfig,
  writePilotDeckConfig,
  writeRawPilotDeckYaml,
} from '../services/pilotdeckConfig.js';
import { reloadPilotDeckConfig } from '../services/pilotdeckConfigReloader.js';
import { suppressNextWatchEvent } from '../services/pilotdeckConfigWatcher.js';
import { getPilotDeckGateway } from '../pilotdeck-bridge.js';
import {
  buildProviderModelsEndpointCandidates,
  isExpectedProviderModelsResponseShape,
} from '../../../src/model/providerEndpoint.js';
import { lookupCatalogProvider } from '../../../src/model/catalog/index.js';
import { NetworkFetchError, networkFetch } from '../../../src/network/fetch.js';
import { lookupCatalogModel } from '../../../src/model/catalog/lookup.js';
import { probeModelConnection } from '../services/modelConnectionProbe.js';
import {
  configuredModelIds,
  findModelReferences,
  rewriteModelReferences,
} from '../services/modelReferences.js';
import {
  imageCapabilitiesHandler,
  connectionTestMatchesProvider,
  getConnectionTestRecord,
  modelConnectionTestsHandler,
  modelTestRateLimiter,
} from './onboarding.js';
import {
  OFFICE_PREVIEW_SERVICE_BUILTIN,
  OFFICE_PREVIEW_SERVICE_LIBREOFFICE,
  getConfiguredOfficePreviewSettings,
  getLibreOfficeCandidateStatuses,
  getLibreOfficeStatus,
} from '../services/officePreview.js';

async function notifyGatewayConfigReload() {
  try {
    const gw = await getPilotDeckGateway();
    if (gw?.reloadConfig) await gw.reloadConfig();
  } catch { /* gateway unreachable — self-watch will pick up the change */ }
}

const router = express.Router();

const MASKED_SECRET = '********';
const DEFAULT_GLM_WEB_SEARCH_ENDPOINT = 'https://api.z.ai/api/paas/v4/web_search';
const DEFAULT_TAVILY_WEB_SEARCH_ENDPOINT = 'https://api.tavily.com/search';
const DEFAULT_SERPER_WEB_SEARCH_ENDPOINT = 'https://google.serper.dev/search';
const DEFAULT_BRAVE_WEB_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';

function normalizeProviderProtocol(value) {
  const protocol = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (protocol === 'responses') return 'openai-responses';
  if (protocol === 'openai-chat' || protocol === 'chat' || protocol === 'litellm') return 'openai';
  return protocol;
}

function canonicalProviderEndpoint(value) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  if (!candidate) return '';
  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function providerCredentialScopeMatches(providerId, provider, protocol, endpoint, allowOriginMatch) {
  const catalog = lookupCatalogProvider(providerId);
  const expectedProtocol = normalizeProviderProtocol(provider?.protocol || catalog?.protocol);
  const expectedEndpoint = canonicalProviderEndpoint(provider?.url || catalog?.defaultUrl);
  const requestedProtocol = normalizeProviderProtocol(protocol || catalog?.protocol);
  const requestedEndpoint = canonicalProviderEndpoint(endpoint || catalog?.defaultUrl);
  if (!expectedProtocol || !expectedEndpoint || !requestedProtocol || !requestedEndpoint) return false;
  if (expectedProtocol !== requestedProtocol) return false;
  if (expectedEndpoint === requestedEndpoint) return true;
  if (!allowOriginMatch) return false;
  return new URL(expectedEndpoint).origin === new URL(requestedEndpoint).origin;
}

function resolveProviderRequestApiKey({
  providerId,
  submittedApiKey,
  protocol,
  endpoint,
  allowOriginMatch = false,
}) {
  const normalizedProviderId = typeof providerId === 'string' ? providerId.trim() : '';
  const requested = typeof submittedApiKey === 'string' ? submittedApiKey.trim() : '';
  if (requested && requested !== MASKED_SECRET) {
    return {
      apiKey: resolveConfiguredProviderApiKey(normalizedProviderId, { apiKey: requested }),
    };
  }

  let savedProvider = null;
  if (normalizedProviderId) {
    try {
      const record = readPilotDeckConfigFile();
      savedProvider = record.config?.model?.providers?.[normalizedProviderId] ?? null;
    } catch { /* Fall through to the catalog environment fallback. */ }
  }

  if (requested === MASKED_SECRET) {
    if (
      !savedProvider
      || !providerCredentialScopeMatches(
        normalizedProviderId,
        savedProvider,
        protocol,
        endpoint,
        allowOriginMatch,
      )
    ) {
      return {
        error: 'Enter the provider API key again after changing its protocol or endpoint.',
      };
    }
    return {
      apiKey: resolveConfiguredProviderApiKey(normalizedProviderId, savedProvider),
    };
  }

  // An explicitly blank key means "use this catalog provider's environment
  // variable". Do not silently fall back to a previously saved literal key.
  const environmentApiKey = resolveConfiguredProviderApiKey(normalizedProviderId, null);
  if (!environmentApiKey) return { apiKey: '' };
  const scopeProvider = lookupCatalogProvider(normalizedProviderId);
  if (
    !scopeProvider
    || !providerCredentialScopeMatches(
      normalizedProviderId,
      scopeProvider,
      protocol,
      endpoint,
      allowOriginMatch,
    )
  ) {
    return {
      error: 'Enter the provider API key explicitly after changing its protocol or endpoint.',
    };
  }
  return { apiKey: environmentApiKey };
}

function catalogImageSupport(providerId, modelId) {
  const provider = String(providerId || '').trim();
  const model = String(modelId || '').trim();
  if (!provider || !model) return null;
  const result = lookupCatalogModel(provider, model);
  if (!result.model) return null;
  return Array.isArray(result.model.multimodal?.input) && result.model.multimodal.input.includes('image');
}

function imageSupportResultFromCatalog(supported) {
  return {
    status: supported ? 'supported' : 'unsupported',
    supported,
    source: 'catalog',
    retryable: false,
    manualConfirmationAllowed: false,
  };
}

function imageSupportResultFromProbe(probe) {
  if (probe.ok) {
    return {
      status: 'supported',
      supported: true,
      source: 'probe',
      retryable: false,
      manualConfirmationAllowed: false,
    };
  }
  if (probe.imageUnsupported) {
    return {
      status: 'unsupported',
      supported: false,
      source: 'probe',
      reasonCode: 'explicit_unsupported',
      retryable: false,
      manualConfirmationAllowed: false,
      ...(probe.error ? { message: probe.error } : {}),
    };
  }
  return {
    status: 'detection_failed',
    supported: null,
    source: 'probe',
    reasonCode: probe.code || 'ENDPOINT_UNREACHABLE',
    retryable: true,
    manualConfirmationAllowed: true,
    ...(probe.error ? { message: probe.error } : {}),
  };
}

function normalizeWebSearchProvider(provider) {
  return ['glm', 'tavily', 'custom', 'serper', 'brave'].includes(provider) ? provider : 'glm';
}

function isWebSearchProvider(provider) {
  return ['glm', 'tavily', 'custom', 'serper', 'brave'].includes(provider);
}

function normalizeWebSearchCustomAuth(auth) {
  return auth === 'bodyApiKey' || auth === 'queryApiKey' || auth === 'none' ? auth : 'bearer';
}

function normalizeWebSearchEndpoint(provider, endpoint) {
  const trimmed = typeof endpoint === 'string' ? endpoint.trim() : '';
  const effective = trimmed || (
    provider === 'tavily'
      ? DEFAULT_TAVILY_WEB_SEARCH_ENDPOINT
      : provider === 'serper'
        ? DEFAULT_SERPER_WEB_SEARCH_ENDPOINT
        : provider === 'brave'
          ? DEFAULT_BRAVE_WEB_SEARCH_ENDPOINT
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

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function containsMaskedValue(value) {
  if (value === MASKED_SECRET) return true;
  if (Array.isArray(value)) return value.some(containsMaskedValue);
  if (!isRecord(value)) return false;
  return Object.values(value).some(containsMaskedValue);
}

function modelProviderCredentialScope(providerId, provider) {
  const catalog = lookupCatalogProvider(providerId);
  return {
    protocol: normalizeProviderProtocol(provider?.protocol || catalog?.protocol),
    endpoint: canonicalProviderEndpoint(provider?.url || catalog?.defaultUrl),
  };
}

function validateMaskedModelProviderKeyReuse(nextConfig, previousConfig) {
  const nextProviders = nextConfig?.model?.providers;
  const previousProviders = previousConfig?.model?.providers;
  if (!isRecord(nextProviders) || !isRecord(previousProviders)) return null;

  for (const [providerId, nextProvider] of Object.entries(nextProviders)) {
    if (nextProvider?.apiKey !== MASKED_SECRET) continue;
    const previousProvider = previousProviders[providerId];
    if (!isRecord(previousProvider)) continue;
    if (
      JSON.stringify(modelProviderCredentialScope(providerId, nextProvider))
      !== JSON.stringify(modelProviderCredentialScope(providerId, previousProvider))
    ) {
      return `Enter the API key again after changing provider ${providerId}'s protocol or URL.`;
    }
  }
  return null;
}

function restoreRenamedProviderSecrets(nextConfig, previousConfig, rawRenames) {
  if (rawRenames === undefined) return { config: nextConfig };
  if (!Array.isArray(rawRenames) || rawRenames.length > 100) {
    return { error: 'providerRenames must be an array with at most 100 entries.', code: 'RENAME_INVALID' };
  }
  if (rawRenames.length === 0) return { config: nextConfig };

  const nextProviders = nextConfig?.model?.providers;
  const previousProviders = previousConfig?.model?.providers;
  if (!isRecord(nextProviders) || !isRecord(previousProviders)) {
    return { error: 'Cannot restore provider secrets without valid provider maps.' };
  }

  for (const rename of rawRenames) {
    const from = typeof rename?.from === 'string' ? rename.from.trim() : '';
    const to = typeof rename?.to === 'string' ? rename.to.trim() : '';
    if (!from || !to || from === to) {
      return { error: 'Each provider rename must contain distinct non-empty from/to IDs.', code: 'RENAME_INVALID' };
    }

    const previousProvider = previousProviders[from];
    const nextProvider = nextProviders[to];
    if (
      !isRecord(previousProvider)
      || !isRecord(nextProvider)
      || previousProviders[to] !== undefined
      || nextProviders[from] !== undefined
    ) {
      return { error: `Provider rename ${from} -> ${to} does not match the saved configuration.`, code: 'RENAME_INVALID' };
    }

    if (!containsMaskedValue(nextProvider)) continue;
    if (
      JSON.stringify(modelProviderCredentialScope(from, previousProvider))
      !== JSON.stringify(modelProviderCredentialScope(to, nextProvider))
    ) {
      return {
        error: `Enter provider credentials again when renaming ${from} to ${to} and changing its protocol or URL.`,
      };
    }

    nextProviders[to] = preserveMaskedSecrets(nextProvider, previousProvider);
  }

  return { config: nextConfig };
}

function normalizeRenameEntries(raw, field) {
  if (raw === undefined) return { entries: [] };
  if (!Array.isArray(raw) || raw.length > 100) {
    return { error: `${field} must be an array with at most 100 entries.`, code: 'RENAME_INVALID' };
  }
  return {
    entries: raw.map((entry) => ({
      from: typeof entry?.from === 'string' ? entry.from.trim() : '',
      to: typeof entry?.to === 'string' ? entry.to.trim() : '',
      ...(field === 'modelRenames' ? {
        providerId: typeof entry?.providerId === 'string' ? entry.providerId.trim() : '',
      } : {}),
    })),
  };
}

function applyRenameMetadata(nextConfig, previousConfig, rawProviderRenames, rawModelRenames) {
  if (rawProviderRenames === undefined && rawModelRenames === undefined) return { config: nextConfig };
  const providers = nextConfig?.model?.providers;
  const previousProviders = previousConfig?.model?.providers;
  if (!isRecord(providers) || !isRecord(previousProviders)) {
    return { error: 'Cannot apply provider/model renames without valid provider maps.', code: 'RENAME_INVALID' };
  }
  const providerResult = normalizeRenameEntries(rawProviderRenames, 'providerRenames');
  if (providerResult.error) return providerResult;
  const modelResult = normalizeRenameEntries(rawModelRenames, 'modelRenames');
  if (modelResult.error) return modelResult;

  const providerRenames = new Map();
  const seenProviderSources = new Set();
  const seenProviderTargets = new Set();
  for (const rename of providerResult.entries) {
    if (!rename.from || !rename.to || rename.from === rename.to
      || seenProviderSources.has(rename.from) || seenProviderTargets.has(rename.to)
      || !isRecord(previousProviders[rename.from]) || previousProviders[rename.to] !== undefined
      || !isRecord(providers[rename.to]) || providers[rename.from] !== undefined) {
      return { error: 'Provider rename metadata does not match the saved configuration.', code: 'RENAME_INVALID' };
    }
    seenProviderSources.add(rename.from);
    seenProviderTargets.add(rename.to);
    providerRenames.set(rename.from, rename.to);
  }

  const modelRenames = new Map();
  const seenModelSources = new Set();
  const seenModelTargets = new Set();
  for (const rename of modelResult.entries) {
    const providerId = rename.providerId;
    const sourceProviderId = [...providerRenames.entries()].find(([, to]) => to === providerId)?.[0] || providerId;
    const previousModels = previousProviders[sourceProviderId]?.models;
    const nextModels = providers[providerId]?.models;
    const sourceKey = `${sourceProviderId}/${rename.from}`;
    const targetKey = `${providerId}/${rename.to}`;
    if (!providerId || !rename.from || !rename.to || rename.from === rename.to
      || seenModelSources.has(sourceKey) || seenModelTargets.has(targetKey)
      || !isRecord(previousModels) || previousModels[rename.from] === undefined
      || previousModels[rename.to] !== undefined || !isRecord(nextModels)
      || nextModels[rename.to] === undefined || nextModels[rename.from] !== undefined) {
      return { error: 'Model rename metadata does not match the saved configuration.', code: 'RENAME_INVALID' };
    }
    seenModelSources.add(sourceKey);
    seenModelTargets.add(targetKey);
    modelRenames.set(sourceKey, { providerId, modelId: rename.to });
  }

  rewriteModelReferences(nextConfig, { providerRenames, modelRenames });
  return { config: nextConfig };
}

function findDeletedModelReferences(previousConfig, nextConfig) {
  const previous = configuredModelIds(previousConfig);
  const next = configuredModelIds(nextConfig);
  for (const [providerId, previousModels] of previous) {
    if (!next.has(providerId)) {
      const references = findModelReferences(nextConfig, { providerId });
      if (references.length) return { providerId, references };
      continue;
    }
    for (const modelId of previousModels) {
      if (!next.get(providerId).has(modelId)) {
        const references = findModelReferences(nextConfig, { providerId, modelId });
        if (references.length) return { providerId, modelId, references };
      }
    }
  }
  return null;
}

function bindModelConnectionTests(config, bindings, userId) {
  if (bindings === undefined) return { config, bound: new Set() };
  if (!Array.isArray(bindings) || bindings.some((item) => !item || typeof item !== 'object' || Array.isArray(item) || typeof item.testId !== 'string' || Object.keys(item).some((key) => key !== 'testId'))) {
    return { error: { status: 400, code: 'INVALID_REQUEST', message: 'modelTestBindings must contain testId objects.' } };
  }
  const bound = new Set();
  for (const binding of bindings) {
    const result = getConnectionTestRecord(userId, binding.testId.trim());
    if (result.reason === 'expired') return { error: { status: 410, code: 'TEST_EXPIRED', message: 'Connection test has expired.' } };
    const record = result.record;
    if (!record) return { error: { status: 404, code: 'TEST_NOT_FOUND', message: 'Connection test was not found.' } };
    if (record.status !== 'passed') return { error: { status: 409, code: 'TEST_NOT_PASSED', message: 'Complete a passing connection test before saving.' } };
    const provider = config?.model?.providers?.[record.provider.providerId];
    const testedProvider = provider && {
      ...provider,
      providerId: record.provider.providerId,
      apiKey: resolveConfiguredProviderApiKey(record.provider.providerId, provider),
    };
    if (!provider || !connectionTestMatchesProvider(record, testedProvider)) {
      return { error: { status: 409, code: 'CONFIGURATION_MISMATCH', message: 'Configuration does not match the tested provider.' } };
    }
    for (const tested of record.models) {
      const model = provider.models?.[tested.modelId];
      if (!model || typeof model !== 'object' || tested.textInput !== 'supported' || !['supported', 'unsupported'].includes(tested.imageInput)) {
        return { error: { status: 409, code: 'CONFIGURATION_MISMATCH', message: 'Configuration does not match the tested models.' } };
      }
      model.connectionTest = {
        status: 'passed',
        textInput: tested.textInput,
        imageInput: tested.imageInput,
        testedAt: record.testedAt,
      };
      const multimodal = isRecord(model.multimodal) ? { ...model.multimodal } : {};
      multimodal.input = tested.imageInput === 'supported' ? ['text', 'image'] : ['text'];
      model.multimodal = multimodal;
      bound.add(`${record.provider.providerId}/${tested.modelId}`);
    }
  }
  return { config, bound };
}

function renamedSourceModelId(providerId, modelId, rawProviderRenames, rawModelRenames) {
  const modelRename = Array.isArray(rawModelRenames)
    ? rawModelRenames.find((entry) => entry?.providerId === providerId && entry?.to === modelId)
    : null;
  if (modelRename) {
    const providerRename = Array.isArray(rawProviderRenames)
      ? rawProviderRenames.find((entry) => entry?.to === providerId)
      : null;
    return {
      providerId: providerRename?.from || providerId,
      modelId: modelRename.from,
    };
  }
  const providerRename = Array.isArray(rawProviderRenames)
    ? rawProviderRenames.find((entry) => entry?.to === providerId)
    : null;
  return providerRename ? { providerId: providerRename.from, modelId } : null;
}

function validateNewReferencedModelBindings(previousConfig, nextConfig, bound, rawProviderRenames, rawModelRenames) {
  const references = findModelReferences(nextConfig);
  for (const reference of references) {
    // Connection tests are enforced when a model becomes the primary Agent
    // model. Other settings references reuse the model-level test state and
    // must not require each editor to submit a duplicate binding.
    if (reference.path !== 'agent.model') continue;
    const [providerId, ...modelParts] = String(reference.value || '').split('/');
    const modelId = modelParts.join('/');
    const renamedSource = renamedSourceModelId(providerId, modelId, rawProviderRenames, rawModelRenames);
    const key = `${providerId}/${modelId}`;
    const previousProviderId = renamedSource?.providerId || providerId;
    const previousModelId = renamedSource?.modelId || modelId;
    const wasPreviouslyReferenced = findModelReferences(previousConfig, {
      providerId: previousProviderId,
      modelId: previousModelId,
    }).some((previousReference) => (
      previousReference.path !== 'agent.subagents.default'
      && previousReference.path !== 'memory.model'
    ));
    const model = nextConfig?.model?.providers?.[providerId]?.models?.[modelId];
    const hasPassingTest = isRecord(model?.connectionTest) && model.connectionTest.status === 'passed';
    if (!wasPreviouslyReferenced && !hasPassingTest && !bound.has(key)) {
      return { providerId, modelId, reference };
    }
  }
  return null;
}

function broadcastConfigEvent(payload) {
  process.emit('pilotdeck:config-broadcast', payload);
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
    res.json(serializePilotDeckConfigResponse(record));
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

router.get('/model-references', (req, res) => {
  const providerId = typeof req.query?.providerId === 'string' ? req.query.providerId.trim() : '';
  const modelId = typeof req.query?.modelId === 'string' ? req.query.modelId.trim() : '';
  if (!providerId || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(providerId)
    || (modelId && /\s/.test(modelId))) {
    return res.status(400).json({ code: 'INVALID_REQUEST', message: 'providerId and modelId must be valid model identifiers.' });
  }
  try {
    const record = readPilotDeckConfigFile();
    if (record.parseError) {
      return res.status(400).json({ code: 'INVALID_REQUEST', message: 'pilotdeck.yaml is invalid.' });
    }
    return res.json({ providerId, ...(modelId ? { modelId } : {}), references: findModelReferences(record.config, { providerId, modelId }) });
  } catch (error) {
    return res.status(500).json({ code: 'CONFIG_READ_FAILED', message: error instanceof Error ? error.message : String(error) });
  }
});

router.get('/office-preview/status', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const configuredPreview = getConfiguredOfficePreviewSettings();
    const [libreOffice, candidates] = await Promise.all([
      getLibreOfficeStatus({ forceRefresh }),
      getLibreOfficeCandidateStatuses({ forceRefresh }),
    ]);
    res.json({
      service: configuredPreview.service,
      configuredBinaryPath: configuredPreview.binaryPath,
      libreOffice: {
        ...libreOffice,
        candidates,
      },
      supportedServices: [
        OFFICE_PREVIEW_SERVICE_BUILTIN,
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
  await withPilotDeckConfigWrite(async () => {
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
    const baseRevision = typeof req.body?.baseRevision === 'string'
      ? req.body.baseRevision.trim()
      : '';
    if (baseRevision) {
      const currentRevision = serializePilotDeckConfigResponse(diskRecord).revision;
      if (baseRevision !== currentRevision) {
        return res.status(409).json({
          error: 'Config changed since this settings draft was loaded. Refresh and apply the change again.',
          code: 'CONFIG_CONFLICT',
          currentRevision,
        });
      }
    }
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
      const renamedProviders = restoreRenamedProviderSecrets(
        parsed,
        diskRecord.rawYaml ?? {},
        req.body?.providerRenames,
      );
      if (renamedProviders.error) {
        return res.status(400).json({ error: renamedProviders.error, ...(renamedProviders.code ? { code: renamedProviders.code } : {}) });
      }
      const renamedConfig = renamedProviders.config;
      const maskedProviderKeyError = validateMaskedModelProviderKeyReuse(
        renamedConfig,
        diskRecord.rawYaml ?? {},
      );
      if (maskedProviderKeyError) {
        return res.status(400).json({ error: maskedProviderKeyError });
      }
      const maskedKeyError = validateMaskedWebSearchKeyReuse(renamedConfig, diskRecord.rawYaml ?? {});
      if (maskedKeyError) {
        return res.status(400).json({ error: maskedKeyError });
      }
      // Re-hydrate any field the UI received as "********" with the
      // original disk value so saving the masked view back is a no-op
      // for secrets the user didn't actually touch.
      const restored = diskRecord.parseError
        ? renamedConfig
        : preserveMaskedSecrets(renamedConfig, diskRecord.rawYaml ?? {});
      if (hasUnresolvedMaskedSecrets(restored)) {
        return res.status(400).json({
          error: 'One or more masked secrets could not be restored. Enter those credentials again before saving.',
        });
      }
      const renamed = applyRenameMetadata(
        restored,
        diskRecord.config,
        req.body?.providerRenames,
        req.body?.modelRenames,
      );
      if (renamed.error) return res.status(400).json({ error: renamed.error, code: renamed.code });
      const testBinding = bindModelConnectionTests(renamed.config, req.body?.modelTestBindings, req.user?.id || '');
      if (testBinding.error) return res.status(testBinding.error.status).json({ error: testBinding.error.message, code: testBinding.error.code, message: testBinding.error.message });
      const invalidTestReference = diskRecord.parseError
        ? null
        : validateNewReferencedModelBindings(
          diskRecord.config,
          renamed.config,
          testBinding.bound,
          req.body?.providerRenames,
          req.body?.modelRenames,
        );
      if (invalidTestReference) {
        return res.status(409).json({
          error: 'Referenced model must have a passing connection test.',
          code: 'MODEL_TEST_REQUIRED',
          providerId: invalidTestReference.providerId,
          modelId: invalidTestReference.modelId,
          reference: invalidTestReference.reference.path,
        });
      }
      const deletedReference = findDeletedModelReferences(diskRecord.config, renamed.config);
      if (deletedReference) {
        return res.status(409).json({
          error: 'Provider or model is still referenced by the current configuration.',
          code: 'MODEL_IN_USE',
          providerId: deletedReference.providerId,
          ...(deletedReference.modelId ? { modelId: deletedReference.modelId } : {}),
          references: deletedReference.references,
        });
      }
      suppressNextWatchEvent();
      saved = await writeRawPilotDeckYaml(renamed.config, {
        previousConfig: diskRecord.config,
      });
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
      const renamedProviders = restoreRenamedProviderSecrets(
        req.body.config,
        diskRecord.config,
        req.body?.providerRenames,
      );
      if (renamedProviders.error) {
        return res.status(400).json({ error: renamedProviders.error, ...(renamedProviders.code ? { code: renamedProviders.code } : {}) });
      }
      const renamedConfig = renamedProviders.config;
      const maskedProviderKeyError = validateMaskedModelProviderKeyReuse(
        renamedConfig,
        diskRecord.config,
      );
      if (maskedProviderKeyError) {
        return res.status(400).json({ error: maskedProviderKeyError });
      }
      const maskedKeyError = validateMaskedWebSearchKeyReuse(renamedConfig, diskRecord.config);
      if (maskedKeyError) {
        return res.status(400).json({ error: maskedKeyError });
      }
      const restored = preserveMaskedSecrets(renamedConfig, diskRecord.config);
      if (hasUnresolvedMaskedSecrets(restored)) {
        return res.status(400).json({
          error: 'One or more masked secrets could not be restored. Enter those credentials again before saving.',
        });
      }
      const renamed = applyRenameMetadata(
        restored,
        diskRecord.config,
        req.body?.providerRenames,
        req.body?.modelRenames,
      );
      if (renamed.error) return res.status(400).json({ error: renamed.error, code: renamed.code });
      const testBinding = bindModelConnectionTests(renamed.config, req.body?.modelTestBindings, req.user?.id || '');
      if (testBinding.error) return res.status(testBinding.error.status).json({ error: testBinding.error.message, code: testBinding.error.code, message: testBinding.error.message });
      const invalidTestReference = diskRecord.parseError
        ? null
        : validateNewReferencedModelBindings(
          diskRecord.config,
          renamed.config,
          testBinding.bound,
          req.body?.providerRenames,
          req.body?.modelRenames,
        );
      if (invalidTestReference) {
        return res.status(409).json({
          error: 'Referenced model must have a passing connection test.',
          code: 'MODEL_TEST_REQUIRED',
          providerId: invalidTestReference.providerId,
          modelId: invalidTestReference.modelId,
          reference: invalidTestReference.reference.path,
        });
      }
      const deletedReference = findDeletedModelReferences(diskRecord.config, renamed.config);
      if (deletedReference) {
        return res.status(409).json({
          error: 'Provider or model is still referenced by the current configuration.',
          code: 'MODEL_IN_USE',
          providerId: deletedReference.providerId,
          ...(deletedReference.modelId ? { modelId: deletedReference.modelId } : {}),
          references: deletedReference.references,
        });
      }
      suppressNextWatchEvent();
      saved = await writePilotDeckConfig(renamed.config, {
        previousConfig: diskRecord.config,
      });
    } else {
      return res.status(400).json({ error: 'raw YAML or config object is required' });
    }

    const reloadResult = await reloadPilotDeckConfig(saved.config);
    void notifyGatewayConfigReload();
    // Re-read disk so the response's `raw` field comes from the actual
    // (lossless) file rather than the lossy round-trip output, and so
    // `serializePilotDeckConfigResponse` has a `rawYaml` to render the full view.
    const freshRecord = readPilotDeckConfigFile();
    const response = serializePilotDeckConfigResponse(freshRecord, reloadResult);
    broadcastConfigEvent({ source: 'ui-save', ...response, timestamp: new Date().toISOString() });
    res.json(response);
    } catch (error) {
      if (error?.validation) {
        return res.status(400).json({
          error: error.message,
          code: 'CONFIG_VALIDATION_FAILED',
          validation: error.validation,
        });
      }
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
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
    const reloadResult = await reloadPilotDeckConfig(record.config);
    void notifyGatewayConfigReload();
    const response = serializePilotDeckConfigResponse(record, reloadResult);
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
  if (!baseUrl) {
    return res.status(400).json({ ok: false, error: 'baseUrl is required' });
  }

  const normalizedType = String(providerType || '').toLowerCase();
  const isAnthropic = normalizedType === 'anthropic';
  const isGoogle = normalizedType === 'google';
  const isOpenAIResponses = normalizedType === 'openai-responses' || normalizedType === 'responses';
  const normalizedBaseUrl = String(baseUrl).trim().replace(/\/+$/, '');
  const protocol = isGoogle
    ? 'google'
    : isAnthropic
      ? 'anthropic'
      : isOpenAIResponses
        ? 'openai-responses'
        : 'openai';
  const credential = resolveProviderRequestApiKey({
    providerId,
    submittedApiKey: apiKey,
    protocol,
    endpoint: normalizedBaseUrl,
    // Some providers expose their model list at a path beside, rather than
    // below, the configured inference base URL.
    allowOriginMatch: true,
  });
  if (credential.error) {
    return res.status(400).json({
      ok: false,
      code: 'CREDENTIAL_SCOPE_MISMATCH',
      error: credential.error,
    });
  }
  const effectiveApiKey = credential.apiKey;
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
    if (!response.ok) {
      let body = {};
      try {
        body = responseText ? JSON.parse(responseText) : {};
      } catch { /* Use the upstream response text below. */ }
      const message = body?.error?.message || body?.message || responseText || `HTTP ${response.status}`;
      return res.status(response.status).json({ ok: false, error: message });
    }
    let body;
    try {
      body = responseText ? JSON.parse(responseText) : {};
    } catch {
      return res.status(502).json({ ok: false, error: `Expected JSON from ${url}, but received non-JSON content.` });
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
  const apiKeyRequired = normalizedProviderId !== 'ollama';
  if (!baseUrl || !model) {
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
  const protocol = isGoogle
    ? 'google'
    : isAnthropic
      ? 'anthropic'
      : isOpenAIResponses
        ? 'openai-responses'
        : 'openai';
  const credential = resolveProviderRequestApiKey({
    providerId,
    submittedApiKey: apiKey,
    protocol,
    endpoint: normalizedBaseUrl,
  });
  if (credential.error) {
    return res.status(400).json({
      ok: false,
      code: 'CREDENTIAL_SCOPE_MISMATCH',
      error: credential.error,
    });
  }
  const effectiveApiKey = credential.apiKey;
  if (apiKeyRequired && !effectiveApiKey) {
    return res.status(400).json({
      ok: false,
      error: 'baseUrl, apiKey, and model are required',
    });
  }

  // Keep the long-standing response body while sharing the protocol request
  // construction and endpoint fallback logic with the versioned onboarding API.
  const probe = await probeModelConnection({
    protocol,
    baseUrl: normalizedBaseUrl,
    apiKey: effectiveApiKey,
    model,
    maxTokens: isOpenAIResponses ? 16 : 8,
  });
  if (probe.ok) {
    if (req.body?.skipImage === true) {
      return res.json({
        ok: true,
        message: `Connected successfully — Model ${model} is available.`,
        supportsImage: null,
        imageCheckSource: null,
      });
    }
    const catalogSupport = catalogImageSupport(normalizedProviderId, model);
    if (catalogSupport !== null) {
      const imageSupport = imageSupportResultFromCatalog(catalogSupport);
      return res.json({
        ok: true,
        message: `Connected successfully — Model ${model} is available.`,
        imageSupport,
        supportsImage: imageSupport.supported,
        imageCheckSource: imageSupport.source,
      });
    }
    const imageProbe = await probeModelConnection({
      protocol,
      baseUrl: normalizedBaseUrl,
      endpointUrl: probe.endpointUrl,
      apiKey: effectiveApiKey,
      model,
      image: true,
      maxTokens: 16,
    });
    const imageSupport = imageSupportResultFromProbe(imageProbe);
    return res.json({
      ok: true,
      message: `Connected successfully — Model ${model} is available.`,
      imageSupport,
      supportsImage: imageSupport.supported,
      imageCheckSource: imageSupport.source,
    });
  }
  return res.json({ ok: false, error: probe.error });

});

// Settings model-pool routes reuse the onboarding probe lifecycle while
// exposing the API under /api/config for the settings UI.
async function configModelConnectionTestsHandler(req, res) {
  req.allowPresetEndpointOverride = true;
  const credential = resolveProviderRequestApiKey({
    providerId: req.body?.providerId,
    submittedApiKey: req.body?.apiKey,
    protocol: req.body?.protocol,
    endpoint: req.body?.endpoint,
  });
  if (credential.error) {
    return res.status(400).json({
      code: 'CREDENTIAL_SCOPE_MISMATCH',
      message: credential.error,
    });
  }
  req.body = { ...req.body, apiKey: credential.apiKey };
  return modelConnectionTestsHandler(req, res);
}
router.post('/test-connections', modelTestRateLimiter, configModelConnectionTestsHandler);
router.put('/test-connections/:testId/image-capabilities', imageCapabilitiesHandler);

/**
 * Probe the configured web-search provider. Mirrors
 * `src/tool/builtin/webSearch.ts`'s five-provider request shape. Returns:
 * `{ ok, error?, latencyMs?, organicCount? }` to match the convention
 * established by `/test-connection`.
 */
router.post('/test-web-search', async (req, res) => {
  const { provider, apiKey, endpoint, customProvider } = req.body || {};
  if (provider !== undefined && !isWebSearchProvider(provider)) {
    return res.status(400).json({ ok: false, error: 'Unsupported web search provider.' });
  }
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
    if (!['http:', 'https:'].includes(url.protocol)) {
      return res.status(400).json({ ok: false, error: `Invalid endpoint URL: ${effectiveEndpoint}` });
    }
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
    } else if (selectedProvider === 'serper') {
      requestUrl = effectiveEndpoint;
      requestInit = {
        method: 'POST',
        headers: {
          'X-API-KEY': trimmedKey,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ q: 'hello', num: 3 }),
      };
    } else if (selectedProvider === 'brave') {
      url.searchParams.set('q', 'hello');
      url.searchParams.set('count', '3');
      requestUrl = url.toString();
      requestInit = {
        method: 'GET',
        headers: {
          'X-Subscription-Token': trimmedKey,
          Accept: 'application/json',
        },
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
      : selectedProvider === 'serper'
        ? raw?.organic
        : selectedProvider === 'brave'
          ? raw?.web?.results
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
        ? 'explorer.exe'
        : 'xdg-open';
    const args = process.platform === 'darwin'
      ? ['-R', configPath]
      : process.platform === 'win32'
        ? [`/select,${configPath}`]
        : [path.dirname(configPath)];
    const child = spawn(command, args, prepareBackgroundSpawnOptions({ stdio: 'ignore', detached: true }));
    child.unref();
    res.json({ success: true, path: configPath });
  } catch (error) {
    res.json({ success: false, path: configPath, error: error instanceof Error ? error.message : String(error) });
  }
});

export default router;
