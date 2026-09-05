import { useEffect, useState, useSyncExternalStore } from 'react';
import { globalModelSelectionStore, modelSelectionError } from '../utils/globalModelSelection';

type Subscribe = (listener: (message: any) => void) => () => void;

/** Only manual choices change the preference; run events describe execution history. */
export function useChatModelSelection({ subscribe }: { subscribe: Subscribe }) {
  const state = useSyncExternalStore(globalModelSelectionStore.subscribe, globalModelSelectionStore.getSnapshot);
  const [runningModels, setRunningModels] = useState<Record<string, { provider: string; model: string; runId?: string }>>({});

  useEffect(() => { void globalModelSelectionStore.load(); }, []);
  useEffect(() => subscribe((message) => {
    for (const event of [message, ...(message?.activeTurnMessages || [])]) {
      if (event?.type !== 'model-selection-changed' || !event.sessionId) continue;
      setRunningModels((previous) => ({
        ...previous,
        [event.sessionId]: { provider: event.modelProvider, model: event.model, runId: event.runId },
      }));
    }
  }), [subscribe]);

  const error = modelSelectionError(state);
  return {
    modelSelection: state.selection,
    modelCatalog: state.catalog,
    isModelCatalogLoading: state.loading && state.catalog.length === 0,
    isModelSelectionReady: !state.loading && !error && Boolean(state.selection),
    modelCatalogError: state.loading ? null : error,
    setModelSelection: globalModelSelectionStore.select,
    runningModels,
  };
}
