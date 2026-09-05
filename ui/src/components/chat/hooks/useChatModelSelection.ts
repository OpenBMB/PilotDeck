import { useCallback, useEffect, useRef, useState } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import { modelSelectionId, normalizeModelSelection, parseCatalogItem } from '../../chat-v2/modelCapabilityOptions';
import type { ChatModelCatalogItem, ChatModelSelection } from './useChatProviderState';
import { safeLocalStorage } from '../utils/chatStorage';

type Subscribe = (listener: (message: any) => void) => () => void;
type SelectionState = {
  scope: string;
  selection: ChatModelSelection | null;
  catalog: ChatModelCatalogItem[];
  loading: boolean;
  saving: boolean;
  error: string | null;
};

function readSelection(key: string): ChatModelSelection | null {
  try { return normalizeModelSelection(JSON.parse(safeLocalStorage.getItem(key) || 'null')); }
  catch { return null; }
}

function selectionError(selection: ChatModelSelection | null, catalog: ChatModelCatalogItem[]) {
  if (!selection) return 'No default model is configured. Choose a model.';
  if (!catalog.some((item) => item.id === modelSelectionId(selection) && item.available)) {
    return `Selected model is unavailable: ${modelSelectionId(selection)}. Choose another model.`;
  }
  return null;
}

/** A dialog choice is distinct from both a catalog row and a running request's model. */
export function useChatModelSelection({ projectKey, sessionId: selectedSessionId, subscribe }: {
  projectKey: string;
  sessionId?: string;
  subscribe: Subscribe;
}) {
  const sessionId = selectedSessionId?.startsWith('new-session-') ? undefined : selectedSessionId;
  const scope = JSON.stringify([projectKey, sessionId || '']);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const drafts = useRef(new Map<string, ChatModelSelection>());
  const saveVersions = useRef(new Map<string, number>());
  const pendingSaves = useRef(new Map<string, number>());
  const saveTail = useRef<Promise<void>>(Promise.resolve());
  const [refresh, setRefresh] = useState(0);
  const [state, setState] = useState<SelectionState>({
    scope: '', selection: null, catalog: [], loading: true, saving: false, error: null,
  });
  const [runningModels, setRunningModels] = useState<Record<string, { provider: string; model: string; runId?: string }>>({});

  useEffect(() => subscribe((message) => {
    if (message?.type === 'config:reloaded') setRefresh((value) => value + 1);
    const events = [message, ...(message?.activeTurnMessages || [])];
    for (const event of events) {
      // Bind a welcome-page choice to its new session before the session GET can finish.
      // A user may already have selected the next model while the first submission starts.
      if (event?.kind === 'session_created' && event.newSessionId && event.projectKey === projectKey && !sessionId) {
        const draft = drafts.current.get(scope);
        if (draft) {
          const createdScope = JSON.stringify([projectKey, event.newSessionId]);
          drafts.current.set(createdScope, draft);
          safeLocalStorage.setItem(`pending-composer-model-${createdScope}`, JSON.stringify(draft));
        }
      }
      if (event?.type === 'model-selection-saved' && event.sessionId) {
        const acceptedScope = JSON.stringify([projectKey, event.sessionId]);
        const pendingKey = `pending-composer-model-${acceptedScope}`;
        if (JSON.stringify(readSelection(pendingKey)) === JSON.stringify(event.selection)) safeLocalStorage.removeItem(pendingKey);
      }
      if (event?.type !== 'model-selection-changed' || !event.sessionId) continue;
      setRunningModels((previous) => ({
        ...previous,
        [event.sessionId]: { provider: event.modelProvider, model: event.model, runId: event.runId },
      }));
    }
  }), [projectKey, sessionId, scope, subscribe]);

  useEffect(() => {
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && scopeRef.current === scope;
    setState((previous) => ({
      scope, selection: previous.scope === scope ? previous.selection : null,
      catalog: previous.scope === scope ? previous.catalog : [], loading: true,
      saving: pendingSaves.current.has(scope), error: null,
    }));
    if (!projectKey) return () => controller.abort();

    const readJson = async (url: string) => {
      const response = await authenticatedFetch(url, { signal: controller.signal });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message || 'Failed to load model selection.');
      return data;
    };
    void (async () => {
      try {
        const [catalogData, sessionData] = await Promise.all([
          readJson(`/api/models?projectKey=${encodeURIComponent(projectKey)}&includeAuto=true`),
          sessionId ? readJson(`/api/sessions/model?${new URLSearchParams({ projectKey, sessionKey: sessionId })}`) : null,
        ]);
        if (!current()) return;
        const catalog: ChatModelCatalogItem[] = (Array.isArray(catalogData.items) ? catalogData.items : [])
          .map(parseCatalogItem).filter((item: ChatModelCatalogItem | null): item is ChatModelCatalogItem => Boolean(item));
        // Only explicit user choices populate these keys. Loading a catalog must never write a preference.
        const selection = drafts.current.get(scope)
          || (sessionId ? readSelection(`pending-composer-model-${scope}`) : null)
          || normalizeModelSelection(sessionData?.saved)
          || readSelection(`composer-model-${projectKey}`)
          || normalizeModelSelection(catalogData.defaultSelection);
        setState({
          scope, selection, catalog, loading: false,
          saving: pendingSaves.current.has(scope),
          error: selectionError(selection, catalog),
        });
      } catch (error) {
        if (current()) setState((previous) => ({
          ...previous, loading: false, error: error instanceof Error ? error.message : String(error),
        }));
      }
    })();
    return () => controller.abort();
  }, [projectKey, sessionId, scope, refresh]);

  const setModelSelection = useCallback(async (value: ChatModelSelection) => {
    const selection = { ...value };
    drafts.current.set(scope, selection);
    safeLocalStorage.setItem(`composer-model-${projectKey}`, JSON.stringify(selection));
    const pendingKey = `pending-composer-model-${scope}`;
    if (sessionId) safeLocalStorage.setItem(pendingKey, JSON.stringify(selection));
    const version = (saveVersions.current.get(scope) || 0) + 1;
    saveVersions.current.set(scope, version);
    if (sessionId) pendingSaves.current.set(scope, version);
    setState((previous) => ({
      ...previous, selection, saving: Boolean(sessionId),
      error: selectionError(selection, previous.catalog),
    }));
    if (!sessionId) return;

    // Serialize writes: a slower save of A must never overwrite a later choice of B.
    const save = saveTail.current.catch(() => {}).then(async () => {
      if (saveVersions.current.get(scope) !== version) return;
      const response = await authenticatedFetch('/api/sessions/model', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectKey, sessionKey: sessionId, selection }),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        // While a turn runs, this is the next message's draft. Submission will persist it atomically.
        if (response.status === 409 && data?.error?.code === 'SESSION_BUSY') return;
        throw new Error(data?.error?.message || 'Failed to save model selection.');
      }
      // Retain the next-message draft until matching input is accepted. An older
      // queued message can still persist its own snapshot after this PUT succeeds.
    });
    saveTail.current = save;
    try { await save; }
    catch (error) {
      if (scopeRef.current === scope && saveVersions.current.get(scope) === version) {
        setState((previous) => ({ ...previous, error: error instanceof Error ? error.message : String(error) }));
        throw error;
      }
    } finally {
      if (pendingSaves.current.get(scope) === version) pendingSaves.current.delete(scope);
      if (scopeRef.current === scope && saveVersions.current.get(scope) === version) {
        setState((previous) => ({ ...previous, saving: false }));
      }
    }
  }, [projectKey, sessionId, scope]);

  const isCurrent = state.scope === scope;
  return {
    modelSelection: isCurrent ? state.selection : null,
    modelCatalog: isCurrent ? state.catalog : [],
    isModelCatalogLoading: !isCurrent || state.loading,
    isModelSelectionReady: isCurrent && !state.loading && !state.saving && !state.error && Boolean(state.selection),
    modelCatalogError: isCurrent ? state.error : null,
    setModelSelection,
    runningModels,
  };
}
