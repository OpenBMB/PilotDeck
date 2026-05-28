import { useState, useEffect, useCallback } from 'react';
import { authenticatedFetch } from '../utils/api';

export type TokenBucket = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  requestCount: number;
  estimatedCost: number;
  baselineCost?: number;
  savedCost?: number;
};

export type CCRProvider = {
  name: string;
  api_base_url: string;
  api_key: string;
  models: string[];
  transformer?: { use: string[] };
};

export type CCRTier = {
  model: string;
  description: string;
};

export type CCRConfig = {
  LOG?: boolean;
  HOST?: string;
  PORT?: number;
  API_TIMEOUT_MS?: number;
  Providers: CCRProvider[];
  Router: {
    default: string;
    tokenSaver?: {
      enabled: boolean;
      judgeProvider: string;
      judgeModel: string;
      defaultTier: string;
      tiers: Record<string, CCRTier>;
      subagentPolicy?: string;
      rules?: string[];
    };
    autoOrchestrate?: {
      enabled: boolean;
      triggerTiers: string[];
      mainAgentModel: string;
      skillPath?: string;
      slimSystemPrompt?: boolean;
    };
  };
  tokenStats?: { enabled: boolean };
};

export type CCRHealth = {
  status: string;
  timestamp: string;
  port: number | null;
  embedded: boolean;
};

export type CCRStatsSummary = {
  lifetime?: {
    total: TokenBucket;
    byScenario?: Record<string, TokenBucket>;
    byProvider?: Record<string, TokenBucket>;
    byTier?: Record<string, TokenBucket>;
  };
  lastUpdatedAt?: string;
  startedAt?: string;
  error?: string;
};

export function useRouterSettings() {
  const [config, setConfig] = useState<CCRConfig | null>(null);
  const [health, setHealth] = useState<CCRHealth | null>(null);
  const [summary, setSummary] = useState<CCRStatsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveResult, setSaveResult] = useState<{ success: boolean; message: string } | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [healthRes, configRes, summaryRes] = await Promise.all([
        authenticatedFetch('/api/ccr/health').catch(() => null),
        authenticatedFetch('/api/ccr/config').catch(() => null),
        authenticatedFetch('/api/ccr/stats/summary').catch(() => null),
      ]);

      if (healthRes?.ok) setHealth(await healthRes.json());
      if (configRes?.ok) setConfig(await configRes.json());
      if (summaryRes?.ok) setSummary(await summaryRes.json());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load CCR data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const saveConfig = useCallback(async (newConfig: CCRConfig) => {
    setSaving(true);
    setSaveResult(null);
    try {
      const res = await authenticatedFetch('/api/ccr/config', {
        method: 'PUT',
        body: JSON.stringify(newConfig),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setSaveResult({
          success: true,
          message: data.restarted ? 'Saved & CCR restarted' : 'Saved (CCR restart pending)',
        });
        await fetchAll();
      } else {
        setSaveResult({ success: false, message: data.error || 'Save failed' });
      }
    } catch (err: unknown) {
      setSaveResult({ success: false, message: err instanceof Error ? err.message : 'Save failed' });
    } finally {
      setSaving(false);
    }
  }, [fetchAll]);

  const resetStats = useCallback(async () => {
    try {
      await authenticatedFetch('/api/ccr/stats/reset', { method: 'POST' });
      await fetchAll();
    } catch { /* best effort */ }
  }, [fetchAll]);

  return {
    config,
    setConfig,
    health,
    summary,
    loading,
    saving,
    error,
    saveResult,
    saveConfig,
    resetStats,
    refresh: fetchAll,
  };
}
