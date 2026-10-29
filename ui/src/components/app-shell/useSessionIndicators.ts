import { createContext, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useSystemNotifications } from '../../hooks/useSystemNotifications';

export const SessionViewReadyContext = createContext<(sessionId: string | null) => void>(() => {});
type ReadRecord = {runId: string; unread: boolean; attentionAt?: string};
type WaitingFor = 'question' | 'approval';
type Activity = {sessionId: string; processing?: boolean; waitingFor?: WaitingFor | null; completedRunId?: string; attentionId?: string; attentionAt?: string};

export function createSessionIndicatorStore(storageKey: string, storage: Storage | undefined) {
  let records: Record<string, ReadRecord> = Object.create(null);
  let processing = new Set<string>();
  let waiting = new Map<string, WaitingFor>();
  const listeners = new Set<() => void>();
  let snapshot = {processingSessions: processing, waitingSessions: waiting, unreadSessionIds: new Set<string>()};
  const publish = () => {
    snapshot = {processingSessions: new Set(processing), waitingSessions: new Map(waiting), unreadSessionIds: new Set(Object.keys(records).filter(id => records[id].unread))};
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
  const receive = (message: any) => {
    if (message?.type === 'session-deleted' && typeof message.sessionId === 'string') {
      const id = message.sessionId;
      if (records[id]) records[id] = { ...records[id], unread: false };
      processing.delete(id);
      waiting.delete(id);
      persist(); publish();
      return;
    }
    const fullSnapshot = message?.type === 'session-activity-snapshot';
    const activities: Activity[] = fullSnapshot ? message.activities : ['session-activity', 'session-attention'].includes(message?.type) ? [message.activity] : [];
    if (!Array.isArray(activities)) return;
    let changed = fullSnapshot && (processing.size > 0 || waiting.size > 0);
    let recordsChanged = false;
    if (fullSnapshot) { processing = new Set(); waiting = new Map(); }
    for (const activity of activities) {
      if (!activity || typeof activity.sessionId !== 'string') continue;
      const id = activity.sessionId;
      if (activity.waitingFor !== undefined || activity.processing === false) {
        const next = activity.processing === false ? undefined : activity.waitingFor || undefined;
        if (waiting.get(id) !== next) changed = true;
        if (next) waiting.set(id, next); else waiting.delete(id);
      }
      if (typeof activity.processing === 'boolean') {
        if (activity.processing !== processing.has(id)) changed = true;
        if (activity.processing) processing.add(id); else processing.delete(id);
      }
      const completed = activity.attentionId || activity.completedRunId;
      if (typeof completed === 'string' && records[id]?.runId !== completed) {
        const previousTime = Date.parse(records[id]?.attentionAt || '');
        const nextTime = Date.parse(activity.attentionAt || '');
        if (Number.isFinite(previousTime) && (!Number.isFinite(nextTime) || nextTime <= previousTime)) continue;
        records[id] = {runId: completed, unread: true, attentionAt: activity.attentionAt};
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
  return {receive, markRead, restore, readRecords: () => records, unreadRun: (id: string) => records[id]?.unread ? records[id].runId : undefined, getSnapshot: () => snapshot, subscribe: (listener: () => void) => {
    listeners.add(listener); return () => { listeners.delete(listener); };
  }};
}

export function useSessionIndicators({scope, viewedSessionId, subscribe, sendMessage, isConnected, sessionNames}: {
  scope: string;
  viewedSessionId: string | null;
  subscribe: (handler: (message: any) => void) => () => void;
  sendMessage: (message: any) => unknown;
  isConnected: boolean;
  sessionNames?: Record<string, string>;
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
  useSystemNotifications({ store, viewedSessionId, scope, subscribe, isConnected, sessionNames });
  return {...useSyncExternalStore(store.subscribe, store.getSnapshot), markRead: store.markRead, acknowledge, selectSession};
}
