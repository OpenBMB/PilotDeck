import { useCallback, useEffect, useState } from 'react';
import { authenticatedFetch } from '../utils/api';

export type GitVersionInfo = {
  commitSha: string;
  branch: string;
  hasUpdate: boolean;
  behindCount: number;
  newCommits: string[];
  currentCommit: string;
  remoteHead: string;
  checkUnavailable: boolean;
  message?: string;
};

export function useGitVersion() {
  const [info, setInfo] = useState<GitVersionInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchVersion = useCallback(async () => {
    try {
      const res = await authenticatedFetch('/api/update/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) throw new Error('Failed to check version');
      const data = await res.json();
      setInfo({
        commitSha: data.localHead,
        branch: data.currentBranch,
        hasUpdate: Boolean(data.hasUpdate),
        behindCount: data.behindCount ?? 0,
        newCommits: data.newCommits ?? [],
        currentCommit: data.currentCommit ?? '',
        remoteHead: data.remoteHead ?? '',
        checkUnavailable: Boolean(data.checkUnavailable),
        message: data.message,
      });
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    fetchVersion();
    const interval = setInterval(fetchVersion, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchVersion]);

  const triggerUpdate = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authenticatedFetch('/api/update/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      if (!res.ok && res.status === 409) {
        setError('Update already in progress');
        return { success: false, lines: [] as string[] };
      }

      const reader = res.body?.getReader();
      const decoder = new TextDecoder();
      const lines: string[] = [];

      if (reader) {
        let done = false;
        while (!done) {
          const { value, done: streamDone } = await reader.read();
          done = streamDone;
          if (value) {
            const text = decoder.decode(value, { stream: true });
            for (const line of text.split('\n').filter(Boolean)) {
              try {
                const parsed = JSON.parse(line);
                lines.push(parsed.message || line);
              } catch {
                lines.push(line);
              }
            }
          }
        }
      }

      return { success: true, lines };
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return { success: false, lines: [] as string[] };
    } finally {
      setLoading(false);
    }
  }, []);

  const triggerRestart = useCallback(async () => {
    try {
      await authenticatedFetch('/api/update/restart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
    } catch {
      // Expected — server will die
    }
  }, []);

  return { info, loading, error, fetchVersion, triggerUpdate, triggerRestart };
}
