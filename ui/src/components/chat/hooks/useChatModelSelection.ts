import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { authenticatedFetch } from '../../../utils/api';
import { normalizeModelSelection, modelSelectionId, capabilityIncludesValue } from '../../chat-v2/modelCapabilityOptions';
import { globalModelSelectionStore, modelSelectionError, readSessionModelSelection } from '../utils/globalModelSelection';
import type { ChatModelSelection } from './useChatProviderState';

/** History restores its last send; a new conversation inherits the last global send. */
export function useChatModelSelection({ projectKey = '', sessionId = '' }: { projectKey?: string; sessionId?: string } = {}) {
  const state = useSyncExternalStore(globalModelSelectionStore.subscribe, globalModelSelectionStore.getSnapshot);
  const key = JSON.stringify([projectKey, sessionId]);
  const revision = globalModelSelectionStore.getSessionRevision(sessionId);
  const [draft, setDraft] = useState<{ key: string; value: ChatModelSelection } | null>(null);
  const [history, setHistory] = useState<{ key: string; revision: number; selection: ChatModelSelection | null; error: string | null } | null>(null);
  const local = sessionId ? readSessionModelSelection(projectKey, sessionId) : null;
  useEffect(() => { void globalModelSelectionStore.load(); }, []);
  useEffect(() => {
    setDraft(null);
  }, [key]);
  useEffect(() => {
    setHistory(null);
    if (!projectKey || !sessionId) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ projectKey, sessionKey: sessionId });
    void (async () => {
      try {
        const response = await authenticatedFetch(`/api/sessions/model?${query}`, { signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw new Error(data?.error?.message || 'Failed to restore conversation model.');
        if (!controller.signal.aborted && globalModelSelectionStore.getSessionRevision(sessionId) === revision) setHistory({ key, revision, selection: normalizeModelSelection(data.acceptedSelection) || normalizeModelSelection(data.saved), error: null });
      } catch (error) {
        if (!controller.signal.aborted && globalModelSelectionStore.getSessionRevision(sessionId) === revision) setHistory({ key, revision, selection: null, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return () => controller.abort();
  }, [key, projectKey, sessionId, revision]);
  const currentDraft = draft?.key === key ? draft.value : null;
  const currentHistory = history?.key === key && history.revision === revision ? history : null;
  const restoring = Boolean(projectKey && sessionId && !currentHistory && !currentDraft);
  const savedSelection = currentDraft || (currentHistory && !currentHistory.error
    ? currentHistory.selection || state.selection
    : local || state.selection);
  const item = state.catalog.find(candidate => candidate.id === modelSelectionId(savedSelection));
  let selection = savedSelection;
  if (selection?.mode === 'model' && selection.reasoning !== undefined && item &&
      (!item.capabilities.reasoning || !capabilityIncludesValue(item.capabilities.reasoning, selection.reasoning))) {
    const { reasoning: _stale, ...rest } = selection;
    selection = rest;
  }
  const error = modelSelectionError({ ...state, selection, error: state.error || (!currentDraft ? currentHistory?.error : null) || null });
  const empty = !state.loading && state.catalog.length === 0 && !state.error;
  const setModelSelection = useCallback((value: ChatModelSelection) => setDraft({ key, value: { ...value } }), [key]);
  return {
    modelSelection: selection,
    modelCatalog: state.catalog,
    isModelCatalogLoading: state.loading && state.catalog.length === 0,
    isModelSelectionReady: !state.loading && !restoring && !error && Boolean(selection),
    modelCatalogError: state.loading || restoring || empty ? null : error,
    setModelSelection,
  };
}
