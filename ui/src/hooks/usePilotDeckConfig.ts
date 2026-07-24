import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
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
  revision?: string;
  configDisabled?: boolean;
  parseError?: string | null;
  validation: ConfigValidation;
  reload?: ConfigReload;
};

export type ConfigProviderRename = {
  from: string;
  to: string;
};

export type ConfigSaveOptions = {
  providerRenames?: ConfigProviderRename[];
};

export type ConfigSaveResult =
  | { ok: true }
  | { ok: false; error: string };

type ReloadSource = 'ui-save' | 'ui-reload' | 'watcher' | 'refresh';

type ReloadInfo = {
  source: ReloadSource;
  at: number;
};

function usePilotDeckConfigState() {
  const [path, setPath] = useState('');
  const [raw, setRaw] = useState('');
  const [revision, setRevision] = useState('');
  const [exists, setExists] = useState(false);
  const [validation, setValidation] = useState<ConfigValidation | null>(null);
  const [reload, setReload] = useState<ConfigReload | null>(null);
  const [configDisabled, setConfigDisabled] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
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
  const revisionRef = useRef(revision);
  revisionRef.current = revision;

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
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const saveSequenceRef = useRef(0);
  const pendingSaveCountRef = useRef(0);

  const applyResponse = useCallback((data: ConfigResponse, source: ReloadSource = 'refresh') => {
    setPath(data.path);
    setRaw(data.raw);
    savedRawRef.current = data.raw;
    if (typeof data.revision === 'string') {
      revisionRef.current = data.revision;
      setRevision(data.revision);
    }
    setExists(data.exists);
    setConfigDisabled(data.configDisabled === true);
    setParseError(data.parseError ?? null);
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
    rawRef.current = value;
    setRaw(value);
    scheduleValidation(value);
  }, [scheduleValidation]);

  const restoreRawIfCurrent = useCallback((
    expected: string,
    previous: string,
  ): boolean => {
    if (rawRef.current !== expected) return false;
    updateRaw(previous);
    return true;
  }, [updateRaw]);

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

      const keepLocalDraft = (
        isDirtyRef.current
        && source === 'watcher'
      ) || (
        source === 'ui-save'
        && payload.raw !== rawRef.current
        && (
          pendingSaveCountRef.current > 0
          || isDirtyRef.current
        )
      );

      if (keepLocalDraft) {
        if (source === 'watcher') {
          setExternalChangeNotice(
            'Config was changed on disk by an external edit. Your unsaved draft is kept — click Refresh to discard and load the new version.',
          );
        }
        setValidation(payload.validation);
        setReload((payload.reload as ConfigReload | undefined) ?? null);
        setConfigDisabled(payload.configDisabled === true);
        setParseError(payload.parseError ?? null);
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
          revision: payload.revision,
          configDisabled: payload.configDisabled,
          parseError: payload.parseError,
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

  const save = useCallback((options: ConfigSaveOptions = {}): Promise<ConfigSaveResult> => {
    const draft = rawRef.current;
    const sequence = ++saveSequenceRef.current;
    pendingSaveCountRef.current += 1;
    setSaving(true);
    setError(null);
    setMessage(null);

    const run = async (): Promise<ConfigSaveResult> => {
      try {
        const baseRevision = revisionRef.current;
        const response = await authenticatedFetch('/api/config', {
          method: 'PUT',
          body: JSON.stringify({
            raw: draft,
            ...(baseRevision ? { baseRevision } : {}),
            ...(options.providerRenames?.length
              ? { providerRenames: options.providerRenames }
              : {}),
          }),
        });
        const data = await response.json();
        if (!response.ok) {
          throw new Error(
            data.error
              || data.validation?.errors?.join(', ')
              || 'Failed to save config',
          );
        }

        // Every successful queued write advances the disk snapshot, even when
        // a newer local draft means this response must not replace the editor.
        // Keeping this snapshot current ensures `isDirty` still compares the
        // draft with what is actually on disk after an in-flight edit.
        if (typeof data.raw === 'string') {
          savedRawRef.current = data.raw;
          isDirtyRef.current = rawRef.current !== data.raw;
        }
        if (typeof data.revision === 'string') {
          revisionRef.current = data.revision;
          setRevision(data.revision);
        }

        // Immediate-mode fields can enqueue another draft before this request
        // finishes. Only the newest response may replace the editor state;
        // every queued write still reaches disk in order.
        if (
          sequence === saveSequenceRef.current
          && rawRef.current === draft
        ) {
          applyResponse(data, 'ui-save');
          setMessage('Saved and reloaded');
          setExternalChangeNotice(null);
        }
        return { ok: true };
      } catch (caught) {
        const message = caught instanceof Error
          ? caught.message
          : 'Failed to save config';
        if (sequence === saveSequenceRef.current) {
          setError(message);
          if (
            caught instanceof Error
            && caught.message.toLowerCase().includes('config changed')
          ) {
            setExternalChangeNotice(
              'Config changed while this draft was being saved. Your draft was not written — refresh before saving again.',
            );
          }
        }
        return { ok: false, error: message };
      } finally {
        pendingSaveCountRef.current = Math.max(
          0,
          pendingSaveCountRef.current - 1,
        );
        if (pendingSaveCountRef.current === 0) {
          setSaving(false);
        }
      }
    };

    const result = saveQueueRef.current.then(run, run);
    saveQueueRef.current = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
    revision,
    setRaw: updateRaw,
    restoreRawIfCurrent,
    exists,
    validation,
    reload,
    configDisabled,
    parseError,
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

type PilotDeckConfigController = ReturnType<typeof usePilotDeckConfigState>;

const PilotDeckConfigContext = createContext<PilotDeckConfigController | null>(null);

export function PilotDeckConfigProvider({ children }: { children: ReactNode }) {
  const controller = usePilotDeckConfigState();
  return createElement(
    PilotDeckConfigContext.Provider,
    { value: controller },
    children,
  );
}

export function usePilotDeckConfig(): PilotDeckConfigController {
  const controller = useContext(PilotDeckConfigContext);
  if (!controller) {
    throw new Error('usePilotDeckConfig must be used within PilotDeckConfigProvider');
  }
  return controller;
}
