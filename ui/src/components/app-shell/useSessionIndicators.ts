import { createContext, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

export const SessionViewReadyContext = createContext<(sessionId: string | null) => void>(() => {});
// Keep desktop acknowledgement on the existing run record, in the same account
// scope. Watching a completion must not acknowledge the sidebar's unread dot.
type ReadRecord = {runId: string; unread: boolean; desktopSeen?: boolean};
type Activity = {sessionId: string; processing: boolean; runId?: string; completedRunId?: string};

export function createSessionIndicatorStore(storageKey: string, storage: Storage | undefined) {
  let records: Record<string, ReadRecord> = Object.create(null);
  let processing = new Set<string>();
  const listeners = new Set<() => void>();
  let snapshot = {processingSessions: processing, unreadSessionIds: new Set<string>(), desktopCompletionCount: 0};
  const publish = () => {
    const unreadSessionIds = new Set(Object.keys(records).filter(id => records[id].unread));
    snapshot = {processingSessions: new Set(processing), unreadSessionIds,
      desktopCompletionCount: [...unreadSessionIds].filter(id => records[id].desktopSeen !== true).length};
    listeners.forEach(listener => listener());
  };
  const persist = () => { try { storage?.setItem(storageKey, JSON.stringify(records)); } catch { /* Private mode/storage quota. */ } };
  const restore = () => {
    try {
      const value = JSON.parse(storage?.getItem(storageKey) || '{}');
      records = Object.assign(Object.create(null), Object.fromEntries(Object.entries(value).filter(([, record]) => record && typeof record === 'object' &&
        typeof (record as ReadRecord).runId === 'string' && typeof (record as ReadRecord).unread === 'boolean'))) as Record<string, ReadRecord>;
    } catch { records = Object.create(null); }
    publish();
  };
  restore();
  const receive = (message: any, watchedSessionId: string | null = null) => {
    const fullSnapshot = message?.type === 'session-activity-snapshot';
    const activities: Activity[] = fullSnapshot ? message.activities : message?.type === 'session-activity' ? [message.activity] : [];
    if (!Array.isArray(activities)) return;
    let changed = fullSnapshot && processing.size > 0;
    let recordsChanged = false;
    if (fullSnapshot) processing = new Set();
    for (const activity of activities) {
      if (!activity || typeof activity.sessionId !== 'string') continue;
      const id = activity.sessionId;
      if (Boolean(activity.processing) !== processing.has(id)) changed = true;
      if (activity.processing) processing.add(id); else processing.delete(id);
      const completed = activity.completedRunId;
      if (typeof completed === 'string' && records[id]?.runId !== completed) {
        // A reconnect snapshot can contain work finished while we were away.
        // Only a live completion actually watched in the foreground is exempt.
        records[id] = {runId: completed, unread: true,
          ...(!fullSnapshot && !activity.processing && id === watchedSessionId &&
            (!activity.runId || activity.runId === completed) ? {desktopSeen: true} : {})};
        recordsChanged = changed = true;
      }
    }
    if (recordsChanged) persist();
    if (changed) publish();
  };
  const markRead = (id: string | null, expectedRunId?: string) => {
    if (!id || !records[id]?.unread || (expectedRunId !== undefined && records[id].runId !== expectedRunId)) return;
    records[id] = {...records[id], unread: false};
    persist(); publish();
  };
  return {receive, markRead, restore, unreadRun: (id: string) => records[id]?.unread ? records[id].runId : undefined, getSnapshot: () => snapshot, subscribe: (listener: () => void) => {
    listeners.add(listener); return () => { listeners.delete(listener); };
  }};
}

export function useSessionIndicators({scope, viewedSessionId, subscribe, sendMessage, isConnected}: {
  scope: string;
  viewedSessionId: string | null;
  subscribe: (handler: (message: any) => void) => () => void;
  sendMessage: (message: any) => unknown;
  isConnected: boolean;
}) {
  const key = `pilotdeck-session-read-v1:${scope}`;
  const store = useMemo(() => {
    let storage: Storage | undefined;
    try { storage = window.localStorage; } catch { /* Unavailable storage must not break chat. */ }
    return createSessionIndicatorStore(key, storage);
  }, [key]);
  const viewRef = useRef(viewedSessionId);
  viewRef.current = viewedSessionId;
  const pendingView = useRef<{id: string; runId: string} | null>(null);
  const acknowledge = useCallback(() => {
    store.markRead(viewRef.current);
  }, [store]);
  // Only an explicit navigation can acknowledge a background reply after loading.
  // Capture its run now: a completion arriving after the click is a new reminder.
  const selectSession = useCallback((id: string | null) => {
    acknowledge();
    const runId = id ? store.unreadRun(id) : undefined;
    pendingView.current = id && runId ? {id, runId} : null;
  }, [store, acknowledge]);
  useEffect(() => subscribe(message => {
    const watching = window.pilotdeckDesktop?.setCompletionBadge &&
      document.visibilityState === 'visible' && document.hasFocus();
    store.receive(message, watching ? viewRef.current : null);
  }), [store, subscribe]);
  useEffect(() => {
    if (isConnected) sendMessage({type: 'get-session-activity'});
  }, [isConnected, sendMessage, store]);
  useEffect(() => {
    const pending = pendingView.current;
    if (pending && pending.id === viewedSessionId) {
      store.markRead(pending.id, pending.runId);
      pendingView.current = null;
    }
  }, [store, viewedSessionId]);
  useEffect(() => {
    pendingView.current = null;
    const restored = (event: StorageEvent) => { if (event.key === key) store.restore(); };
    window.addEventListener('storage', restored);
    return () => window.removeEventListener('storage', restored);
  }, [store, key]);
  useEffect(() => {
    const bridge = window.pilotdeckDesktop;
    if (!bridge?.setCompletionBadge) return;
    const send = (count: number) => {
      void bridge.setCompletionBadge!(count).catch(error => console.warn('Could not sync completion badge', error));
    };
    let lastCount = -1;
    const sync = () => {
      const count = store.getSnapshot().desktopCompletionCount;
      if (count !== lastCount) { lastCount = count; send(count); }
    };
    sync();
    const stop = store.subscribe(sync);
    return () => { stop(); send(0); };
  }, [store]);
  return {...useSyncExternalStore(store.subscribe, store.getSnapshot), markRead: store.markRead, acknowledge, selectSession};
}
