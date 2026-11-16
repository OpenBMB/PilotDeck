import { createHash } from 'node:crypto';
import type { SystemNotification, NotificationPreferences } from '../../../ui/shared/notifications';

const defaults: NotificationPreferences = { enabled: true, sound: true, badge: true, preview: true };
export function nativeNotificationOptions(platform: string, payload: SystemNotification): import('electron').NotificationConstructorOptions {
  const reminder = payload.data?.kind === 'reminder';
  return {
    ...(reminder ? { id: reminderNativeId(payload.data) } : {}),
    ...(reminder && platform === 'win32' ? { toastXml: reminderToastXml(payload) } : {}),
    ...(reminder && platform === 'darwin' ? { closeButtonText: /[\u4e00-\u9fff]/.test(payload.body) ? '关闭' : 'Dismiss' } : {}),
    ...(reminder && (platform === 'win32' || platform === 'linux') ? { timeoutType: 'never' as const } : {}),
    title: payload.title, body: payload.body, silent: payload.silent,
    // Use the OS application identity icon; custom icons can become a second image.
    ...(platform === 'linux' ? { urgency: 'normal' as const } : {}),
  };
}
function reminderToastXml(payload: SystemNotification): string {
  const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[character]!));
  const launch = `pdReminder=${reminderNativeId(payload.data)}`;
  const label = /[\u4e00-\u9fff]/.test(payload.body) ? '查看任务' : 'View task';
  return `<toast scenario="reminder" duration="long" launch="${launch}"><visual><binding template="ToastGeneric"><text>${escape(payload.title)}</text><text>${escape(payload.body)}</text></binding></visual><actions><action content="${label}" arguments="${launch}" activationType="foreground"/></actions><audio silent="${payload.silent ? 'true' : 'false'}"/></toast>`;
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
  if (item.data.kind === 'reminder' && (item.data.reminderId !== item.id || !/^[a-f0-9]{64}$/.test(item.id) || !item.data.taskId)) throw new Error('Invalid task reminder');
  return { id: item.id, title: item.title.slice(0, 80), body: item.body.slice(0, 400), silent: item.silent === true,
    ...(item.persistent === true ? { persistent: true } : {}),
    data: { sessionId: item.data.sessionId, eventId: item.id, scope: item.data.scope, kind: item.data.kind,
      taskId: item.data.taskId, createdAt: item.data.createdAt,
      ...(typeof item.data.reminderId === 'string' ? { reminderId: item.data.reminderId } : {}) } };
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

type NativeNotification = Pick<import('electron').Notification, 'on' | 'show' | 'close'> & { id?: string };
type ReminderData = SystemNotification['data'];
type ReminderReceipt = { id: string; data: ReminderData; dismissed?: boolean };
function reminderNativeId(data: ReminderData): string {
  return createHash('sha256').update(JSON.stringify([data.scope, data.reminderId])).digest('hex').slice(0, 32);
}
export function createDesktopNotifications(options: {
  platform: string; supported: () => boolean; read: () => unknown; save: (preferences: NotificationPreferences) => void;
  isForeground: () => boolean; now?: () => number;
  create: (payload: SystemNotification) => NativeNotification;
  setBadge: (count: number) => unknown; setOverlay: (bitmap: Buffer | null, label: string) => void;
  setTrayBadge?: (count: number) => void;
  reminderReceipts?: { read: () => unknown; write: (receipts: ReminderReceipt[]) => void };
  dismissReminder?: (data: { scope: string; id: string }) => void;
  restore?: () => Promise<NativeNotification[]>;
  showTimeoutMs?: number;
  globalReminderActivation?: boolean;
  removeReminder?: (id: string) => void;
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
  // Scheduled notifications use the same OS transport, but not chat read/focus expiry.
  const receipts = new Map<string, ReminderData>();
  const dismissed = new Set<string>();
  const present = new Set<string>();
  let history: NativeNotification[] | null = null;
  let historyRequest: Promise<void> | null = null;
  try {
    const saved = options.reminderReceipts?.read();
    if (Array.isArray(saved)) for (const item of saved) {
      if (item?.data?.kind === 'reminder' && typeof item.data.scope === 'string' && typeof item.data.taskId === 'string'
        && /^[a-f0-9]{64}$/.test(item.data.reminderId) && item.id === reminderNativeId(item.data)) { receipts.set(item.id, item.data); if (item.dismissed) dismissed.add(item.id); if (options.platform !== 'darwin' || !options.restore) present.add(item.id); }
    }
  } catch (error) { options.report(error); }
  const scheduled = new Map<string, { notification: NativeNotification; programmatic: boolean; clicked: boolean }>();
  let pendingActivation: string | null = null;
  const delivering = new Map<string, Promise<boolean>>();
  const persistReceipts = () => {
    try { options.reminderReceipts?.write([...receipts].map(([id, data]) => ({ id, data, ...(dismissed.has(id) ? { dismissed: true } : {}) }))); }
    catch (error) { options.report(error); }
  };
  function attachReminder(notification: NativeNotification, data: ReminderData) {
    const key = reminderNativeId(data);
    const entry = { notification, programmatic: false, clicked: false };
    scheduled.set(key, entry);
    notification.on('click', () => { entry.clicked = true; if (!options.globalReminderActivation && data.scope === scope) void options.navigate(data).catch(options.report); });
    notification.on('close', details => {
      if (scheduled.get(key) === entry) scheduled.delete(key);
      // Windows reports timeouts/programmatic hides too; Linux close reasons are not exposed.
      const explicit = details?.reason === 'userCanceled' || (options.platform === 'darwin' && !details?.reason);
      if (explicit && !entry.programmatic && !entry.clicked && data.scope === scope) {
        receipts.set(key, data); dismissed.add(key); persistReceipts();
        options.dismissReminder?.({ scope: data.scope, id: data.reminderId! });
      }
    });
    return entry;
  }
  function closeReminders() {
    for (const [id, entry] of scheduled) { entry.programmatic = true; entry.notification.close(); options.removeReminder?.(id); }
    scheduled.clear();
  }
  function showReminder(payload: SystemNotification): Promise<boolean> {
    if (payload.data.scope !== scope || !preferences.enabled || !options.supported()) return Promise.resolve(false);
    const key = reminderNativeId(payload.data);
    if (dismissed.has(key) || present.has(key)) return Promise.resolve(true);
    if (delivering.has(key)) return delivering.get(key)!;
    if (!preferences.preview) payload.body = payload.body.split('\n')[0];
    payload.silent = !preferences.sound || payload.silent || now() - lastSound < 2000;
    const work = Promise.resolve().then(() => new Promise<boolean>(resolve => {
      let settled = false, failed = false;
      const complete = (shown: boolean) => {
        if (shown && !failed) {
          receipts.set(key, payload.data); present.add(key); persistReceipts();
        }
        if (settled) return;
        settled = true; clearTimeout(timer);
        resolve(shown);
      };
      const timer = setTimeout(() => complete(false), options.showTimeoutMs ?? 8000);
      try {
        if (!payload.silent) lastSound = now();
        const notification = options.create(payload);
        const entry = attachReminder(notification, payload.data);
        notification.on('show', () => complete(true));
        notification.on('failed', (_event, error) => { failed = true; if (scheduled.get(key) === entry) scheduled.delete(key); options.report(error); complete(false); });
        notification.show();
        if (!preferences.enabled || payload.data.scope !== scope) { entry.programmatic = true; notification.close(); complete(false); }
      } catch (error) { failed = true; options.report(error); complete(false); }
    })).finally(() => delivering.delete(key));
    delivering.set(key, work);
    return work;
  }
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
      closeReminders();
      if (pendingActivation) {
        const id = pendingActivation; pendingActivation = null;
        const data = receipts.get(id);
        if (data?.scope === scope) void options.navigate(data).catch(options.report);
      }
    },
    activateReminder(argumentsString: string) {
      const match = /^pdReminder=([a-f0-9]{32})$/.exec(argumentsString);
      const data = match ? receipts.get(match[1]) : undefined;
      if (!data) return false;
      if (scope === null) { pendingActivation = match![1]; return true; }
      if (data.scope !== scope) return false;
      const entry = scheduled.get(match![1]); if (entry) entry.clicked = true;
      void options.navigate(data).catch(options.report);
      return true;
    },
    async restoreReminders() {
      if (!options.restore || !receipts.size || !preferences.enabled) return;
      // Electron getHistory materializes native observers. Read once at startup,
      // before ordinary live notifications exist; never query it for each delivery.
      if (!historyRequest) historyRequest = options.restore().then(items => {
        history = items;
        for (const item of items) if (item.id && receipts.has(item.id)) present.add(item.id);
      });
      await historyRequest;
      for (const notification of history || []) {
        const data = notification.id ? receipts.get(notification.id) : undefined;
        if (data?.scope === scope && !dismissed.has(notification.id!) && !scheduled.has(notification.id!)) attachReminder(notification, data);
      }
    },
    reconcileReminders(value: { scope: string; ids: string[] }) {
      if (!value || value.scope !== scope || !Array.isArray(value.ids) || !value.ids.every(id => /^[a-f0-9]{64}$/.test(id))) return;
      const pending = new Set(value.ids);
      for (const [key, data] of receipts) {
        if (data.scope !== scope || pending.has(data.reminderId!)) continue;
        dismissed.add(key);
        const entry = scheduled.get(key);
        if (entry) { entry.programmatic = true; entry.notification.close(); }
        options.removeReminder?.(key);
      }
      persistReceipts();
    },
    dismissReminder(value: { scope: string; id: string }) {
      if (!value || value.scope !== scope || !/^[a-f0-9]{64}$/.test(value.id)) return;
      const key = reminderNativeId({ scope: value.scope, reminderId: value.id } as ReminderData);
      if (receipts.has(key)) { dismissed.add(key); persistReceipts(); }
      const entry = scheduled.get(key);
      if (entry) { entry.programmatic = true; entry.notification.close(); }
      options.removeReminder?.(key);
    },
    status: () => ({ supported: options.supported(), permission: 'unknown' as const, preferences }),
    preferences(value: unknown) {
      const next = normalizePreferences(value);
      options.save(next);
      preferences = next;
      refreshBadge();
      if (!preferences.enabled) { active.forEach(item => item.close()); active.clear(); closeReminders(); }
      return preferences;
    },
    show(value: unknown) {
      const payload = validateNotification(value);
      if (payload.data.kind === 'reminder') return showReminder(payload);
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
