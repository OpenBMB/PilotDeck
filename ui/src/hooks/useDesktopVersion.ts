import { useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from '../utils/api';

export type DesktopVersionInfo = {
  currentVersion: string;
  latestVersion: string | null;
  latestTagName: string | null;
  hasUpdate: boolean;
  checkUnavailable: boolean;
  message?: string;
  releaseUrl?: string;
  selectedAsset?: {
    id: number;
    name: string;
    size: number;
    downloadUrl: string;
  } | null;
};

export type DesktopDownloadStatus = {
  state: 'idle' | 'downloading' | 'downloaded' | 'failed' | 'cancelled';
  progress: number;
  receivedBytes: number;
  totalBytes: number | null;
  filePath: string | null;
  error: string | null;
};

export function useDesktopVersion() {
  const [info, setInfo] = useState<DesktopVersionInfo | null>(null);
  const [checking, setChecking] = useState(false);
  const [download, setDownload] = useState<DesktopDownloadStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const fetchStatus = useCallback(async () => {
    setChecking(true);
    try {
      const res = await authenticatedFetch('/api/update/desktop/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) throw new Error('Failed to check desktop version');
      const data = await res.json();

      setInfo({
        currentVersion: data.current?.version ?? 'unknown',
        latestVersion: data.latest?.version ?? null,
        latestTagName: data.latest?.tagName ?? null,
        hasUpdate: Boolean(data.hasUpdate),
        checkUnavailable: Boolean(data.checkUnavailable),
        message: data.message,
        releaseUrl: data.latest?.htmlUrl,
        selectedAsset: data.latest?.selectedAsset ?? null,
      });
      setError(null);
    } catch (e) {
      setInfo({
        currentVersion: 'unknown',
        latestVersion: null,
        latestTagName: null,
        hasUpdate: false,
        checkUnavailable: true,
        message: e instanceof Error ? e.message : String(e),
      });
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    const interval = setInterval(fetchStatus, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchStatus]);

  const triggerDownload = useCallback(async () => {
    try {
      const res = await authenticatedFetch('/api/update/desktop/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || 'Failed to start download');
      }
      const data = await res.json();
      setDownload(data.download ?? null);

      pollRef.current = setInterval(async () => {
        try {
          const pollRes = await authenticatedFetch('/api/update/desktop/download/status');
          if (!pollRes.ok) return;
          const pollData = await pollRes.json();
          const dl = pollData.download;
          setDownload(dl ?? null);

          if (dl && (dl.state === 'downloaded' || dl.state === 'failed' || dl.state === 'cancelled')) {
            stopPolling();
          }
        } catch {
          // polling failure is non-fatal
        }
      }, 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDownload({
        state: 'failed',
        progress: 0,
        receivedBytes: 0,
        totalBytes: null,
        filePath: null,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, [stopPolling]);

  const triggerInstall = useCallback(async () => {
    try {
      const res = await authenticatedFetch('/api/update/desktop/install', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filePath: download?.filePath }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || 'Failed to launch installer');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [download?.filePath]);

  const cancelDownload = useCallback(async () => {
    stopPolling();
    try {
      await authenticatedFetch('/api/update/desktop/download/cancel', {
        method: 'POST',
      });
    } catch {
      // best-effort
    }
    setDownload(null);
  }, [stopPolling]);

  useEffect(() => stopPolling, [stopPolling]);

  return {
    info,
    checking,
    download,
    error,
    fetchStatus,
    triggerDownload,
    triggerInstall,
    cancelDownload,
  };
}
