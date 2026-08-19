import { useCallback, useEffect, useState } from 'react';
import { authenticatedFetch } from '../../../../utils/api';
import { findCatalogProviderByUrl, type CatalogProvider, type CatalogProviderProtocol } from '../../../../shared/catalogProviders';
import { fetchProviderModels, fetchRemoteDefaultModels, type ApiModelListItem } from '../../../../shared/modelListApi';
import { CUSTOM_PROVIDER_ID, DEFAULT_PROVIDER } from '../constants';
import { defaultModelForProvider, hasUsableApiKey, requiresApiKey } from '../llmSetupUtils';
import type { LlmSetupController, ModelListStatus, TestStatus } from '../types';

type UseLlmSetupOptions = {
  onSaved?: () => void | Promise<void>;
};

export default function useLlmSetup({ onSaved }: UseLlmSetupOptions = {}): LlmSetupController {
  const [selectedProvider, setSelectedProvider] = useState<CatalogProvider | null>(DEFAULT_PROVIDER);
  const [selectedModelId, setSelectedModelId] = useState(() => defaultModelForProvider(DEFAULT_PROVIDER));
  const [customModelId, setCustomModelId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [apiModels, setApiModels] = useState<ApiModelListItem[] | null>(null);
  const [modelListStatus, setModelListStatus] = useState<ModelListStatus>('idle');
  const [modelListMessage, setModelListMessage] = useState('');
  const [customProviderId, setCustomProviderId] = useState('');
  const [customProtocol, setCustomProtocol] = useState<CatalogProviderProtocol>('openai');

  const isCustomMode = selectedProvider?.id === CUSTOM_PROVIDER_ID;
  const selectedModels = apiModels ?? selectedProvider?.models ?? [];
  const selectedDefaultUrl = selectedProvider?.defaultUrl ?? '';
  const effectiveUrl = customUrl.trim() || selectedProvider?.defaultUrl || '';
  const effectiveModelId = customModelId.trim() || selectedModelId;
  const effectiveProtocol: CatalogProviderProtocol = isCustomMode
    ? customProtocol
    : (selectedProvider?.protocol ?? 'openai');
  const effectiveProviderId = isCustomMode ? customProviderId.trim() : (selectedProvider?.id ?? '');
  const selectedProviderRequiresApiKey = requiresApiKey(selectedProvider);
  const modelListRequiresApiKey = selectedProvider?.modelListRequiresApiKey === true;
  const canFetchModels = Boolean(
    selectedProvider
      && effectiveProviderId
      && effectiveUrl
      && (!modelListRequiresApiKey || hasUsableApiKey(apiKey)),
  );
  const canTest = Boolean(
    selectedProvider &&
    (!selectedProviderRequiresApiKey || apiKey.trim()) &&
    effectiveModelId &&
    effectiveProviderId &&
    (!isCustomMode || effectiveUrl.trim()),
  );

  const resetTest = useCallback(() => {
    setTestStatus('idle');
    setTestMessage('');
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
            setSelectedModelId(p.model || defaultModelForProvider(match));
          }
        }
      } catch { /* no existing config */ }
    })();
  }, []);

  useEffect(() => {
    setApiModels(null);
    setModelListStatus('idle');
    setModelListMessage('');
  }, [effectiveProviderId, effectiveUrl, effectiveProtocol]);

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
        const nextModels = models.length > 0 ? models : catalogModels;
        setSelectedModelId((current) => (
          nextModels.length > 0 && !nextModels.some((model) => model.id === current)
            ? nextModels[0].id
            : current
        ));
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setApiModels(catalogModels);
        setModelListStatus('idle');
        const message = error instanceof Error ? error.message : String(error);
        setModelListMessage(`Using bundled model list. Remote model list unavailable: ${message}`);
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
        const nextModels = !hasUsableApiKey(key) && models.length === 0 ? selectedProvider.models : models;
        setSelectedModelId((current) => (
          nextModels.length > 0 && !nextModels.some((model) => model.id === current)
            ? nextModels[0].id
            : current
        ));
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (!selectedProviderRequiresApiKey && selectedProvider.models.length > 0) {
          setApiModels(selectedProvider.models);
          setModelListStatus('idle');
          const message = error instanceof Error ? error.message : String(error);
          setModelListMessage(`Using bundled model list. Local model list unavailable: ${message}`);
          return;
        }
        setModelListStatus('error');
        setModelListMessage(error instanceof Error ? error.message : String(error));
      });
    return () => controller.abort();
  }, [apiKey, effectiveProviderId, effectiveProtocol, effectiveUrl, isCustomMode, selectedModelId, selectedProvider, selectedProviderRequiresApiKey]);

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
      setSelectedModelId((current) => (
        nextModels.length > 0 && !nextModels.some((model) => model.id === current)
          ? nextModels[0].id
          : current
      ));
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
    setSelectedModelId(defaultModelForProvider(provider));
    setApiModels(null);
    setModelListStatus('idle');
    setModelListMessage('');
    setCustomModelId('');
    setCustomUrl('');
    setCustomProviderId('');
    setCustomProtocol('openai');
    setTestStatus('idle');
    setTestMessage('');
  }, []);

  const handleTest = useCallback(async () => {
    if (!canTest || !selectedProvider) return;
    setTestStatus('testing');
    setTestMessage('');
    try {
      const res = await authenticatedFetch('/api/config/test-connection', {
        method: 'POST',
        body: JSON.stringify({
          providerType: effectiveProtocol,
          providerId: effectiveProviderId,
          baseUrl: effectiveUrl,
          apiKey: apiKey.trim(),
          model: effectiveModelId,
        }),
      });
      const data = await res.json();
      if (data.ok) {
        setTestStatus('success');
        setTestMessage(data.message || 'Connected successfully.');
      } else {
        setTestStatus('error');
        setTestMessage(data.error || 'Connection failed.');
      }
    } catch (err) {
      setTestStatus('error');
      setTestMessage(err instanceof Error ? err.message : 'Connection failed.');
    }
  }, [canTest, selectedProvider, effectiveUrl, apiKey, effectiveModelId, effectiveProtocol, effectiveProviderId]);

  const handleSave = useCallback(async () => {
    if (!selectedProvider) return;
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
        models: {
          ...existingModels,
          [modelId]: existingModels[modelId] || {},
        },
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
  }, [selectedProvider, effectiveUrl, effectiveModelId, apiKey, effectiveProtocol, effectiveProviderId, onSaved]);

  return {
    selectedProvider,
    selectedModelId,
    customModelId,
    apiKey,
    customUrl,
    showAdvanced,
    testStatus,
    testMessage,
    saving,
    apiModels,
    modelListStatus,
    modelListMessage,
    customProviderId,
    customProtocol,
    isCustomMode,
    selectedModels,
    selectedDefaultUrl,
    effectiveUrl,
    effectiveModelId,
    effectiveProtocol,
    effectiveProviderId,
    selectedProviderRequiresApiKey,
    canFetchModels,
    canTest,
    setSelectedModelId,
    setCustomModelId,
    setApiKey,
    setCustomUrl,
    setShowAdvanced,
    setCustomProviderId,
    setCustomProtocol,
    resetTest,
    handleProviderSelect,
    handleFetchModels,
    handleTest,
    handleSave,
  };
}
