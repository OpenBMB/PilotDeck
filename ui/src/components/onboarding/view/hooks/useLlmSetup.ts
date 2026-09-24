import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { authenticatedFetch } from '../../../../utils/api';
import { findCatalogProviderByUrl, type CatalogProvider, type CatalogProviderProtocol } from '../../../../shared/catalogProviders';
import { fetchProviderModels, fetchRemoteDefaultModels, type ApiModelListItem } from '../../../../shared/modelListApi';
import { CUSTOM_PROVIDER_ID, DEFAULT_PROVIDER, MAX_ONBOARDING_MODELS, RESERVED_CUSTOM_PROVIDER_IDS } from '../constants';
import { hasUsableApiKey, providerIdFromEndpoint, requiresApiKey, uniqueModelIds } from '../llmSetupUtils';
import type { LlmSetupController, ModelImageSupport, ModelListStatus, ModelTestState } from '../types';

type UseLlmSetupOptions = {
  onSaved?: () => void | Promise<void>;
};

const IDLE_MODEL_TEST: ModelTestState = { status: 'idle', message: '', testId: '' };

function validEndpoint(value: string) {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

export default function useLlmSetup({ onSaved }: UseLlmSetupOptions = {}): LlmSetupController {
  const { t } = useTranslation('onboarding');
  const [selectedProvider, setSelectedProvider] = useState<CatalogProvider | null>(DEFAULT_PROVIDER);
  const [modelIds, setModelIds] = useState<string[]>([]);
  const [apiKey, setApiKey] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [testMessage, setTestMessage] = useState('');
  const [modelTests, setModelTests] = useState<Record<string, ModelTestState>>({});
  const [modelImageSupport, setModelImageSupport] = useState<Record<string, ModelImageSupport>>({});
  const [manualModelIds, setManualModelIds] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [apiModels, setApiModels] = useState<ApiModelListItem[] | null>(null);
  const [modelListStatus, setModelListStatus] = useState<ModelListStatus>('idle');
  const [modelListMessage, setModelListMessage] = useState('');
  const [customProviderId, setCustomProviderId] = useState('');
  const [customProtocol, setCustomProtocol] = useState<CatalogProviderProtocol>('openai');
  const testGenerationRef = useRef(0);
  const testAbortRefs = useRef<Record<string, AbortController>>({});

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
  const canContinue = Boolean(
    selectedProvider
    && effectiveProviderId
    && !customProviderIdError
    && validEndpoint(effectiveUrl)
    && (!selectedProviderRequiresApiKey || hasUsableApiKey(apiKey) || hasEnvironmentApiKeyFallback)
    && effectiveModelIds.length > 0,
  );

  const resetTest = useCallback(() => {
    testGenerationRef.current += 1;
    Object.values(testAbortRefs.current).forEach((controller) => controller.abort());
    testAbortRefs.current = {};
    setTestMessage('');
    setModelTests({});
    setModelImageSupport({});
    setManualModelIds([]);
  }, []);

  const getModelTestState = useCallback((modelId: string): ModelTestState => (
    modelTests[modelId] ?? IDLE_MODEL_TEST
  ), [modelTests]);

  const patchModelTest = useCallback((modelId: string, patch: Partial<ModelTestState>) => {
    setModelTests((current) => ({
      ...current,
      [modelId]: { ...(current[modelId] ?? IDLE_MODEL_TEST), ...patch },
    }));
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
  }, []);

  const deselectModelId = useCallback((modelId: string) => {
    const trimmed = modelId.trim();
    testGenerationRef.current += 1;
    setModelIds((current) => uniqueModelIds(current).filter((id) => id !== trimmed));
    testAbortRefs.current[trimmed]?.abort();
    delete testAbortRefs.current[trimmed];
    setModelTests((current) => {
      const next = { ...current };
      delete next[trimmed];
      return next;
    });
    setModelImageSupport((current) => {
      const next = { ...current };
      delete next[trimmed];
      return next;
    });
    setManualModelIds((current) => current.filter((id) => id !== trimmed));
  }, []);

  const handleTest = useCallback(async (modelId: string) => {
    const trimmed = modelId.trim();
    if (!trimmed || !effectiveModelIds.includes(trimmed) || !selectedProvider) return;
    if (Object.keys(testAbortRefs.current).length > 0) return;
    if (selectedProviderRequiresApiKey && !hasUsableApiKey(apiKey) && !hasEnvironmentApiKeyFallback) {
      patchModelTest(trimmed, { status: 'error', message: t('connection.testNeedApiKey'), testId: '' });
      return;
    }
    if (!effectiveProviderId || customProviderIdError || !validEndpoint(effectiveUrl)) {
      patchModelTest(trimmed, { status: 'error', message: customProviderIdError || t('connection.testNeedConnection'), testId: '' });
      return;
    }
    const generation = testGenerationRef.current;
    const controller = new AbortController();
    testAbortRefs.current[trimmed] = controller;
    patchModelTest(trimmed, { status: 'testing', message: '', testId: '' });
    setModelImageSupport((current) => {
      const next = { ...current };
      delete next[trimmed];
      return next;
    });
    setManualModelIds([]);
    setTestMessage('');
    try {
      const res = await authenticatedFetch('/api/config/test-connections', {
        method: 'POST',
        body: JSON.stringify({
          providerId: effectiveProviderId,
          protocol: effectiveProtocol,
          endpoint: effectiveUrl,
          apiKey: apiKey.trim(),
          models: [trimmed],
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
        patchModelTest(trimmed, { status: 'error', message, testId: '' });
        return;
      }
      const modelResult = Array.isArray(data.models)
        ? data.models.find((model: { modelId?: string }) => model.modelId === trimmed)
        : null;
      const supportsImage = modelResult?.imageInput === 'supported'
        ? true
        : modelResult?.imageInput === 'unsupported'
          ? false
          : null;
      setModelImageSupport((current) => ({
        ...current,
        [trimmed]: { supportsImage, source: supportsImage === null ? null : 'probe' },
      }));
      if (data.status === 'manual_input_required' && supportsImage === null) {
        setManualModelIds([trimmed]);
        patchModelTest(trimmed, { status: 'manual', message: '', testId: data.testId });
        return;
      }
      if (data.status !== 'passed' || supportsImage === null) {
        patchModelTest(trimmed, {
          status: 'error',
          message: data.error?.message || 'Connection test returned an incomplete result.',
          testId: '',
        });
        return;
      }
      patchModelTest(trimmed, { status: 'success', message: '', testId: data.testId });
    } catch (err) {
      if (controller.signal.aborted || generation !== testGenerationRef.current) return;
      patchModelTest(trimmed, { status: 'error', message: err instanceof Error ? err.message : 'Connection failed.', testId: '' });
    } finally {
      if (testAbortRefs.current[trimmed] === controller) delete testAbortRefs.current[trimmed];
    }
  }, [apiKey, customProviderIdError, effectiveModelIds, effectiveProtocol, effectiveProviderId, effectiveUrl, hasEnvironmentApiKeyFallback, patchModelTest, selectedProvider, selectedProviderRequiresApiKey, t]);

  const submitManualImageSupport = useCallback(async (values: Record<string, boolean>) => {
    const modelId = Object.keys(values)[0];
    const testId = modelId ? modelTests[modelId]?.testId : '';
    if (!modelId || !testId) return;
    const generation = testGenerationRef.current;
    try {
      const res = await authenticatedFetch(`/api/config/test-connections/${testId}/image-capabilities`, {
        method: 'PUT',
        body: JSON.stringify({
          models: Object.entries(values).map(([modelId, supportsImage]) => ({
            modelId,
            imageInput: supportsImage ? 'supported' : 'unsupported',
          })),
        }),
      });
      const data = await res.json();
      if (generation !== testGenerationRef.current) return;
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
      patchModelTest(modelId, { status: 'success', message: '', testId });
    } catch (err) {
      if (generation !== testGenerationRef.current) return;
      patchModelTest(modelId, {
        status: 'error',
        message: err instanceof Error ? err.message : 'Image capability confirmation failed.',
        testId: '',
      });
    }
  }, [modelTests, patchModelTest]);

  const cancelManualImageSupport = useCallback(() => {
    const modelId = manualModelIds[0];
    setManualModelIds([]);
    if (modelId) patchModelTest(modelId, { status: 'error', message: t('common:uiText.imageConfirmationCancelled'), testId: '' });
  }, [manualModelIds, patchModelTest, t]);

  const handleSave = useCallback(async () => {
    if (!canContinue) throw new Error('Complete the model configuration before continuing.');
    const saveGeneration = testGenerationRef.current;
    const providerId = effectiveProviderId;
    const modelId = effectiveModelId;
    const modelIds = effectiveModelIds;
    const protocol = effectiveProtocol;
    const url = effectiveUrl;
    const key = apiKey.trim();
    const imageSupport = modelImageSupport;
    const testsSnapshot = modelTests;
    setSaving(true);
    setTestMessage('');
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
              const catalogModel = selectedProvider?.models.find((model) => model.id === id || model.aliases?.includes(id));
              const supportsImage = imageSupport[id]?.supportsImage ?? catalogModel?.supportsImage;
              return [id, {
                ...existingModel,
                ...(typeof supportsImage === 'boolean'
                  ? { multimodal: { ...existingMultimodal, input: supportsImage ? ['text', 'image'] : ['text'] } }
                  : {}),
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
        throw new Error('Configuration changed while saving. Review the current configuration and continue again.');
      }

      const raw = stringifyYaml(existingConfig, { indent: 2, lineWidth: 0 });
      const modelTestBindings = modelIds.flatMap((id) => {
        const state = testsSnapshot[id];
        return state?.status === 'success' && state.testId ? [{ testId: state.testId }] : [];
      });
      const saveConfig = (bindings: Array<{ testId: string }>) => authenticatedFetch('/api/config', {
        method: 'PUT',
        body: JSON.stringify({ raw, ...(bindings.length ? { modelTestBindings: bindings } : {}) }),
      });
      let saveRes = await saveConfig(modelTestBindings);
      let saveError: { code?: string; error?: string } | null = null;
      if (!saveRes.ok && modelTestBindings.length) {
        saveError = await saveRes.json().catch(() => ({}));
        if (saveError?.code && ['TEST_EXPIRED', 'TEST_NOT_FOUND', 'TEST_NOT_PASSED', 'CONFIGURATION_MISMATCH'].includes(saveError.code)) {
          saveRes = await saveConfig([]);
          saveError = null;
        }
      }

      if (!saveRes.ok) {
        const err = saveError ?? await saveRes.json().catch(() => ({}));
        throw new Error(err.error || 'Failed to save configuration');
      }

      await onSaved?.();
    } catch (err) {
      setTestMessage(err instanceof Error ? err.message : 'Failed to save.');
      throw err;
    } finally {
      setSaving(false);
    }
  }, [apiKey, canContinue, effectiveModelId, effectiveModelIds, effectiveProtocol, effectiveProviderId, effectiveUrl, modelImageSupport, modelTests, onSaved, selectedProvider]);

  return {
    selectedProvider,
    modelIds,
    apiKey,
    customUrl,
    testMessage,
    modelTests,
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
    canContinue,
    manualModelIds,
    setModelIds,
    selectModelId,
    deselectModelId,
    setApiKey,
    setCustomUrl,
    setCustomProviderId,
    setCustomProtocol,
    resetTest,
    getModelTestState,
    handleProviderSelect,
    handleFetchModels,
    handleTest,
    submitManualImageSupport,
    cancelManualImageSupport,
    handleSave,
  };
}
