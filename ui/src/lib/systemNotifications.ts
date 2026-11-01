import type { SystemNotification } from '../../shared/notifications';

export async function notificationWorkerMessage(type: string, value: unknown) {
  if (window.pilotdeckDesktop || !('serviceWorker' in navigator)) return undefined;
  let registration;
  try { registration = await navigator.serviceWorker.getRegistration(); } catch { return undefined; }
  const worker = registration?.active;
  if (!worker) return undefined;
  return new Promise<any>(resolve => {
    const channel = new MessageChannel();
    const timer = window.setTimeout(() => { channel.port1.close(); resolve(undefined); }, 1500);
    channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data); };
    try { worker.postMessage({ type, value }, [channel.port2]); }
    catch { clearTimeout(timer); channel.port1.close(); resolve(undefined); }
  });
}

export async function showSystemNotification(payload: SystemNotification) {
  if (window.pilotdeckDesktop?.showNotification) return window.pilotdeckDesktop.showNotification(payload);
  if (!('Notification' in window) || Notification.permission !== 'granted') return false;
  const handled = await notificationWorkerMessage('notification:show', payload);
  if (handled !== undefined) return handled;
  const notification = new Notification(payload.title, { body: payload.body, silent: payload.silent,
    tag: `${payload.data.scope}:${payload.data.sessionId}`, data: payload.data });
  notification.onclick = () => {
    notification.close(); window.focus();
    window.dispatchEvent(new CustomEvent('pilotdeck:notification-navigate', { detail: payload.data }));
  };
  return true;
}

/** Web/PWA has no global counter. Clear badges left by an older deployment. */
export async function clearWebNotificationBadge() {
  if (window.pilotdeckDesktop) return;
  document.title = 'PilotDeck';
  const badge = navigator as Navigator & { clearAppBadge?: () => Promise<void> };
  await badge.clearAppBadge?.();
}
