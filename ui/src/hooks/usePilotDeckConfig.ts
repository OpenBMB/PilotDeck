import { useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from '../utils/api';
import { useWebSocket } from '../contexts/WebSocketContext';

type ConfigValidation = {
  valid: boolean;
  errors: string[];
  warnings: string[];
};

type SubsystemResult = {
  reloaded?: boolean;
  skipped?: boolean;
  reason?: string;
  error?: string;
  note?: string;
  configPath?: string;
};

export type ConfigReload = {
  processEnv?: SubsystemResult;
  memory?: SubsystemResult;
  router?: SubsystemResult;
  gateway?: SubsystemResult;
  proxy?: SubsystemResult;
} & Record<string, unknown>;

type ConfigResponse = {
  exists: boolean;
  path: string;
  raw: string;
  validation: ConfigValidation;
  reload?: ConfigReload;
};

type ReloadSource = 'ui-save' | 'ui-reload' | 'watcher' | 'refresh';

type ReloadInfo = {
  source: ReloadSource;
  at: number;
};

export function usePilotDeckConfig() {
  const [path, setPath] = useState('');
  const [raw, setRaw] = useState('');
  const [exists, setExists] = useState(false);
  const [validation, setValidation] = useState<ConfigValidation | null>(null);
  const [reload, setReload] = useState<ConfigReload | null>(null);
  const [lastReloadInfo, setLastReloadInfo] = useState<ReloadInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [externalChangeNotice, setExternalChangeNotice] = useState<string | null>(null);

  // Users may be typing in the <textarea> when an external edit arrives.
  // Track local edits so we don't clobber unsaved input.
  const savedRawRef = useRef<string>('');
  const rawRef = useRef(raw);
  rawRef.current = raw;

  // Derive dirty from the draft vs last-saved snapshot so the Save button
  // can't desync from the textarea (especially in Raw YAML mode).
  const isDirty = raw !== savedRawRef.current;

  // Mirror dirty into a ref so the WS subscriber can read the current
  // value WITHOUT subscribing to `raw` (which would re-apply stale payloads
  // on every keystroke).
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;

  const { subscribe } = useWebSocket();
  const initialLoadDoneRef = useRef(false);
  const validateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const applyResponse = useCallback((data: ConfigResponse, source: ReloadSource = 'refresh') => {
    setPath(data.path);
    setRaw(data.raw);
    savedRawRef.current = data.raw;
    setExists(data.exists);
    setValidation(data.validation);
    setReload((data.reload as ConfigReload | undefined) ?? null);
    setLastReloadInfo({ source, at: Date.now() });
  }, []);

  const applyResponseRef = useRef(applyResponse);
  applyResponseRef.current = applyResponse;

  const scheduleValidation = useCallback((value: string) => {
    if (validateTimerRef.current) {
      clearTimeout(validateTimerRef.current);
    }
    validateTimerRef.current = setTimeout(() => {
      void (async () => {
        try {
          const response = await authenticatedFetch('/api/config/validate', {
            method: 'POST',
            body: JSON.stringify({ raw: value }),
          });
          const data = await response.json();
          if (data && typeof data.valid === 'boolean') {
            setValidation(data as ConfigValidation);
          }
        } catch {
          // Validation is advisory for the editor — save still goes to PUT.
        }
      })();
    }, 400);
  }, []);

  const updateRaw = useCallback((value: string) => {
    setRaw(value);
    scheduleValidation(value);
  }, [scheduleValidation]);

  const refreshRef = useRef<() => Promise<void>>();

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authenticatedFetch('/api/config');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to load config');
      applyResponse(data, 'refresh');
      initialLoadDoneRef.current = true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to load config');
    } finally {
      setLoading(false);
    }
  }, [applyResponse]);

  refreshRef.current = refresh;

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => () => {
    if (validateTimerRef.current) {
      clearTimeout(validateTimerRef.current);
    }
  }, []);

  // Use the synchronous subscribe mechanism instead of latestMessage state
  // to guarantee config:reloaded events are never lost to React 18
  // auto-batching when other WS messages arrive in the same task.
  useEffect(() => {
    const unsub = subscribe((msg: any) => {
      if (msg?.type === 'websocket-reconnected') {
        if (initialLoadDoneRef.current) {
          void refreshRef.current?.();
        }
        return;
      }

      if (msg?.type !== 'config:reloaded') return;
      if (!initialLoadDoneRef.current) return;

      const payload = msg as ConfigResponse & {
        source?: ReloadSource;
        timestamp?: string;
      };
      const source: ReloadSource = payload.source ?? 'watcher';

      if (isDirtyRef.current && source === 'watcher') {
        setExternalChangeNotice(
          'Config was changed on disk by an external edit. Your unsaved draft is kept — click Refresh to discard and load the new version.',
        );
        setValidation(payload.validation);
        setReload((payload.reload as ConfigReload | undefined) ?? null);
        setPath(payload.path);
        setExists(true);
        setLastReloadInfo({ source, at: Date.now() });
        return;
      }

      applyResponseRef.current(
        {
          exists: true,
          path: payload.path,
          raw: payload.raw ?? '',
          validation: payload.validation,
          reload: payload.reload as ConfigReload | undefined,
        },
        source,
      );
      if (source === 'watcher') {
        setExternalChangeNotice('Config was updated on disk — the new version is now loaded.');
      } else {
        setExternalChangeNotice(null);
      }
    });
    return unsub;
  }, [subscribe]);

  const save = useCallback(async () => {
    const draft = rawRef.current;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await authenticatedFetch('/api/config', {
        method: 'PUT',
        body: JSON.stringify({ raw: draft }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.validation?.errors?.join(', ') || 'Failed to save config');
      applyResponse(data, 'ui-save');
      setMessage('Saved and reloaded');
      setExternalChangeNotice(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to save config');
    } finally {
      setSaving(false);
    }
  }, [applyResponse]);

  const reloadConfig = useCallback(async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const response = await authenticatedFetch('/api/config/reload', { method: 'POST' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Failed to reload config');
      applyResponse(data, 'ui-reload');
      setMessage('Reloaded current config');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to reload config');
    } finally {
      setSaving(false);
    }
  }, [applyResponse]);

  const openFile = useCallback(async () => {
    setOpening(true);
    setError(null);
    try {
      const response = await authenticatedFetch('/api/config/open', { method: 'POST' });
      const data = await response.json();
      if (!data.success && data.error) throw new Error(data.error);
      setMessage(`Config file: ${data.path}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to open config file');
    } finally {
      setOpening(false);
    }
  }, []);

  const dismissExternalNotice = useCallback(() => setExternalChangeNotice(null), []);

  return {
    path,
    raw,
    setRaw: updateRaw,
    exists,
    validation,
    reload,
    lastReloadInfo,
    isDirty,
    externalChangeNotice,
    dismissExternalNotice,
    loading,
    saving,
    opening,
    error,
    message,
    refresh,
    save,
    reloadConfig,
    openFile,
  };
}
