import { useState, useEffect, useCallback, useRef } from 'react';
import { authenticatedFetch } from '../utils/api';
import type { TokenBucket } from './useRouterSettings';

export type CCRSessionStats = {
  sessionId: string;
  total: TokenBucket;
  byScenario: Record<string, TokenBucket>;
  byTier: Record<string, TokenBucket>;
  firstSeenAt: string;
  lastActiveAt: string;
};

const POLL_INTERVAL_MS = 15_000;

export function useCCRSessionStats(sessionId: string | null | undefined) {
  const [stats, setStats] = useState<CCRSessionStats | null>(null);
  const [loading, setLoading] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const hasFetchedRef = useRef(false);

  const fetchStats = useCallback(async () => {
    if (!sessionId) return;
    const isInitial = !hasFetchedRef.current;
    if (isInitial) setLoading(true);
    try {
      const res = await authenticatedFetch(`/api/ccr/stats/sessions/${sessionId}`);
      if (res.ok) {
        setStats(await res.json());
      } else {
        setStats(null);
      }
    } catch {
      setStats(null);
    } finally {
      hasFetchedRef.current = true;
      if (isInitial) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    fetchStats();
    intervalRef.current = setInterval(fetchStats, POLL_INTERVAL_MS);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchStats]);

  return { stats, loading, refresh: fetchStats };
}
