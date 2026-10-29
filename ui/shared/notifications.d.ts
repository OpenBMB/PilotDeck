export type NotificationPreferences = { enabled: boolean; sound: boolean; badge: boolean; preview: boolean };
export type SessionNotification = {
  id: string; sessionId: string; scope: string; kind: 'completed' | 'approval' | 'question' | 'error' | 'disconnected';
  sessionName?: string; preview?: string; createdAt: string; taskId?: string;
};
export type SystemNotification = {
  id: string; title: string; body: string; silent: boolean;
  data: { sessionId: string; eventId: string; scope: string; kind: SessionNotification['kind']; createdAt?: string; taskId?: string };
};
export type DesktopNotificationStatus = { supported: boolean; permission: 'granted' | 'denied' | 'default' | 'unknown' };
export const defaultNotificationPreferences: Readonly<NotificationPreferences>;
export function normalizeNotificationPreferences(value: unknown): NotificationPreferences;
export function notificationText(value: unknown, limit?: number): string;
export function buildSystemNotification(event: SessionNotification, preferences?: Partial<NotificationPreferences>, language?: string): SystemNotification;
