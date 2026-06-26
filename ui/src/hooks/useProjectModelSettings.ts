import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authenticatedFetch } from '../utils/api';

export type ProjectModelSettings = {
  mainModel?: string;
  thinking?: {
    enabled?: boolean;
    budgetTokens?: number;
  };
  tokenSaver?: {
    enabled?: boolean;
    judge?: string;
    defaultTier?: string;
    tiers?: Record<string, { model?: string; description?: string }>;
    subagentPolicy?: 'skip' | 'judge';
  };
  autoOrchestrate?: {
    enabled?: boolean;
    mainAgentModel?: string;
    subagentModel?: string;
    triggerTiers?: string[];
  };
  fallback?: {
    default?: string[];
    subagent?: string[];
    explicit?: string[];
  };
};

export type ProjectModelOption = {
  id: string;
  provider: string;
  model: string;
  label: string;
};

export type ProjectModelSettingsResponse = {
  projectKey: string;
  configPath: string;
  exists: boolean;
  inherited: ProjectModelSettings;
  settings: ProjectModelSettings;
  effective: ProjectModelSettings;
  modelOptions: ProjectModelOption[];
  diagnostics: Array<{ severity: 'warning' | 'error'; message: string; path?: string }>;
  saved?: boolean;
};

const clone = (value: ProjectModelSettings): ProjectModelSettings =>
  JSON.parse(JSON.stringify(value ?? {})) as ProjectModelSettings;

export function useProjectModelSettings(projectName?: string, savedMessage = 'Saved for this project') {
  const activeProjectRef = useRef(projectName);
  const loadRequestIdRef = useRef(0);
  const saveRequestIdRef = useRef(0);
  const [data, setData] = useState<ProjectModelSettingsResponse | null>(null);
  const [draft, setDraft] = useState<ProjectModelSettings>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(data?.settings ?? {}),
    [draft, data?.settings],
  );

  activeProjectRef.current = projectName;

  useEffect(() => {
    setSaving(false);
  }, [projectName]);

  const refresh = useCallback(async () => {
    const requestProject = projectName;
    const requestId = loadRequestIdRef.current + 1;
    loadRequestIdRef.current = requestId;
    if (!requestProject) {
      setData(null);
      setDraft({});
      setError(null);
      setMessage(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      const response = await authenticatedFetch(`/api/projects/${encodeURIComponent(requestProject)}/model-settings`);
      const result = (await response.json()) as ProjectModelSettingsResponse & { error?: string };
      if (!response.ok) throw new Error(result.error || 'Failed to load project model settings');
      if (activeProjectRef.current !== requestProject || loadRequestIdRef.current !== requestId) return;
      setData(result);
      setDraft(clone(result.settings));
    } catch (caught) {
      if (activeProjectRef.current !== requestProject || loadRequestIdRef.current !== requestId) return;
      setError(caught instanceof Error ? caught.message : 'Failed to load project model settings');
    } finally {
      if (activeProjectRef.current === requestProject && loadRequestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [projectName]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(async () => {
    const requestProject = projectName;
    const requestId = saveRequestIdRef.current + 1;
    saveRequestIdRef.current = requestId;
    if (!requestProject) return false;
    loadRequestIdRef.current += 1;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await authenticatedFetch(`/api/projects/${encodeURIComponent(requestProject)}/model-settings`, {
        method: 'PUT',
        body: JSON.stringify({ settings: draft }),
      });
      const result = (await response.json()) as ProjectModelSettingsResponse & { error?: string };
      if (!response.ok) throw new Error(result.error || 'Failed to save project model settings');
      if (activeProjectRef.current !== requestProject || saveRequestIdRef.current !== requestId) return false;
      setData(result);
      setDraft(clone(result.settings));
      setMessage(savedMessage);
      return true;
    } catch (caught) {
      if (activeProjectRef.current !== requestProject || saveRequestIdRef.current !== requestId) return false;
      setError(caught instanceof Error ? caught.message : 'Failed to save project model settings');
      return false;
    } finally {
      if (saveRequestIdRef.current === requestId) {
        setSaving(false);
      }
    }
  }, [draft, projectName, savedMessage]);

  return {
    data,
    draft,
    setDraft,
    loading,
    saving,
    error,
    message,
    dirty,
    refresh,
    save,
  };
}
