import { authenticatedFetch } from '../../../utils/api';
import { modelSelectionId, normalizeModelSelection, parseCatalogItem } from '../../chat-v2/modelCapabilityOptions';
import type { ChatModelCatalogItem, ChatModelSelection } from '../hooks/useChatProviderState';
import { safeLocalStorage } from './chatStorage';

export const GLOBAL_MODEL_SELECTION_KEY = 'composer-model-global';

type State = {
  selection: ChatModelSelection | null;
  catalog: ChatModelCatalogItem[];
  loading: boolean;
  error: string | null;
};

function readPreference(): ChatModelSelection | null {
  try { return normalizeModelSelection(JSON.parse(safeLocalStorage.getItem(GLOBAL_MODEL_SELECTION_KEY) || 'null')); }
  catch { return null; }
}

/** One browser preference and one catalog, independent of projects and sessions. */
export function createGlobalModelSelectionStore() {
  let preference = readPreference();
  let defaultSelection: ChatModelSelection | null = null;
  let state: State = { selection: preference, catalog: [], loading: true, error: null };
  let loaded = false;
  let request: Promise<void> | null = null;
  let reloadRequested = false;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<State>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const syncPreference = () => {
    preference = readPreference();
    publish({ selection: preference || defaultSelection });
  };
  const onStorage = (event: StorageEvent) => {
    if ((event.key === GLOBAL_MODEL_SELECTION_KEY || event.key === null) && event.storageArea === localStorage) syncPreference();
  };

  const load = (refresh = false): Promise<void> => {
    if (request) {
      if (refresh) reloadRequested = true;
      return request;
    }
    if (loaded && !refresh) return Promise.resolve();
    publish({ loading: true, error: null });
    request = (async () => {
      // Config changes arriving during a read must not leave an older catalog cached.
      do {
        reloadRequested = false;
        try {
          const response = await authenticatedFetch('/api/models?includeAuto=true');
          const data = await response.json();
          if (!response.ok) throw new Error(data?.error?.message || 'Failed to load models.');
          if (reloadRequested) continue;
          defaultSelection = normalizeModelSelection(data.defaultSelection);
          const catalog: ChatModelCatalogItem[] = (Array.isArray(data.items) ? data.items : [])
            .map(parseCatalogItem).filter((item: ChatModelCatalogItem | null): item is ChatModelCatalogItem => Boolean(item));
          loaded = true;
          publish({ catalog, selection: preference || defaultSelection, loading: false, error: null });
        } catch (error) {
          if (reloadRequested) continue;
          loaded = false;
          publish({ loading: false, error: error instanceof Error ? error.message : String(error) });
        }
      } while (reloadRequested);
    })().finally(() => { request = null; });
    return request;
  };

  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      if (listeners.size === 0) {
        // A different tab may have changed the preference while no composer was mounted.
        syncPreference();
        window.addEventListener('storage', onStorage);
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) window.removeEventListener('storage', onStorage);
      };
    },
    load,
    invalidate() {
      loaded = false;
      if (listeners.size > 0) void load(true);
      else {
        publish({ loading: true });
        if (request) reloadRequested = true;
      }
    },
    async select(value: ChatModelSelection) {
      preference = { ...value };
      safeLocalStorage.setItem(GLOBAL_MODEL_SELECTION_KEY, JSON.stringify(preference));
      publish({ selection: preference });
    },
  };
}

export const globalModelSelectionStore = createGlobalModelSelectionStore();

export function modelSelectionError(state: State) {
  if (state.error) return state.error;
  if (!state.selection) return 'No default model is configured. Choose a model.';
  if (!state.catalog.some((item) => item.id === modelSelectionId(state.selection) && item.available)) {
    return `Selected model is unavailable: ${modelSelectionId(state.selection)}. Choose another model.`;
  }
  return null;
}
