import { useCallback, useEffect, useState } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import { CLAUDE_MODELS } from '../../../../shared/modelConstants';
import type { PendingPermissionRequest, PermissionMode } from '../types/types';
import type { Project, ProjectSession } from '../../../types/app';
import {
  mergeModelSelections,
  normalizeModelSelection,
  parseCatalogItem,
} from '../../chat-v2/modelCapabilityOptions';

interface UseChatProviderStateArgs {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
}

type ModelOption = {
  value: string;
  label: string;
};

type ThinkingModelContext = {
  providerId?: string;
  providerUrl?: string;
  protocol?: string;
  modelId?: string;
  supportsThinking?: boolean;
};

export type ModelNumericCapability = {
  type: 'range' | 'enum';
  min?: number;
  max?: number;
  step?: number;
  values?: number[];
};

export type ChatModelCatalogItem = {
  id: string;
  provider: string;
  model: string;
  displayName: string;
  available: boolean;
  capabilities: {
    reasoning?: ModelNumericCapability;
    temperature?: ModelNumericCapability;
    speed?: ModelNumericCapability;
  };
};

export type ChatModelSelection =
  | { mode: 'auto' }
  | {
      mode: 'model';
      provider: string;
      model: string;
      reasoning?: number;
      temperature?: number;
      speed?: number;
    };

const DEFAULT_MODEL_OPTIONS: ModelOption[] = CLAUDE_MODELS.OPTIONS.map((option) => ({
  ...option,
}));

const DEFAULT_PERMISSION_MODE_KEY = 'permissionMode-default';
const COMPOSER_PERMISSION_MODES: PermissionMode[] = [
  'default',
  'bypassPermissions',
];

function readStoredPermissionMode(key: string): PermissionMode | null {
  const stored = localStorage.getItem(key);
  if (!stored) return null;
  return COMPOSER_PERMISSION_MODES.includes(stored as PermissionMode)
    ? (stored as PermissionMode)
    : null;
}

function readThinkingModelContext(config: unknown): ThinkingModelContext | null {
  const configRecord = config && typeof config === 'object' ? config as Record<string, unknown> : null;
  const agent = configRecord?.agent && typeof configRecord.agent === 'object' ? configRecord.agent as Record<string, unknown> : null;
  const modelRef = typeof agent?.model === 'string' ? agent.model.trim() : '';
  const slashIndex = modelRef.indexOf('/');
  if (slashIndex <= 0 || slashIndex >= modelRef.length - 1) {
    return null;
  }
  const providerId = modelRef.slice(0, slashIndex);
  const modelId = modelRef.slice(slashIndex + 1);
  const modelConfig = configRecord?.model && typeof configRecord.model === 'object' ? configRecord.model as Record<string, unknown> : null;
  const providers = modelConfig?.providers && typeof modelConfig.providers === 'object'
    ? modelConfig.providers as Record<string, unknown>
    : null;
  const provider = providers?.[providerId] && typeof providers[providerId] === 'object'
    ? providers[providerId] as Record<string, unknown>
    : null;
  const models = provider?.models && typeof provider.models === 'object'
    ? provider.models as Record<string, unknown>
    : null;
  const modelDefinition = models?.[modelId] && typeof models[modelId] === 'object'
    ? models[modelId] as Record<string, unknown>
    : null;
  const capabilities = modelDefinition?.capabilities && typeof modelDefinition.capabilities === 'object'
    ? modelDefinition.capabilities as Record<string, unknown>
    : null;
  return {
    providerId,
    providerUrl: typeof provider?.url === 'string' ? provider.url : undefined,
    protocol: typeof provider?.protocol === 'string' ? provider.protocol : undefined,
    modelId,
    supportsThinking: typeof capabilities?.supportsThinking === 'boolean' ? capabilities.supportsThinking : undefined,
  };
}

export function useChatProviderState({ selectedProject, selectedSession }: UseChatProviderStateArgs) {
  const { subscribe } = useWebSocket();
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>(() => {
    return readStoredPermissionMode(DEFAULT_PERMISSION_MODE_KEY) || 'default';
  });
  const [pendingPermissionRequests, setPendingPermissionRequests] = useState<PendingPermissionRequest[]>([]);
  const [model, setModel] = useState<string>(() => {
    return localStorage.getItem('pilotdeck-model') || CLAUDE_MODELS.DEFAULT;
  });
  const [modelOptions, setModelOptions] = useState<ModelOption[]>(DEFAULT_MODEL_OPTIONS);
  const [thinkingModelContext, setThinkingModelContext] = useState<ThinkingModelContext | null>(null);
  const [modelCatalog, setModelCatalog] = useState<ChatModelCatalogItem[]>([]);
  const [modelSelection, setModelSelectionState] = useState<ChatModelSelection | null>(null);
  const [isModelCatalogLoading, setIsModelCatalogLoading] = useState(false);
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null);

  useEffect(() => {
    const defaultMode = readStoredPermissionMode(DEFAULT_PERMISSION_MODE_KEY);
    if (!selectedSession?.id) {
      setPermissionModeState(defaultMode || 'default');
      return;
    }

    const savedMode = readStoredPermissionMode(`permissionMode-${selectedSession.id}`);
    setPermissionModeState(savedMode || defaultMode || 'default');
  }, [selectedSession?.id]);

  useEffect(() => {
    setPendingPermissionRequests((previous) => {
      const next = previous.filter((request) => !request.sessionId || request.sessionId === selectedSession?.id);
      return next;
    });
  }, [selectedSession?.id]);

  useEffect(() => {
    let cancelled = false;

    authenticatedFetch('/api/agents/runtime-config')
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) {
          return;
        }

        const availableModels = Array.isArray(data?.claude?.availableModels)
          ? data.claude.availableModels
            .filter((option: unknown): option is ModelOption => (
              typeof option === 'object'
              && option !== null
              && typeof (option as ModelOption).value === 'string'
              && typeof (option as ModelOption).label === 'string'
            ))
            .map((option: ModelOption) => ({
              value: option.value.trim(),
              label: option.label.trim() || option.value.trim(),
            }))
            .filter((option: ModelOption) => option.value.length > 0)
          : [];
        const runtimeOptions = availableModels.length > 0 ? availableModels : DEFAULT_MODEL_OPTIONS;
        const runtimeDefaultModel = typeof data?.claude?.defaultModel === 'string' && data.claude.defaultModel.trim()
          ? data.claude.defaultModel.trim()
          : CLAUDE_MODELS.DEFAULT;
        const storedModel = localStorage.getItem('pilotdeck-model')?.trim() || '';
        const hasStoredModel = runtimeOptions.some((option: ModelOption) => option.value === storedModel);
        const shouldReuseStoredModel = hasStoredModel && storedModel !== CLAUDE_MODELS.DEFAULT;
        const nextModel = shouldReuseStoredModel ? storedModel : runtimeDefaultModel;

        setModelOptions(runtimeOptions);
        setModel(nextModel);
        localStorage.setItem('pilotdeck-model', nextModel);

        const backendMode = data?.permissions?.effectiveMode;
        if (backendMode && COMPOSER_PERMISSION_MODES.includes(backendMode as PermissionMode)) {
          const storedPerm = readStoredPermissionMode(DEFAULT_PERMISSION_MODE_KEY);
          if (!storedPerm || storedPerm === 'default') {
            setPermissionModeState(backendMode as PermissionMode);
            localStorage.setItem(DEFAULT_PERMISSION_MODE_KEY, backendMode);
          }
        }
      })
      .catch((error) => {
        console.error('Error loading runtime config:', error);
      });

    authenticatedFetch('/api/config')
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) {
          return;
        }
        setThinkingModelContext(readThinkingModelContext(data?.config));
      })
      .catch((error) => {
        console.error('Error loading PilotDeck config:', error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const projectKey = selectedProject?.fullPath || selectedProject?.path || '';
    if (!projectKey) {
      setModelCatalog([]);
      setModelSelectionState(null);
      return;
    }

    const abortController = new AbortController();
    const loadModels = async () => {
      setIsModelCatalogLoading(true);
      setModelCatalogError(null);
      try {
        const catalogResponse = await authenticatedFetch(
          `/api/models?projectKey=${encodeURIComponent(projectKey)}&includeAuto=true`,
          { signal: abortController.signal },
        );
        const catalogData = await catalogResponse.json().catch(() => ({}));
        if (!catalogResponse.ok) {
          throw new Error(catalogData?.error?.message || 'Failed to load models');
        }

        const items = Array.isArray(catalogData?.items)
          ? catalogData.items
            .map((item: unknown) => parseCatalogItem(item))
            .filter((item: ChatModelCatalogItem | null): item is ChatModelCatalogItem => Boolean(item))
          : [];
        setModelCatalog(items);

        let storedSelection: ChatModelSelection | null = null;
        const stored = localStorage.getItem(`composer-model-${projectKey}`);
        if (stored) {
          try {
            storedSelection = normalizeModelSelection(JSON.parse(stored));
            let isValidStoredSelection = false;
            if (storedSelection?.mode === 'auto') {
              isValidStoredSelection = catalogData?.router?.autoAvailable === true;
            } else if (storedSelection?.mode === 'model') {
              const { provider, model: modelId } = storedSelection;
              isValidStoredSelection = items.some((item: ChatModelCatalogItem) => (
                item.provider === provider && item.model === modelId && item.available
              ));
            }
            if (!isValidStoredSelection) {
              storedSelection = null;
              localStorage.removeItem(`composer-model-${projectKey}`);
            }
          } catch {
            localStorage.removeItem(`composer-model-${projectKey}`);
          }
        }

        let nextSelection: ChatModelSelection | null = null;
        if (selectedSession?.id) {
          const params = new URLSearchParams({
            sessionKey: selectedSession.id,
            projectKey,
          });
          const sessionResponse = await authenticatedFetch(`/api/sessions/model?${params}`, {
            signal: abortController.signal,
          });
          if (sessionResponse.ok) {
            const sessionData = await sessionResponse.json();
            const savedSelection = normalizeModelSelection(sessionData?.saved);
            const effectiveSelection = sessionData?.effective?.provider && sessionData?.effective?.model
              ? normalizeModelSelection({
                  mode: 'model',
                  provider: sessionData.effective.provider,
                  model: sessionData.effective.model,
                  reasoning: sessionData.effective.reasoning,
                  temperature: sessionData.effective.temperature,
                  speed: sessionData.effective.speed,
                })
              : null;
            nextSelection = mergeModelSelections(savedSelection, storedSelection) || effectiveSelection;
            if (!savedSelection && storedSelection) {
              void authenticatedFetch('/api/sessions/model', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  projectKey,
                  sessionKey: selectedSession.id,
                  selection: storedSelection,
                }),
              });
            }
          }
        }

        if (!nextSelection) {
          nextSelection = storedSelection;
        }
        if (!nextSelection && catalogData?.router?.autoAvailable) {
          nextSelection = { mode: 'auto' };
        }
        if (!nextSelection) {
          const current = items.find((item: ChatModelCatalogItem) => item.available);
          if (current) {
            nextSelection = { mode: 'model', provider: current.provider, model: current.model };
          }
        }
        setModelSelectionState(nextSelection);
      } catch (error) {
        if ((error as { name?: string })?.name !== 'AbortError') {
          setModelCatalogError(error instanceof Error ? error.message : 'Failed to load models');
        }
      } finally {
        if (!abortController.signal.aborted) setIsModelCatalogLoading(false);
      }
    };

    void loadModels();
    return () => abortController.abort();
  }, [selectedProject?.fullPath, selectedProject?.path, selectedSession?.id]);

  useEffect(() => {
    return subscribe((message: any) => {
      if (message?.type !== 'config:reloaded') return;
      setThinkingModelContext(readThinkingModelContext(message?.config));
    });
  }, [subscribe]);

  const setPermissionMode = useCallback((nextMode: PermissionMode) => {
    const normalizedMode = COMPOSER_PERMISSION_MODES.includes(nextMode)
      ? nextMode
      : 'default';

    setPermissionModeState(normalizedMode);
    localStorage.setItem(DEFAULT_PERMISSION_MODE_KEY, normalizedMode);

    if (selectedSession?.id) {
      localStorage.setItem(`permissionMode-${selectedSession.id}`, normalizedMode);
    }
  }, [selectedSession?.id]);

  const cyclePermissionMode = useCallback(() => {
    const currentIndex = COMPOSER_PERMISSION_MODES.indexOf(permissionMode);
    const nextIndex = (currentIndex + 1) % COMPOSER_PERMISSION_MODES.length;
    const nextMode = COMPOSER_PERMISSION_MODES[nextIndex];
    setPermissionMode(nextMode);
  }, [permissionMode, setPermissionMode]);

  const setModelSelection = useCallback(async (selection: ChatModelSelection) => {
    const projectKey = selectedProject?.fullPath || selectedProject?.path || '';
    setModelSelectionState(selection);
    if (projectKey) {
      localStorage.setItem(`composer-model-${projectKey}`, JSON.stringify(selection));
    }
    if (selection.mode === 'model') {
      setModel(`${selection.provider}/${selection.model}`);
    }
    if (!projectKey || !selectedSession?.id) return;

    const response = await authenticatedFetch('/api/sessions/model', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectKey,
        sessionKey: selectedSession.id,
        selection,
      }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data?.error?.message || 'Failed to save model selection');
    }
  }, [selectedProject?.fullPath, selectedProject?.path, selectedSession?.id]);

  return {
    model,
    setModel,
    modelOptions,
    modelCatalog,
    modelSelection,
    setModelSelection,
    isModelCatalogLoading,
    modelCatalogError,
    thinkingModelContext,
    permissionMode,
    setPermissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
  };
}
