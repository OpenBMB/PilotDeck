import { authenticatedFetch } from '../../../utils/api';
import { modelSelectionId, normalizeModelSelection, parseCatalogItem } from './modelCapabilityOptions';
import type { ChatModelCatalogItem, ChatModelSelection } from '../hooks/useChatProviderState';
import { safeLocalStorage } from './chatStorage';

export const GLOBAL_MODEL_SELECTION_KEY = 'composer-model-last-sent';
const SESSION_PREFIX = 'composer-model-session-sent:';
export const sessionModelSelectionKey = (projectKey: string, sessionId: string) => SESSION_PREFIX + JSON.stringify([projectKey, sessionId]);
export function readSessionModelSelection(projectKey: string, sessionId: string): ChatModelSelection | null {
  try { return normalizeModelSelection(JSON.parse(safeLocalStorage.getItem(sessionModelSelectionKey(projectKey, sessionId)) || 'null')); }
  catch { return null; }
}

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

/** Shared catalog and last accepted submission; clicks are local composer state. */
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
    if ((event.key === GLOBAL_MODEL_SELECTION_KEY || event.key?.startsWith(SESSION_PREFIX) || event.key === null) && event.storageArea === localStorage) syncPreference();
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

  let submissionOrder = 0;
  let lastGlobalOrder = 0;
  const sessionOrders = new Map<string, number>();
  const sessionRevisions = new Map<string, number>();
  const invalidateSession = (sessionId: string) => {
    sessionRevisions.set(sessionId, (sessionRevisions.get(sessionId) ?? 0) + 1);
    publish({});
  };
  type Pending = { projectKey: string; sessionId?: string; selection: ChatModelSelection; order: number; expires: number };
  const pending = new Map<string, Pending>();
  const accept = (entry: Pending, sessionId: string) => {
    const key = sessionModelSelectionKey(entry.projectKey, sessionId);
    if (entry.order > (sessionOrders.get(key) ?? 0)) {
      safeLocalStorage.setItem(key, JSON.stringify(entry.selection));
      sessionOrders.set(key, entry.order);
    }
    if (entry.order > lastGlobalOrder) {
      lastGlobalOrder = entry.order;
      preference = { ...entry.selection };
      safeLocalStorage.setItem(GLOBAL_MODEL_SELECTION_KEY, JSON.stringify(preference));
    }
    publish({ selection: preference || defaultSelection });
  };

  return {
    getSnapshot: () => state,
    getSessionRevision: (sessionId: string) => sessionRevisions.get(sessionId) ?? 0,
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
    trackMessage(message: any) {
      for (const [key, entry] of pending) if (entry.expires < Date.now()) pending.delete(key);
      const queued = message?.type === 'queue-input';
      if (!queued && message?.type !== 'pilotdeck-command' && message?.type !== 'regenerate-last-message') return;
      const options = queued ? message.item?.options : message.options;
      const selection = normalizeModelSelection(options?.modelSelection);
      const id = queued ? message.requestId : options?.runId;
      const projectKey = options?.projectPath || options?.cwd;
      if (!selection || typeof id !== 'string' || typeof projectKey !== 'string' || !projectKey) return;
      pending.set(`${queued ? 'queue' : 'run'}:${id}`, {
        projectKey, sessionId: queued ? message.sessionId : options?.sessionId,
        selection: { ...selection }, order: ++submissionOrder, expires: Date.now() + 300_000,
      });
      if (pending.size > 512) pending.delete(pending.keys().next().value!);
    },
    receiveMessage(message: any) {
      const queued = message?.type === 'input-queue-operation-result';
      if (!queued && message?.type !== 'model-selection-saved') return;
      const key = `${queued ? 'queue' : 'run'}:${queued ? message.requestId : message.runId}`;
      const entry = pending.get(key);
      // Another client's accepted send invalidates history, but must not change
      // this client's global last-send preference or an unsent composer draft.
      if (!entry) {
        if (!queued && typeof message.sessionId === 'string' && message.sessionId) invalidateSession(message.sessionId);
        return;
      }
      if (entry.sessionId && entry.sessionId !== message.sessionId) return;
      pending.delete(key);
      if (entry.expires < Date.now() || (queued && message.ok !== true) || typeof message.sessionId !== 'string' || !message.sessionId) return;
      accept(entry, message.sessionId);
      invalidateSession(message.sessionId);
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
