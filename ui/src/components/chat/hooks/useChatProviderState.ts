import { useCallback, useEffect, useState } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import { useWebSocket } from '../../../contexts/WebSocketContext';
import { CLAUDE_MODELS } from '../../../../shared/modelConstants';
import type { PendingPermissionRequest } from '../types/types';
import type { Project, ProjectSession } from '../../../types/app';
import { useChatModelSelection } from './useChatModelSelection';
import { useChatPermissionMode } from './useChatPermissionMode';

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
  thinking?: { state?: string; efforts?: string[] };
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
      speed?: number;
    };

const DEFAULT_MODEL_OPTIONS: ModelOption[] = CLAUDE_MODELS.OPTIONS.map((option) => ({
  ...option,
}));

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
    thinking: modelDefinition?.thinking as ThinkingModelContext['thinking'],
    supportsThinking: typeof capabilities?.supportsThinking === 'boolean' ? capabilities.supportsThinking : undefined,
  };
}

export function useChatProviderState({ selectedProject, selectedSession }: UseChatProviderStateArgs) {
  const { subscribe } = useWebSocket();
  const permissionState = useChatPermissionMode();
  const [pendingPermissionRequests, setPendingPermissionRequests] = useState<PendingPermissionRequest[]>([]);
  const [model, setModel] = useState<string>(() => {
    return localStorage.getItem('pilotdeck-model') || CLAUDE_MODELS.DEFAULT;
  });
  const [modelOptions, setModelOptions] = useState<ModelOption[]>(DEFAULT_MODEL_OPTIONS);
  const [thinkingModelContext, setThinkingModelContext] = useState<ThinkingModelContext | null>(null);
  const modelState = useChatModelSelection({
    projectKey: selectedProject?.fullPath || selectedProject?.path || '',
    sessionId: selectedSession?.id || '',
  });

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
    return subscribe((message: any) => {
      if (message?.type !== 'config:reloaded') return;
      setThinkingModelContext(readThinkingModelContext(message?.config));
    });
  }, [subscribe]);

  const cyclePermissionMode = useCallback(() => {
    void permissionState.setPermissionMode(permissionState.permissionMode === 'default' ? 'bypassPermissions' : 'default').catch(() => {});
  }, [permissionState.permissionMode, permissionState.setPermissionMode]);


  return {
    model: modelState.modelSelection?.mode === 'model'
      ? `${modelState.modelSelection.provider}/${modelState.modelSelection.model}` : model,
    setModel,
    modelOptions,
    ...modelState,
    thinkingModelContext,
    ...permissionState,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
  };
}
