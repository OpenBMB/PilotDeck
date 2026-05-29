import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronDown, Loader2, Plus } from 'lucide-react';
import { authenticatedFetch } from '../../../../utils/api';
import { CATALOG_PROVIDERS, findCatalogProviderByUrl, type CatalogProvider } from '../../../../shared/catalogProviders';

type LlmConfigurationStepProps = {
  onSaved: () => void | Promise<void>;
};

type TestStatus = 'idle' | 'testing' | 'success' | 'error';

const PLACEHOLDER_API_KEY = 'PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE';
const MASKED_SECRET = '********';

// Sentinel id for the "+" tile. When selected, the form swaps in extra inputs
// (provider id, protocol, base URL) so the user can describe a provider that
// isn't in the catalog.
const CUSTOM_PROVIDER_ID = '__custom__';

const CUSTOM_PROVIDER: CatalogProvider = {
  id: CUSTOM_PROVIDER_ID,
  displayName: 'Custom',
  protocol: 'openai',
  defaultUrl: '',
  models: [],
};

const DEFAULT_PROVIDER = CATALOG_PROVIDERS.find((provider) => provider.id === 'openrouter') ?? CATALOG_PROVIDERS[0];

function defaultModelForProvider(provider: CatalogProvider | null) {
  if (!provider) return '';
  return provider.models.find((model) => model.id === 'deepseek/deepseek-v4-flash')?.id
    ?? provider.models[0]?.id
    ?? '';
}

function hasUsableApiKey(value: unknown) {
  if (typeof value !== 'string') return false;
  const key = value.trim();
  return Boolean(key) && key !== PLACEHOLDER_API_KEY && key !== MASKED_SECRET && !key.startsWith('PLACEHOLDER_');
}

export default function LlmConfigurationStep({ onSaved }: LlmConfigurationStepProps) {
  const [selectedProvider, setSelectedProvider] = useState<CatalogProvider | null>(DEFAULT_PROVIDER);
  const [selectedModelId, setSelectedModelId] = useState(() => defaultModelForProvider(DEFAULT_PROVIDER));
  const [customModelId, setCustomModelId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [customUrl, setCustomUrl] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [testMessage, setTestMessage] = useState('');
  const [saving, setSaving] = useState(false);

  // Inputs that are only relevant when the user picks the "+" (custom) tile.
  const [customProviderId, setCustomProviderId] = useState('');
  const [customProtocol, setCustomProtocol] = useState<'openai' | 'anthropic'>('openai');

  const isCustomMode = selectedProvider?.id === CUSTOM_PROVIDER_ID;
  const selectedModels = selectedProvider?.models ?? [];
  const selectedDefaultUrl = selectedProvider?.defaultUrl ?? '';

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

  const effectiveUrl = customUrl.trim() || selectedProvider?.defaultUrl || '';
  const effectiveModelId = customModelId.trim() || selectedModelId;
  const effectiveProtocol: 'openai' | 'anthropic' = isCustomMode
    ? customProtocol
    : (selectedProvider?.protocol ?? 'openai');
  const effectiveProviderId = isCustomMode ? customProviderId.trim() : (selectedProvider?.id ?? '');
  const canTest = Boolean(
    selectedProvider &&
    apiKey.trim() &&
    effectiveModelId &&
    effectiveProviderId &&
    (!isCustomMode || effectiveUrl.trim()),
  );

  const handleProviderSelect = useCallback((provider: CatalogProvider) => {
    setSelectedProvider((prev) => {
      // Switching to a different provider should not carry over the API key
      // from the previously selected one (otherwise users adding a 2nd
      // provider re-save their Anthropic key under OpenAI).
      if (prev?.id !== provider.id) {
        setApiKey('');
      }
      return provider;
    });
    setSelectedModelId(defaultModelForProvider(provider));
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
  }, [canTest, selectedProvider, effectiveUrl, apiKey, effectiveModelId, effectiveProtocol]);

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
        (existingConfig as Record<string, unknown>).schemaVersion = 1;
      }
      if (!existingConfig.model || typeof existingConfig.model !== 'object') {
        (existingConfig as Record<string, unknown>).model = { providers: {} };
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
        (existingConfig as Record<string, unknown>).agent = {};
      }
      (existingConfig.agent as Record<string, unknown>).model = `${providerId}/${modelId}`;

      delete (existingConfig as Record<string, unknown>).models;
      delete (existingConfig as Record<string, unknown>).agents;
      delete (existingConfig as Record<string, unknown>).version;

      const saveRes = await authenticatedFetch('/api/config', {
        method: 'PUT',
        body: JSON.stringify({ raw: stringifyYaml(existingConfig, { indent: 2, lineWidth: 0 }) }),
      });

      if (!saveRes.ok) {
        const err = await saveRes.json();
        throw new Error(err.error || 'Failed to save configuration');
      }

      await onSaved();
    } catch (err) {
      setTestStatus('error');
      setTestMessage(err instanceof Error ? err.message : 'Failed to save.');
    } finally {
      setSaving(false);
    }
  }, [selectedProvider, effectiveUrl, effectiveModelId, apiKey, effectiveProtocol, effectiveProviderId, onSaved]);

  return (
    <div className="mx-auto w-full max-w-xl space-y-8">
      <div>
        <h2 className="text-lg font-semibold text-foreground">LLM Provider Setup</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Select your provider and enter your API key. Model capabilities are auto-configured.
        </p>
      </div>

      <div className="border-t border-border" />

      {/* Provider grid */}
      <div>
        <div className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Provider
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {CATALOG_PROVIDERS.map((provider) => (
            <button
              key={provider.id}
              type="button"
              onClick={() => handleProviderSelect(provider)}
              className={`relative rounded-lg border px-4 py-3 text-left text-sm transition-colors ${
                selectedProvider?.id === provider.id
                  ? 'border-foreground bg-muted text-foreground'
                  : 'border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground'
              }`}
            >
              <div className="font-medium">{provider.displayName}</div>
              <div className="mt-0.5 text-[11px] opacity-60">
                {provider.models.length} model{provider.models.length === 1 ? '' : 's'}
              </div>
              {selectedProvider?.id === provider.id && (
                <Check className="absolute right-2 top-2 h-4 w-4 text-foreground" strokeWidth={2.5} />
              )}
            </button>
          ))}
          <button
            type="button"
            onClick={() => handleProviderSelect(CUSTOM_PROVIDER)}
            className={`relative flex items-center gap-2 rounded-lg border border-dashed px-4 py-3 text-left text-sm transition-colors ${
              isCustomMode
                ? 'border-foreground bg-muted text-foreground'
                : 'border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground'
            }`}
          >
            <Plus className="h-4 w-4" />
            <div>
              <div className="font-medium">Custom</div>
              <div className="mt-0.5 text-[11px] opacity-60">Any OpenAI / Anthropic endpoint</div>
            </div>
            {isCustomMode && (
              <Check className="absolute right-2 top-2 h-4 w-4 text-foreground" strokeWidth={2.5} />
            )}
          </button>
        </div>
      </div>

          {isCustomMode && (
            <div className="space-y-3 rounded-lg border border-dashed border-border/60 bg-muted/20 p-4">
              <div>
                <label htmlFor="custom-provider-id" className="mb-1 block text-sm font-medium text-foreground">
                  Provider ID
                </label>
                <input
                  id="custom-provider-id"
                  type="text"
                  value={customProviderId}
                  onChange={(e) => { setCustomProviderId(e.target.value); setTestStatus('idle'); setTestMessage(''); }}
                  placeholder="e.g. my-llm"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2.5 font-mono text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-foreground/40 focus:outline-none"
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Used as the YAML key. Lowercase, no spaces.
                </p>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-1">
                  <label htmlFor="custom-protocol" className="mb-1 block text-sm font-medium text-foreground">
                    Protocol
                  </label>
                  <div className="relative">
                    <select
                      id="custom-protocol"
                      value={customProtocol}
                      onChange={(e) => { setCustomProtocol(e.target.value as 'openai' | 'anthropic'); setTestStatus('idle'); setTestMessage(''); }}
                      className="w-full appearance-none rounded-lg border border-border bg-background px-3 py-2.5 pr-8 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
                    >
                      <option value="openai">openai</option>
                      <option value="anthropic">anthropic</option>
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  </div>
                </div>
                <div className="col-span-2">
                  <label htmlFor="custom-base-url" className="mb-1 block text-sm font-medium text-foreground">
                    Base URL
                  </label>
                  <input
                    id="custom-base-url"
                    type="text"
                    value={customUrl}
                    onChange={(e) => { setCustomUrl(e.target.value); setTestStatus('idle'); setTestMessage(''); }}
                    placeholder="https://api.example.com/v1"
                    className="w-full rounded-lg border border-border bg-background px-3 py-2.5 font-mono text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-foreground/40 focus:outline-none"
                    autoComplete="off"
                    spellCheck={false}
                  />
                {customProtocol === 'openai' && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    OpenAI-compatible base URLs should include the API version path, for example ending in <span className="font-mono">/v1</span>.
                  </p>
                )}
                </div>
              </div>
            </div>
          )}

          {/* API Key */}
          <div>
            <label htmlFor="llm-api-key" className="mb-1 block text-sm font-medium text-foreground">
              API Key
            </label>
            <input
              id="llm-api-key"
              type="password"
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); setTestStatus('idle'); setTestMessage(''); }}
              placeholder="sk-..."
              className="w-full rounded-lg border border-border bg-background px-3 py-2.5 font-mono text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-foreground/40 focus:outline-none"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          {/* Model picker */}
          <div>
            <label htmlFor="llm-model" className="mb-1 block text-sm font-medium text-foreground">
              Model
            </label>
            {selectedModels.length > 0 ? (
              <div className="relative">
                <select
                  id="llm-model"
                  value={selectedModelId}
                  onChange={(e) => { setSelectedModelId(e.target.value); setCustomModelId(''); setTestStatus('idle'); setTestMessage(''); }}
                  className="w-full appearance-none rounded-lg border border-border bg-background px-3 py-2.5 pr-8 text-sm text-foreground focus:border-foreground/40 focus:outline-none"
                >
                  {selectedModels.map((m) => (
                    <option key={m.id} value={m.id}>{m.displayName} ({m.id})</option>
                  ))}
                </select>
                <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              </div>
            ) : (
              <input
                id="llm-model"
                type="text"
                value={customModelId}
                onChange={(e) => { setCustomModelId(e.target.value); setTestStatus('idle'); setTestMessage(''); }}
                placeholder="Enter model ID..."
                className="w-full rounded-lg border border-border bg-background px-3 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:border-foreground/40 focus:outline-none"
                autoComplete="off"
                spellCheck={false}
              />
            )}
            {selectedModels.length > 0 && (
              <div className="mt-2">
                <input
                  type="text"
                  value={customModelId}
                  onChange={(e) => { setCustomModelId(e.target.value); setTestStatus('idle'); setTestMessage(''); }}
                  placeholder="Or type a custom model ID..."
                  className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/40 focus:border-foreground/40 focus:outline-none"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            )}
          </div>

          {/* Advanced (catalog providers only — custom already shows URL above) */}
          {!isCustomMode && (
          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              {showAdvanced ? 'Hide' : 'Show'} advanced settings
            </button>
            {showAdvanced && (
              <div className="mt-3 space-y-3 rounded-lg border border-border/60 bg-muted/30 p-3">
                <div>
                  <label htmlFor="llm-url" className="mb-1 block text-xs font-medium text-muted-foreground">
                    API Base URL
                  </label>
                  <input
                    id="llm-url"
                    type="text"
                    value={customUrl}
                    onChange={(e) => { setCustomUrl(e.target.value); setTestStatus('idle'); setTestMessage(''); }}
                    placeholder={selectedDefaultUrl}
                    className="w-full rounded-lg border border-border/60 bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/40 focus:border-foreground/40 focus:outline-none"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  {(selectedProvider?.protocol ?? customProtocol) === 'openai' && (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      OpenAI-compatible base URLs should include the API version path, for example ending in <span className="font-mono">/v1</span>.
                    </p>
                  )}
                </div>
                <div className="text-[11px] text-muted-foreground">
                  Protocol: <span className="font-mono">{selectedProvider?.protocol ?? customProtocol}</span> &middot; Default URL: <span className="font-mono">{selectedDefaultUrl}</span>
                </div>
              </div>
            )}
          </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-6">
            {testStatus !== 'success' && (
              <span className="mr-auto text-xs text-muted-foreground">Test connection first.</span>
            )}
            <button
              type="button"
              onClick={handleTest}
              disabled={!canTest || testStatus === 'testing'}
              className="rounded-lg border border-border px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            >
              {testStatus === 'testing' ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Testing...
                </span>
              ) : (
                'Test Connection'
              )}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={testStatus !== 'success' || saving}
              className="rounded-lg bg-foreground px-5 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30"
            >
              {saving ? (
                <span className="flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Saving...
                </span>
              ) : (
                'Save'
              )}
            </button>
          </div>

          {testMessage && (
            <div className={`rounded-lg border px-4 py-3 text-sm ${
              testStatus === 'success'
                ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-800/40 dark:bg-green-900/10 dark:text-green-300'
                : 'border-red-200 bg-red-50 text-red-800 dark:border-red-800/40 dark:bg-red-900/10 dark:text-red-300'
            }`}>
              {testStatus === 'success' ? '✓ ' : '✗ '}{testMessage}
            </div>
          )}
    </div>
  );
}
