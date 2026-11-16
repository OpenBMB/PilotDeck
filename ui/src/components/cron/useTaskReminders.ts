import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/context/AuthContext';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { authenticatedFetch } from '../../utils/api';
import { useNotificationPreferences, getNotificationPreferences } from '../../hooks/useNotificationPreferences';
import { buildTaskReminderNotification, type ScheduledTaskReminder } from '../../../shared/notifications';
import { notificationWorkerMessage, showSystemNotification } from '../../lib/systemNotifications';

/** Durable reminders deliberately never enter the session unread/notification hook. */
export function useTaskReminders() {
  const { user } = useAuth();
  const scope = String(user?.id ?? 'local');
  const [deliveryScope, setDeliveryScope] = useState(scope);
  const serverScope = useRef<string | null>(user?.id == null ? null : scope);
  const { subscribe, isConnected } = useWebSocket();
  const { i18n } = useTranslation();
  const { preferences } = useNotificationPreferences();
  const [boundScope, setBoundScope] = useState(scope);
  const [reminders, setReminders] = useState<ScheduledTaskReminder[]>([]);
  const [error, setError] = useState(false);
  const [closing, setClosing] = useState<Set<string>>(new Set());
  const changes = useRef(new Map<string, ScheduledTaskReminder | null>());
  const requestId = useRef(0);
  const language = useRef(i18n.language); language.current = i18n.language;
  const sounded = useRef(new Set<string>());
  const [soundId, setSoundId] = useState<string | undefined>();
  const [nativePresented, setNativePresented] = useState(false);
  const currentScope = useRef(scope); currentScope.current = scope;
  const upsert = useCallback((id: string, reminder: ScheduledTaskReminder | null) => {
    changes.current.set(id, reminder);
    setReminders(items => [...items.filter(item => item.id !== id), ...(reminder ? [reminder] : [])]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }, []);

  const bindDeliveryScope = useCallback((value: string) => {
    if (serverScope.current !== value) {
      serverScope.current = value; setDeliveryScope(value);
      try { sounded.current = new Set(JSON.parse(localStorage.getItem(`pilotdeck-task-reminders-notified:${value}`) || '[]')); } catch { sounded.current.clear(); }
    }
  }, []);

  const reload = useCallback(async () => {
    const id = ++requestId.current;
    changes.current.clear();
    try {
      const response = await authenticatedFetch('/api/always-on/cron-reminders', { suppressServerErrorToast: true });
      if (!response.ok) throw new Error('Reminder synchronization failed');
      const snapshot = await response.json();
      if (id !== requestId.current || currentScope.current !== scope) return;
      if (typeof snapshot.scope !== 'string' || (user?.id != null && snapshot.scope !== scope)) throw new Error('Invalid reminder scope');
      bindDeliveryScope(snapshot.scope);
      const merged = new Map<string, ScheduledTaskReminder>((snapshot.reminders || []).map((item: ScheduledTaskReminder) => [item.id, item]));
      for (const [key, item] of changes.current) { if (item) merged.set(key, item); else merged.delete(key); }
      setReminders([...merged.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      setError(false);
    } catch { if (id === requestId.current) setError(true); }
  }, [scope, user?.id, bindDeliveryScope]);

  useEffect(() => {
    serverScope.current = user?.id == null ? null : scope; setDeliveryScope(scope);
    setBoundScope(scope); setNativePresented(false); setReminders([]); setError(false); changes.current.clear(); sounded.current.clear(); setSoundId(undefined);
    try { sounded.current = new Set(JSON.parse(localStorage.getItem(`pilotdeck-task-reminders-notified:${scope}`) || '[]')); } catch {}
    const receive = (message: any) => {
      if (message?.type === 'session-activity-snapshot' && typeof message.scope === 'string' && user?.id == null) bindDeliveryScope(message.scope);
      const effectiveScope = serverScope.current;
      if (message?.type !== 'cron-reminder-changed' || !effectiveScope || message.scope !== effectiveScope || typeof message.id !== 'string') return;
      if (message.dismissedScope === effectiveScope) { upsert(message.id, null); void notificationWorkerMessage('notification:task-dismiss', { scope: effectiveScope, id: message.id }); return; }
      if (!message.reminder) return;
      upsert(message.id, message.reminder);
      if (sounded.current.has(message.id)) return;
      sounded.current.add(message.id);
      try { localStorage.setItem(`pilotdeck-task-reminders-notified:${effectiveScope}`, JSON.stringify([...sounded.current].slice(-4096))); } catch {}
      setSoundId(message.id);
      const prefs = getNotificationPreferences();
      if (!window.pilotdeckDesktop && prefs.enabled) {
        void showSystemNotification(buildTaskReminderNotification(message.reminder, prefs, language.current, effectiveScope)).catch(() => {});
      }
    };
    const unsubscribe = subscribe(receive);
    const worker = (event: MessageEvent) => receive(event.data);
    navigator.serviceWorker?.addEventListener('message', worker);
    return () => { ++requestId.current; unsubscribe(); navigator.serviceWorker?.removeEventListener('message', worker); };
  }, [scope, user?.id, subscribe, upsert, bindDeliveryScope]);

  useEffect(() => { if (isConnected) void reload(); }, [isConnected, reload]);

  const dismiss = useCallback(async (id: string) => {
    const requestedScope = scope;
    setClosing(current => new Set(current).add(id));
    try {
      const response = await authenticatedFetch(`/api/always-on/cron-reminders/${encodeURIComponent(id)}/dismiss`, {
        method: 'POST', suppressServerErrorToast: true,
      });
      if (!response.ok) throw new Error('Reminder dismissal failed');
      if (currentScope.current !== requestedScope) return;
      upsert(id, null); setError(false);
      void notificationWorkerMessage('notification:task-dismiss', { scope: serverScope.current || scope, id });
    } catch { if (currentScope.current === requestedScope) setError(true); }
    finally { setClosing(current => { const next = new Set(current); next.delete(id); return next; }); }
  }, [scope, upsert]);

  useEffect(() => window.pilotdeckDesktop?.onTaskReminderDismiss?.(id => { void dismiss(id); }), [dismiss]);
  useEffect(() => {
    const desktop = window.pilotdeckDesktop;
    if (!desktop?.setTaskReminders) { setNativePresented(false); return; }
    let active = true;
    void desktop.setTaskReminders({ scope: deliveryScope, language: i18n.language,
      reminders: preferences.enabled && boundScope === scope ? reminders.map(item => buildTaskReminderNotification(item, preferences, i18n.language, deliveryScope)) : [],
      soundId: preferences.sound ? soundId : undefined,
      error: error ? i18n.language.startsWith('zh') ? '提醒暂时无法同步或关闭，请重试。' : 'Reminders could not sync or close. Please retry.' : undefined,
    }).then(() => { if (active) setNativePresented(preferences.enabled); }).catch(() => { if (active) setNativePresented(false); });
    return () => { active = false; };
  }, [scope, deliveryScope, boundScope, reminders, preferences, i18n.language, soundId, error]);
  return { reminders: boundScope === scope ? reminders : [], closing, preview: preferences.preview, error: boundScope === scope && error, reload, dismiss, nativePresented };
}
