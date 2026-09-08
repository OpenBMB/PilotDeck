import { useEffect, useSyncExternalStore } from 'react';
import { globalModelSelectionStore, modelSelectionError } from '../utils/globalModelSelection';

/** Only manual choices change the global preference. */
export function useChatModelSelection() {
  const state = useSyncExternalStore(globalModelSelectionStore.subscribe, globalModelSelectionStore.getSnapshot);
  useEffect(() => { void globalModelSelectionStore.load(); }, []);
  const error = modelSelectionError(state);
  return {
    modelSelection: state.selection,
    modelCatalog: state.catalog,
    isModelCatalogLoading: state.loading && state.catalog.length === 0,
    isModelSelectionReady: !state.loading && !error && Boolean(state.selection),
    modelCatalogError: state.loading ? null : error,
    setModelSelection: globalModelSelectionStore.select,
  };
}
