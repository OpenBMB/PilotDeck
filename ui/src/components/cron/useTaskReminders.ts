import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/context/AuthContext';
import { useWebSocket } from '../../contexts/WebSocketContext';
import { authenticatedFetch } from '../../utils/api';
import { useNotificationPreferences } from '../../hooks/useNotificationPreferences';
import { buildTaskReminderNotification, type ScheduledTaskReminder } from '../../../shared/notifications';
import { notificationWorkerMessage, showSystemNotification } from '../../lib/systemNotifications';

/** Delivery-only consumer: task reminders use the existing OS notification channel. */
export function useTaskReminders() {
  const { user } = useAuth();
  const account = String(user?.id ?? 'local');
  const { subscribe, isConnected } = useWebSocket();
  const { i18n } = useTranslation();
  const { preferences, status } = useNotificationPreferences();
  useEffect(() => {
    let active = true, request = 0;
    let scope: string | null = user?.id == null ? null : account;
    let delivered = new Set<string>(), dismissals = new Set<string>();
    const inFlight = new Map<string, Promise<void>>();
    const changes = new Map<string, ScheduledTaskReminder | null>();
    const key = () => `pilotdeck-task-system-notifications-v1:${scope}`;
    const read = () => {
      delivered = new Set(); dismissals = new Set();
      try { const saved = JSON.parse(localStorage.getItem(key()) || '{}'); delivered = new Set(saved.delivered || []); dismissals = new Set(saved.dismissals || []); } catch {}
    };
    const save = () => {
      try { localStorage.setItem(key(), JSON.stringify({ delivered: [...delivered], dismissals: [...dismissals] })); } catch {}
    };
    if (scope) read();
    const bind = (value: string) => {
      if (user?.id != null && value !== account) return false;
      if (scope !== value) { scope = value; read(); }
      return true;
    };
    const closeSystem = (id: string) => {
      if (!scope) return;
      void window.pilotdeckDesktop?.dismissSystemNotification?.({ scope, id }).catch(() => {});
      void notificationWorkerMessage('notification:task-dismiss', { scope, id });
    };
    const acknowledge = async (value: { scope: string; id: string }) => {
      if (!active || value.scope !== scope || !/^[a-f0-9]{64}$/.test(value.id)) return;
      delivered.add(value.id); dismissals.add(value.id); save();
      try {
        const response = await authenticatedFetch(`/api/always-on/cron-reminders/${value.id}/dismiss`, { method: 'POST', suppressServerErrorToast: true });
        if (!response.ok && response.status !== 404) throw new Error('Reminder acknowledgement failed');
        if (active) { dismissals.delete(value.id); changes.set(value.id, null); save(); closeSystem(value.id); }
      } catch (error) { console.warn('Scheduled reminder acknowledgement deferred:', error); }
    };
    const deliver = (reminder: ScheduledTaskReminder, recovery: boolean) => {
      if (!active || !scope || !preferences.enabled || (!window.pilotdeckDesktop && delivered.has(reminder.id)) || changes.get(reminder.id) === null) return Promise.resolve();
      if (inFlight.has(reminder.id)) return inFlight.get(reminder.id)!;
      const expectedScope = scope;
      const work = (async () => {
        try {
          await window.pilotdeckDesktop?.setNotificationScope?.(expectedScope);
          if (!active || scope !== expectedScope || changes.get(reminder.id) === null) return;
          const payload = buildTaskReminderNotification(reminder, preferences, i18n.language, expectedScope);
          if (recovery) payload.silent = true;
          const shown = await showSystemNotification(payload);
          if (!active || scope !== expectedScope) return;
          // Permission denial/failed delivery stays retryable. OS-accepted records
          // remain delivered even if the OS later times out or the user closes them.
          if (shown) { delivered.add(reminder.id); save(); }
          if (changes.get(reminder.id) === null) closeSystem(reminder.id);
        } catch (error) { console.warn('Scheduled notification delivery failed:', error); }
      })().finally(() => inFlight.delete(reminder.id));
      inFlight.set(reminder.id, work);
      return work;
    };
    const reload = async () => {
      const id = ++request;
      changes.clear();
      try {
        const response = await authenticatedFetch('/api/always-on/cron-reminders', { suppressServerErrorToast: true });
        if (!response.ok) throw new Error('Reminder synchronization failed');
        const snapshot = await response.json();
        if (!active || id !== request || typeof snapshot.scope !== 'string' || !bind(snapshot.scope)) return;
        for (const pending of [...dismissals]) await acknowledge({ scope: snapshot.scope, id: pending });
        const merged = new Map<string, ScheduledTaskReminder>((snapshot.reminders || []).map((item: ScheduledTaskReminder) => [item.id, item]));
        for (const [key, item] of changes) { if (item) merged.set(key, item); else merged.delete(key); }
        const identities = { scope: snapshot.scope, ids: [...merged.keys()] };
        await window.pilotdeckDesktop?.setNotificationScope?.(snapshot.scope);
        await window.pilotdeckDesktop?.reconcileSystemNotifications?.(identities);
        await notificationWorkerMessage('notification:task-reconcile', identities);
        // Recover only notifications this client never successfully handed to the OS.
        for (const item of merged.values()) await deliver(item, true);
      } catch (error) { if (active) console.warn('Scheduled reminders will retry on reconnect:', error); }
    };
    const receive = (message: any) => {
      if (!active) return;
      if (message?.type === 'session-activity-snapshot' && typeof message.scope === 'string') bind(message.scope);
      if (message?.type !== 'cron-reminder-changed' || message.scope !== scope || typeof message.id !== 'string') return;
      if (message.dismissedScope === scope) {
        changes.set(message.id, null); delivered.add(message.id); dismissals.delete(message.id); save(); closeSystem(message.id);
      } else if (message.reminder) { changes.set(message.id, message.reminder); void deliver(message.reminder, false); }
    };
    const unsubscribe = subscribe(receive);
    const worker = (event: MessageEvent) => {
      if (event.data?.type === 'notification:task-dismissed') void acknowledge(event.data);
      else receive(event.data);
    };
    const unsubscribeDismiss = window.pilotdeckDesktop?.onSystemNotificationDismiss?.(value => { void acknowledge(value); });
    const focused = () => { if (document.visibilityState === 'visible') void reload(); };
    navigator.serviceWorker?.addEventListener('message', worker);
    navigator.serviceWorker?.addEventListener('controllerchange', focused);
    window.addEventListener('focus', focused);
    if (isConnected) void reload();
    return () => {
      active = false; ++request; unsubscribe(); unsubscribeDismiss?.();
      navigator.serviceWorker?.removeEventListener('message', worker);
      navigator.serviceWorker?.removeEventListener('controllerchange', focused);
      window.removeEventListener('focus', focused);
    };
  }, [account, user?.id, subscribe, isConnected, preferences.enabled, preferences.sound, preferences.preview, status.permission, i18n.language]);
}
