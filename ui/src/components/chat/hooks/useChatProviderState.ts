import { useCallback, useEffect, useState } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import { CLAUDE_MODELS } from '../../../../shared/modelConstants';
import type { PendingPermissionRequest, PermissionMode } from '../types/types';
import type { ProjectSession } from '../../../types/app';

interface UseChatProviderStateArgs {
  selectedSession: ProjectSession | null;
}

type ModelOption = {
  value: string;
  label: string;
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

export function useChatProviderState({ selectedSession }: UseChatProviderStateArgs) {
  const [permissionMode, setPermissionModeState] = useState<PermissionMode>(() => {
    return readStoredPermissionMode(DEFAULT_PERMISSION_MODE_KEY) || 'default';
  });
  const [pendingPermissionRequests, setPendingPermissionRequests] = useState<PendingPermissionRequest[]>([]);
  const [model, setModel] = useState<string>(() => {
    return localStorage.getItem('pilotdeck-model') || CLAUDE_MODELS.DEFAULT;
  });
  const [modelOptions, setModelOptions] = useState<ModelOption[]>(DEFAULT_MODEL_OPTIONS);

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

    return () => {
      cancelled = true;
    };
  }, []);

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

  return {
    model,
    setModel,
    modelOptions,
    permissionMode,
    setPermissionMode,
    pendingPermissionRequests,
    setPendingPermissionRequests,
    cyclePermissionMode,
  };
}
