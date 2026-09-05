import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authenticatedFetch } from '../../../../utils/api';
import { findCatalogProviderByUrl, type CatalogProvider, type CatalogProviderProtocol } from '../../../../shared/catalogProviders';
import { fetchProviderModels, fetchRemoteDefaultModels, type ApiModelListItem } from '../../../../shared/modelListApi';
import { CUSTOM_PROVIDER_ID, DEFAULT_PROVIDER, MAX_ONBOARDING_MODELS, RESERVED_CUSTOM_PROVIDER_IDS } from '../constants';
import { hasUsableApiKey, providerIdFromEndpoint, requiresApiKey, uniqueModelIds, unknownImageProbeCount } from '../llmSetupUtils';
import type { LlmSetupController, ModelImageSupport, ModelListStatus, TestStatus } from '../types';

type UseLlmSetupOptions = {
  onSaved?: () => void | Promise<void>;
};

export default function useLlmSetup({ onSaved }: UseLlmSetupOptions = {}): LlmSetupController {
  const { t } = useTranslation('onboarding');
  const [selectedProvider, setSelectedProvider] = useState<CatalogProvider | null>(DEFAULT_PROVIDER);
  const [modelIds, setModelIds] = useState<string[]>([]);
  const [apiKey, setApiKey] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [modelImageSupport, setModelImageSupport] = useState<Record<string, ModelImageSupport>>({});
  const [manualModelIds, setManualModelIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [apiModels, setApiModels] = useState<ApiModelListItem[] | null>(null);
  const [modelListStatus, setModelListStatus] = useState<ModelListStatus>('idle');
  const [modelListMessage, setModelListMessage] = useState('');
  const [customProviderId, setCustomProviderId] = useState('');
  const [customProtocol, setCustomProtocol] = useState<CatalogProviderProtocol>('openai');
  const [connectionTestId, setConnectionTestId] = useState('');
  const testGenerationRef = useRef(0);
  const testAbortRef = useRef<AbortController | null>(null);

  const isCustomMode = selectedProvider?.id === CUSTOM_PROVIDER_ID;
  const selectedModels = apiModels ?? selectedProvider?.models ?? [];
  const selectedDefaultUrl = selectedProvider?.defaultUrl ?? '';
  const effectiveUrl = customUrl.trim() || selectedProvider?.defaultUrl || '';
  const effectiveModelIds = uniqueModelIds(modelIds);
  const effectiveModelId = effectiveModelIds[0] || '';
  const effectiveProtocol: CatalogProviderProtocol = isCustomMode
    ? customProtocol
    : (selectedProvider?.protocol ?? 'openai');
  const effectiveProviderId = isCustomMode
    ? (customProviderId.trim().toLowerCase() || providerIdFromEndpoint(effectiveUrl))
    : (selectedProvider?.id ?? '');
  const customProviderIdError = isCustomMode && RESERVED_CUSTOM_PROVIDER_IDS.has(effectiveProviderId)
    ? t('connection.providerIdReserved')
    : '';
  const selectedProviderRequiresApiKey = requiresApiKey(selectedProvider);
  const hasEnvironmentApiKeyFallback = Boolean(!isCustomMode && selectedProvider?.apiKeyEnvVar);
  const apiKeyInputRequired = selectedProviderRequiresApiKey && !hasEnvironmentApiKeyFallback;
  const modelListRequiresApiKey = selectedProvider?.modelListRequiresApiKey === true;
  const canFetchModels = Boolean(
    selectedProvider
      && effectiveProviderId
      && effectiveUrl
      && !customProviderIdError
      && (!modelListRequiresApiKey || hasUsableApiKey(apiKey) || hasEnvironmentApiKeyFallback),
  );
  const canTest = Boolean(
    selectedProvider &&
    (!selectedProviderRequiresApiKey || hasUsableApiKey(apiKey) || hasEnvironmentApiKeyFallback) &&
    effectiveModelId &&
    effectiveProviderId &&
    !customProviderIdError &&
    (!isCustomMode || effectiveUrl.trim()),
  );
  const unknownProbeCount = unknownImageProbeCount(isCustomMode ? null : selectedProvider, effectiveModelIds);
  const canContinue = testStatus === 'success'
    && effectiveModelIds.length > 0
    && effectiveModelIds.every((id) => typeof modelImageSupport[id]?.supportsImage === 'boolean');

  const resetTest = useCallback(() => {
    testGenerationRef.current += 1;
    testAbortRef.current?.abort();
    testAbortRef.current = null;
    setTestStatus('idle');
    setTestMessage('');
    setConnectionTestId('');
    setModelImageSupport({});
    setManualModelIds([]);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await authenticatedFetch('/api/config/provider');
        if (!res.ok) return;
        const data = await res.json();
        if (!data.exists || !data.provider) return;

        const p = data.provider;
        const existingKeyIsUsable = hasUsableApiKey(p.apiKey);
        if (existingKeyIsUsable) setApiKey(p.apiKey);
        if (p.baseUrl) {
          const match = findCatalogProviderByUrl(p.baseUrl);
          if (match) {
            setSelectedProvider(match);
            const existingModel = typeof p.model === 'string' ? p.model.trim() : '';
            setModelIds(existingModel ? [existingModel] : []);
          }
        }
      } catch { /* no existing config */ }
    })();
  }, []);

  useEffect(() => {
    setApiModels(null);
    setModelListStatus('idle');
    setModelListMessage('');
  }, [effectiveProviderId, effectiveProtocol, effectiveUrl]);

  useEffect(() => {
    if (!selectedProvider || isCustomMode || apiKey.trim()) return;
    if (!selectedProviderRequiresApiKey || modelListRequiresApiKey) return;
    const catalogModels = selectedProvider.models;
    const controller = new AbortController();
    setModelListStatus('loading');
    setModelListMessage('');
    fetchRemoteDefaultModels(selectedProvider.id)
      .then((models) => {
        if (controller.signal.aborted) return;
        setApiModels(models.length > 0 ? models : catalogModels);
        setModelListStatus('idle');
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setApiModels(catalogModels);
        setModelListStatus('idle');
      });
    return () => controller.abort();
  }, [apiKey, isCustomMode, modelListRequiresApiKey, selectedProvider, selectedProviderRequiresApiKey]);

  useEffect(() => {
    const key = apiKey.trim();
    if (!selectedProvider || !effectiveProviderId || !effectiveUrl) return;
    if (
      !hasUsableApiKey(key)
      && !isCustomMode
      && selectedProviderRequiresApiKey
      && !hasEnvironmentApiKeyFallback
    ) return;
    const controller = new AbortController();
    setModelListStatus('loading');
    setModelListMessage('');
    fetchProviderModels({ protocol: effectiveProtocol, baseUrl: effectiveUrl, apiKey: hasUsableApiKey(key) ? key : '', providerId: effectiveProviderId })
      .then((models) => {
        if (controller.signal.aborted) return;
        setApiModels(!hasUsableApiKey(key) && models.length === 0 ? selectedProvider.models : models);
        setModelListStatus('idle');
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (
          selectedProvider.models.length > 0
          && (!selectedProviderRequiresApiKey || (!hasUsableApiKey(key) && hasEnvironmentApiKeyFallback))
        ) {
          setApiModels(selectedProvider.models);
          setModelListStatus('idle');
          return;
        }
        setModelListStatus('error');
        setModelListMessage(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [apiKey, effectiveProviderId, effectiveProtocol, effectiveUrl, hasEnvironmentApiKeyFallback, isCustomMode, selectedProvider, selectedProviderRequiresApiKey]);

  const handleFetchModels = useCallback(async () => {
    if (!canFetchModels) return;
    setModelListStatus('loading');
    setModelListMessage('');
    try {
      const key = apiKey.trim();
      const models = !isCustomMode && !hasUsableApiKey(key) && !hasEnvironmentApiKeyFallback
        ? await fetchRemoteDefaultModels(effectiveProviderId)
        : await fetchProviderModels({
            protocol: effectiveProtocol,
            baseUrl: effectiveUrl,
            apiKey: hasUsableApiKey(key) ? key : '',
            providerId: effectiveProviderId,
          });
      const nextModels = !hasUsableApiKey(key) && !isCustomMode && selectedProvider
        ? (models.length > 0 ? models : selectedProvider.models)
        : models;
      setApiModels(nextModels);
      setModelListStatus('idle');
    } catch (error) {
      setModelListStatus('error');
      setModelListMessage(error instanceof Error ? error.message : String(error));
    }
  }, [apiKey, canFetchModels, effectiveProviderId, effectiveProtocol, effectiveUrl, hasEnvironmentApiKeyFallback, isCustomMode, selectedProvider]);

  const handleProviderSelect = useCallback((provider: CatalogProvider) => {
    resetTest();
    setSelectedProvider((prev) => {
      if (prev?.id !== provider.id) {
        setApiKey('');
      }
      return provider;
    });
    setModelIds([]);
    setApiModels(null);
    setModelListStatus('idle');
    setModelListMessage('');
    setCustomUrl('');
    setCustomProviderId('');
    setCustomProtocol('openai');
  }, [resetTest]);

  const selectModelId = useCallback((modelId: string) => {
    const trimmed = modelId.trim();
    if (!trimmed) return;
    setModelIds((current) => {
      const selected = uniqueModelIds(current);
      if (selected.includes(trimmed) || selected.length >= MAX_ONBOARDING_MODELS) return current;
      return [...selected, trimmed];
    });
    resetTest();
  }, [resetTest]);

  const deselectModelId = useCallback((modelId: string) => {
    setModelIds((current) => uniqueModelIds(current).filter((id) => id !== modelId));
    resetTest();
  }, [resetTest]);

  const handleTest = useCallback(async () => {
    if (testStatus === 'testing') return;
    if (!selectedProvider) return;
    if (!effectiveModelId) {
      setTestStatus('error');
      setTestMessage(t('connection.testNeedModel'));
      return;
    }
    if (selectedProviderRequiresApiKey && !hasUsableApiKey(apiKey) && !hasEnvironmentApiKeyFallback) {
      setTestStatus('error');
      setTestMessage(t('connection.testNeedApiKey'));
      return;
    }
    if (!effectiveProviderId || customProviderIdError || (isCustomMode && !effectiveUrl.trim())) {
      setTestStatus('error');
      setTestMessage(customProviderIdError || t('connection.testNeedConnection'));
      return;
    }
    const generation = testGenerationRef.current;
    const controller = new AbortController();
    testAbortRef.current?.abort();
    testAbortRef.current = controller;
    setTestStatus('testing');
    setTestMessage('');
    setConnectionTestId('');
    setManualModelIds([]);
    try {
      const res = await authenticatedFetch('/api/config/test-connections', {
        method: 'POST',
        body: JSON.stringify({
          providerId: effectiveProviderId,
          protocol: effectiveProtocol,
          endpoint: effectiveUrl,
          apiKey: apiKey.trim(),
          models: effectiveModelIds,
          retryPolicy: {},
        }),
        signal: controller.signal,
      });
      if (controller.signal.aborted || generation !== testGenerationRef.current) return;
      const data = await res.json();
      if (controller.signal.aborted || generation !== testGenerationRef.current) return;
      if (!res.ok || data.status === 'failed' || typeof data.testId !== 'string') {
        const message = typeof data.error === 'string'
          ? data.error
          : data.error?.message || data.message || 'Connection failed.';
        setTestStatus('error');
        setTestMessage(message);
        return;
      }
      const nextSupport: Record<string, ModelImageSupport> = {};
      for (const model of Array.isArray(data.models) ? data.models : []) {
        if (!effectiveModelIds.includes(model.modelId)) continue;
        nextSupport[model.modelId] = {
          supportsImage: model.imageInput === 'supported'
            ? true
            : model.imageInput === 'unsupported'
              ? false
              : null,
          source: model.imageInput === 'unknown' ? null : 'probe',
        };
      }
      setConnectionTestId(data.testId);
      setModelImageSupport(nextSupport);
      const unresolved = effectiveModelIds.filter((id) => nextSupport[id]?.supportsImage == null);
      if (data.status === 'manual_input_required' && unresolved.length > 0) {
        setManualModelIds(unresolved);
        setTestStatus('manual');
        setTestMessage('');
        return;
      }
      if (data.status !== 'passed' || unresolved.length > 0) {
        setConnectionTestId('');
        setTestStatus('error');
        setTestMessage(data.error?.message || 'Connection test returned an incomplete result.');
        return;
      }
      setTestStatus('success');
      setTestMessage('Connected successfully.');
    } catch (err) {
      if (controller.signal.aborted || generation !== testGenerationRef.current) return;
      setTestStatus('error');
      setTestMessage(err instanceof Error ? err.message : 'Connection failed.');
    } finally {
      if (testAbortRef.current === controller) testAbortRef.current = null;
    }
  }, [apiKey, customProviderIdError, effectiveModelId, effectiveModelIds, effectiveProtocol, effectiveProviderId, effectiveUrl, hasEnvironmentApiKeyFallback, isCustomMode, selectedProvider, selectedProviderRequiresApiKey, t, testStatus]);

  const submitManualImageSupport = useCallback(async (values: Record<string, boolean>) => {
    if (!connectionTestId) return;
    try {
      const res = await authenticatedFetch(`/api/config/test-connections/${connectionTestId}/image-capabilities`, {
        method: 'PUT',
        body: JSON.stringify({
          models: Object.entries(values).map(([modelId, supportsImage]) => ({
            modelId,
            imageInput: supportsImage ? 'supported' : 'unsupported',
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok || data.status !== 'passed') {
        throw new Error(data.error?.message || data.message || 'Image capability confirmation failed.');
      }
      setModelImageSupport((current) => {
        const next = { ...current };
        for (const [modelId, supportsImage] of Object.entries(values)) {
          next[modelId] = { supportsImage, source: 'manual' };
        }
        return next;
      });
      setManualModelIds([]);
      setTestStatus('success');
      setTestMessage('Connected successfully.');
    } catch (err) {
      setTestStatus('error');
      setTestMessage(err instanceof Error ? err.message : 'Image capability confirmation failed.');
    }
  }, [connectionTestId]);

  const cancelManualImageSupport = useCallback(() => {
    setManualModelIds([]);
    setTestStatus('error');
    setTestMessage('Image capability confirmation cancelled.');
  }, []);

  const handleSave = useCallback(async () => {
    if (!selectedProvider || customProviderIdError) return;
    const saveGeneration = testGenerationRef.current;
    const saveConnectionTestId = connectionTestId;
    const providerId = effectiveProviderId;
    const modelId = effectiveModelId;
    const modelIds = effectiveModelIds;
    const protocol = effectiveProtocol;
    const url = effectiveUrl;
    const key = apiKey.trim();
    const imageSupport = modelImageSupport;
    setSaving(true);
    try {
      const { stringify: stringifyYaml, parse: parseYaml } = await import('yaml');

      let existingConfig: Record<string, unknown> = {};
      try {
        const res = await authenticatedFetch('/api/config');
        if (res.ok) {
          const data = await res.json();
          if (data.raw) existingConfig = parseYaml(data.raw) || {};
        }
      } catch { /* start fresh */ }

      if (!providerId) throw new Error('Provider ID is required.');
      if (!modelId) throw new Error('At least one model ID is required.');
      if (!saveConnectionTestId) throw new Error('A passing connection test is required.');
      if (modelIds.some((id) => typeof imageSupport[id]?.supportsImage !== 'boolean')) {
        throw new Error('Image capability must be confirmed for every model.');
      }

      if (!existingConfig.schemaVersion) {
        existingConfig.schemaVersion = 1;
      }
      if (!existingConfig.model || typeof existingConfig.model !== 'object') {
        existingConfig.model = { providers: {} };
      }
      const modelSection = existingConfig.model as Record<string, unknown>;
      if (!modelSection.providers || typeof modelSection.providers !== 'object') {
        modelSection.providers = {};
      }

      const yamlProviders = modelSection.providers as Record<string, Record<string, unknown>>;
      const existingProvider = (yamlProviders[providerId] || {}) as Record<string, unknown>;
      const existingModels = (
        existingProvider.models && typeof existingProvider.models === 'object'
          ? existingProvider.models
          : {}
      ) as Record<string, unknown>;

      yamlProviders[providerId] = {
        ...existingProvider,
        protocol,
        url,
        apiKey: key,
        timeoutMs: typeof existingProvider.timeoutMs === 'number' ? existingProvider.timeoutMs : 120000,
        models: {
          // Onboarding configures the selected models; it is not a model
          // deletion surface. Preserve models that are already configured but
          // are not returned by /api/config/provider (which exposes only the
          // active agent model).
          ...existingModels,
          ...Object.fromEntries(
            modelIds.map((id) => {
              const existingModel = existingModels[id] && typeof existingModels[id] === 'object'
                ? existingModels[id] as Record<string, unknown>
                : {};
              const existingMultimodal = existingModel.multimodal && typeof existingModel.multimodal === 'object'
                ? existingModel.multimodal as Record<string, unknown>
                : {};
              const supportsImage = imageSupport[id]?.supportsImage === true;
              return [id, {
                ...existingModel,
                multimodal: {
                  ...existingMultimodal,
                  input: supportsImage ? ['text', 'image'] : ['text'],
                },
              }];
            }),
          ),
        },
      };

      if (!existingConfig.agent || typeof existingConfig.agent !== 'object') {
        existingConfig.agent = {};
      }
      (existingConfig.agent as Record<string, unknown>).model = `${providerId}/${modelId}`;

      delete existingConfig.models;
      delete existingConfig.agents;
      delete existingConfig.version;

      if (testGenerationRef.current !== saveGeneration) {
        throw new Error('Configuration changed while saving. Test the current configuration again.');
      }

      const saveRes = await authenticatedFetch('/api/config', {
        method: 'PUT',
        body: JSON.stringify({
          raw: stringifyYaml(existingConfig, { indent: 2, lineWidth: 0 }),
          modelTestBindings: [{ testId: saveConnectionTestId }],
        }),
      });

      if (!saveRes.ok) {
        const err = await saveRes.json();
        throw new Error(err.error || 'Failed to save configuration');
      }

      await onSaved?.();
    } catch (err) {
      setTestStatus('error');
      setTestMessage(err instanceof Error ? err.message : 'Failed to save.');
      throw err;
    } finally {
      setSaving(false);
    }
  }, [apiKey, connectionTestId, customProviderIdError, effectiveModelId, effectiveModelIds, effectiveProtocol, effectiveProviderId, effectiveUrl, modelImageSupport, onSaved, selectedProvider]);

  return {
    selectedProvider,
    modelIds,
    apiKey,
    customUrl,
    testStatus,
    testMessage,
    saving,
    apiModels,
    modelListStatus,
    modelListMessage,
    customProviderId,
    customProviderIdError,
    customProtocol,
    isCustomMode,
    selectedModels,
    selectedDefaultUrl,
    effectiveUrl,
    effectiveModelId,
    effectiveModelIds,
    effectiveProtocol,
    effectiveProviderId,
    selectedProviderRequiresApiKey,
    hasEnvironmentApiKeyFallback,
    apiKeyInputRequired,
    canFetchModels,
    canTest,
    canContinue,
    unknownImageProbeCount: unknownProbeCount,
    manualModelIds,
    setModelIds,
    selectModelId,
    deselectModelId,
    setApiKey,
    setCustomUrl,
    setCustomProviderId,
    setCustomProtocol,
    resetTest,
    handleProviderSelect,
    handleFetchModels,
    handleTest,
    submitManualImageSupport,
    cancelManualImageSupport,
    handleSave,
  };
}
