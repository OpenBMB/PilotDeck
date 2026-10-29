import type { SystemNotification, NotificationPreferences } from '../../../ui/shared/notifications';

const defaults: NotificationPreferences = { enabled: true, sound: true, badge: true, preview: true };
export function nativeNotificationOptions(platform: string, payload: SystemNotification): import('electron').NotificationConstructorOptions {
  return {
    title: payload.title, body: payload.body, silent: payload.silent,
    // Use the OS application identity icon; custom icons can become a second image.
    ...(platform === 'linux' ? { urgency: 'normal' as const } : {}),
  };
}
export function normalizePreferences(value: unknown): NotificationPreferences {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, typeof record[key] === 'boolean' ? record[key] : fallback])) as NotificationPreferences;
}

export function validateNotification(value: unknown): SystemNotification {
  const item = value as SystemNotification;
  if (!item || typeof item.id !== 'string' || item.id.length > 512 ||
      typeof item.title !== 'string' || typeof item.body !== 'string' ||
      typeof item.data?.sessionId !== 'string' || !item.data.sessionId || item.data.sessionId.length > 512 ||
      typeof item.data?.scope !== 'string' ||
      (item.data.taskId !== undefined && (typeof item.data.taskId !== 'string' || !item.data.taskId || item.data.taskId.length > 512))) throw new Error('Invalid notification');
  return { id: item.id, title: item.title.slice(0, 80), body: item.body.slice(0, 400), silent: item.silent === true,
    data: { sessionId: item.data.sessionId, eventId: item.id, scope: item.data.scope, kind: item.data.kind,
      taskId: item.data.taskId, createdAt: item.data.createdAt } };
}

/** A small bitmap avoids an SVG renderer or a new native dependency on Windows. */
export function badgeBitmap(count: number): Buffer {
  const digits: Record<string, string[]> = {
    '0': ['111','101','101','101','111'], '1': ['010','110','010','010','111'],
    '2': ['111','001','111','100','111'], '3': ['111','001','111','001','111'],
    '4': ['101','101','111','001','001'], '5': ['111','100','111','001','111'],
    '6': ['111','100','111','101','111'], '7': ['111','001','010','010','010'],
    '8': ['111','101','111','101','111'], '9': ['111','101','111','001','111'],
    '+': ['000','010','111','010','000'],
  };
  const data = Buffer.alloc(32 * 32 * 4);
  const paint = (x: number, y: number, white = false) => {
    if (x < 0 || x >= 32 || y < 0 || y >= 32) return;
    const offset = (y * 32 + x) * 4;
    data.set(white ? [255,255,255,255] : [68,68,239,255], offset);
  };
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) if ((x - 15.5) ** 2 + (y - 15.5) ** 2 <= 15.5 ** 2) paint(x, y);
  const text = count > 99 ? '99+' : String(count);
  const scale = text.length === 1 ? 4 : 2;
  const width = (text.length * 4 - 1) * scale;
  [...text].forEach((digit, i) => digits[digit]?.forEach((row, y) => [...row].forEach((pixel, x) => {
    if (pixel === '1') for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) paint(Math.floor((32 - width) / 2) + (i * 4 + x) * scale + dx, Math.floor((32 - 5 * scale) / 2) + y * scale + dy, true);
  })));
  return data;
}

type NativeNotification = Pick<import('electron').Notification, 'on' | 'show' | 'close'>;
export function createDesktopNotifications(options: {
  platform: string; supported: () => boolean; read: () => unknown; save: (preferences: NotificationPreferences) => void;
  isForeground: () => boolean; now?: () => number;
  create: (payload: SystemNotification) => NativeNotification;
  setBadge: (count: number) => unknown; setOverlay: (bitmap: Buffer | null, label: string) => void;
  setTrayBadge?: (count: number) => void;
  navigate: (data: SystemNotification['data']) => Promise<void>; report: (error: unknown) => void;
}) {
  let preferences = normalizePreferences(options.read());
  const seen = new Set<string>();
  const reminded = new Set<string>();
  const active = new Map<string, NativeNotification>();
  // Ephemeral application awareness, independent of persistent conversation unread dots.
  const backgroundTasks = new Set<string>();
  const now = options.now || Date.now;
  let acknowledgedAt = now();
  let scope: string | null = null;
  let lastSound = 0;
  function refreshBadge() {
    const displayed = preferences.badge ? backgroundTasks.size : 0;
    options.setTrayBadge?.(displayed);
    // Windows uses native Toasts; clear the old hand-drawn taskbar overlay.
    if (options.platform === 'win32') options.setOverlay(null, '');
    else options.setBadge(displayed);
  }
  function foreground() {
    acknowledgedAt = now();
    backgroundTasks.clear();
    refreshBadge();
  }
  function current(payload: SystemNotification) {
    const createdAt = Date.parse(payload.data.createdAt || '');
    // A delayed event from before startup/focus must not restore an old badge.
    return payload.data.scope === scope && Number.isFinite(createdAt) && createdAt >= acknowledgedAt;
  }
  function record(payload: SystemNotification) {
    if (!current(payload)) return false;
    const key = JSON.stringify([scope, payload.data.sessionId, payload.id]);
    if (reminded.has(key)) return false;
    reminded.add(key);
    if (reminded.size > 4096) reminded.delete(reminded.values().next().value!);
    if (!options.isForeground() && Number.isFinite(Date.parse(payload.data.createdAt || ''))) {
      const task = JSON.stringify([scope, payload.data.sessionId, payload.data.taskId || payload.id]);
      if (backgroundTasks.size < 9999) backgroundTasks.add(task);
      refreshBadge();
    }
    return true;
  }
  return {
    foreground,
    record(value: unknown) { return record(validateNotification(value)); },
    setScope(value: unknown) {
      if (value !== null && (typeof value !== 'string' || !value || value.length > 512)) throw new Error('Invalid notification scope');
      if (value === scope) return;
      const changingAccount = scope !== null;
      scope = value as string | null;
      // First binding uses the process/focus baseline already established. An
      // event can arrive with that first binding and must not be lost to IPC latency.
      if (changingAccount || value === null) foreground();
      else refreshBadge();
      active.forEach(item => item.close());
      active.clear();
    },
    status: () => ({ supported: options.supported(), permission: 'unknown' as const, preferences }),
    preferences(value: unknown) {
      const next = normalizePreferences(value);
      options.save(next);
      preferences = next;
      refreshBadge();
      if (!preferences.enabled) { active.forEach(item => item.close()); active.clear(); }
      return preferences;
    },
    show(value: unknown) {
      const payload = validateNotification(value);
      if (!current(payload)) return false;
      record(payload);
      if (!preferences.preview) payload.body = payload.body.split('\n')[0];
      const key = JSON.stringify([payload.data.scope, payload.data.sessionId, payload.id]);
      if (seen.has(key)) return false;
      seen.add(key);
      if (seen.size > 4096) seen.delete(seen.values().next().value!);
      // Badge preference is independent of banners and OS notification support.
      if (!preferences.enabled || !options.supported()) return false;
      const timestamp = now();
      payload.silent = !preferences.sound || payload.silent || timestamp - lastSound < 2000;
      if (!payload.silent) lastSound = timestamp;
      const sessionKey = JSON.stringify([payload.data.scope, payload.data.sessionId]);
      active.get(sessionKey)?.close();
      const notification = options.create(payload);
      active.set(sessionKey, notification);
      notification.on('click', () => { notification.close(); void options.navigate(payload.data).catch(options.report); });
      notification.on('close', () => { if (active.get(sessionKey) === notification) active.delete(sessionKey); });
      notification.on('failed', (_event, error) => { options.report(error); });
      notification.show();
      return true;
    },
  };
}
