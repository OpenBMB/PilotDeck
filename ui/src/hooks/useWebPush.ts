import { authenticatedFetch } from '../utils/api';
import type { NotificationPreferences } from '../../shared/notifications';

/** Live notifications remain available when the browser push service is unavailable. */
export async function syncWebPush(preferences: NotificationPreferences, language: string) {
  if (window.pilotdeckDesktop || !('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration || !('pushManager' in registration)) return;
  let subscription = await registration.pushManager.getSubscription();
  if (!preferences.enabled) {
    if (subscription) {
      try {
        const response = await authenticatedFetch('/api/settings/push/unsubscribe', {
          method: 'POST', body: JSON.stringify({ endpoint: subscription.endpoint }), suppressServerErrorToast: true,
        });
        if (!response.ok) throw new Error('Could not disable background notifications');
      } finally { await subscription.unsubscribe(); }
    }
    return;
  }
  if (Notification.permission !== 'granted') return;
  if (!subscription) {
    const response = await authenticatedFetch('/api/settings/push/vapid-public-key', { suppressServerErrorToast: true });
    if (!response.ok) throw new Error('Could not register background notifications');
    const { publicKey } = await response.json();
    const base64 = publicKey.replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(base64 + '='.repeat((4 - base64.length % 4) % 4)), c => c.charCodeAt(0));
    subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
  }
  const json = subscription.toJSON();
  const response = await authenticatedFetch('/api/settings/push/subscribe', {
    method: 'POST', suppressServerErrorToast: true, body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, preferences,
      language: language.startsWith('zh') ? 'zh-CN' : 'en' }),
  });
  if (!response.ok) throw new Error('Could not save background notification settings');
}
