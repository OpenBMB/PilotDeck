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
  const modelListRequiresApiKey = selectedProvider?.modelListRequiresApiKey === true;
  const canFetchModels = Boolean(
    selectedProvider
      && effectiveProviderId
      && effectiveUrl
      && !customProviderIdError
      && (!modelListRequiresApiKey || hasUsableApiKey(apiKey)),
  );
  const canTest = Boolean(
    selectedProvider &&
    (!selectedProviderRequiresApiKey || apiKey.trim()) &&
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
        if (!existingKeyIsUsable) return;
        setApiKey(p.apiKey);
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
      .catch((error) => {
        if (controller.signal.aborted) return;
        setApiModels(catalogModels);
        setModelListStatus('idle');
      });
    return () => controller.abort();
  }, [apiKey, isCustomMode, modelListRequiresApiKey, selectedProvider, selectedProviderRequiresApiKey]);

  useEffect(() => {
    const key = apiKey.trim();
    if (!selectedProvider || !effectiveProviderId || !effectiveUrl) return;
    if (!hasUsableApiKey(key) && !isCustomMode && selectedProviderRequiresApiKey) return;
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
        if (!selectedProviderRequiresApiKey && selectedProvider.models.length > 0) {
          setApiModels(selectedProvider.models);
          setModelListStatus('idle');
          return;
        }
        setModelListStatus('error');
        setModelListMessage(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [apiKey, effectiveProviderId, effectiveProtocol, effectiveUrl, isCustomMode, selectedProvider, selectedProviderRequiresApiKey]);

  const handleFetchModels = useCallback(async () => {
    if (!canFetchModels) return;
    setModelListStatus('loading');
    setModelListMessage('');
    try {
      const key = apiKey.trim();
      const models = !isCustomMode && !hasUsableApiKey(key)
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
  }, [apiKey, canFetchModels, effectiveProviderId, effectiveProtocol, effectiveUrl, isCustomMode, selectedProvider]);

  const handleProviderSelect = useCallback((provider: CatalogProvider) => {
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
    setTestStatus('idle');
    setTestMessage('');
    setModelImageSupport({});
    setManualModelIds([]);
  }, []);

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
    if (selectedProviderRequiresApiKey && !apiKey.trim()) {
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
    setManualModelIds([]);
    try {
      const nextSupport: Record<string, ModelImageSupport> = { ...modelImageSupport };
      for (const modelId of effectiveModelIds) {
        const previous = nextSupport[modelId];
        const skipImage = previous?.source === 'manual' && typeof previous.supportsImage === 'boolean';
        const res = await authenticatedFetch('/api/config/test-connection', {
          method: 'POST',
          body: JSON.stringify({
            providerType: effectiveProtocol,
            providerId: effectiveProviderId,
            baseUrl: effectiveUrl,
            apiKey: apiKey.trim(),
            model: modelId,
            skipImage,
          }),
          signal: controller.signal,
        });
        if (controller.signal.aborted || generation !== testGenerationRef.current) return;
        const data = await res.json();
        if (controller.signal.aborted || generation !== testGenerationRef.current) return;
        if (!data.ok) {
          setModelImageSupport(nextSupport);
          setTestStatus('error');
          setTestMessage(data.error || `Connection failed for ${modelId}.`);
          return;
        }
        if (skipImage) continue;
        const source = data.imageCheckSource === 'catalog' || data.imageCheckSource === 'probe'
          ? data.imageCheckSource
          : 'probe';
        nextSupport[modelId] = {
          supportsImage: data.supportsImage === true ? true : data.supportsImage === false ? false : null,
          source,
        };
      }
      if (controller.signal.aborted || generation !== testGenerationRef.current) return;
      setModelImageSupport(nextSupport);
      const unresolved = effectiveModelIds.filter((id) => nextSupport[id]?.supportsImage == null);
      if (unresolved.length > 0) {
        setManualModelIds(unresolved);
        setTestStatus('manual');
        setTestMessage('');
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
  }, [apiKey, customProviderIdError, effectiveModelId, effectiveModelIds, effectiveProtocol, effectiveProviderId, effectiveUrl, isCustomMode, modelImageSupport, selectedProvider, selectedProviderRequiresApiKey, t, testStatus]);

  const submitManualImageSupport = useCallback((values: Record<string, boolean>) => {
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
  }, []);

  const cancelManualImageSupport = useCallback(() => {
    setManualModelIds([]);
    setTestStatus('error');
    setTestMessage('Image capability confirmation cancelled.');
  }, []);

  const handleSave = useCallback(async () => {
    if (!selectedProvider || customProviderIdError) return;
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

      const providerId = effectiveProviderId;
      const modelId = effectiveModelId;
      if (!providerId) throw new Error('Provider ID is required.');
      if (!modelId) throw new Error('At least one model ID is required.');
      if (effectiveModelIds.some((id) => typeof modelImageSupport[id]?.supportsImage !== 'boolean')) {
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
        protocol: effectiveProtocol,
        url: effectiveUrl,
        apiKey: apiKey.trim(),
        timeoutMs: typeof existingProvider.timeoutMs === 'number' ? existingProvider.timeoutMs : 120000,
        models: Object.fromEntries(
          effectiveModelIds.map((id) => {
            const existingModel = existingModels[id] && typeof existingModels[id] === 'object'
              ? existingModels[id] as Record<string, unknown>
              : {};
            const existingMultimodal = existingModel.multimodal && typeof existingModel.multimodal === 'object'
              ? existingModel.multimodal as Record<string, unknown>
              : {};
            const supportsImage = modelImageSupport[id]?.supportsImage === true;
            return [id, {
              ...existingModel,
              multimodal: {
                ...existingMultimodal,
                input: supportsImage ? ['text', 'image'] : ['text'],
              },
            }];
          }),
        ),
      };

      if (!existingConfig.agent || typeof existingConfig.agent !== 'object') {
        existingConfig.agent = {};
      }
      (existingConfig.agent as Record<string, unknown>).model = `${providerId}/${modelId}`;

      delete existingConfig.models;
      delete existingConfig.agents;
      delete existingConfig.version;

      const saveRes = await authenticatedFetch('/api/config', {
        method: 'PUT',
        body: JSON.stringify({ raw: stringifyYaml(existingConfig, { indent: 2, lineWidth: 0 }) }),
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
  }, [apiKey, customProviderIdError, effectiveModelId, effectiveModelIds, effectiveProtocol, effectiveProviderId, effectiveUrl, modelImageSupport, onSaved, selectedProvider]);

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
