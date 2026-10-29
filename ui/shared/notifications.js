export const defaultNotificationPreferences = Object.freeze({ enabled: false, sound: true, badge: true, preview: true });

export function normalizeNotificationPreferences(value) {
  return Object.fromEntries(Object.entries(defaultNotificationPreferences).map(([key, fallback]) =>
    [key, typeof value?.[key] === 'boolean' ? value[key] : fallback]));
}

/** Only human-facing text belongs in the OS notification, never reasoning or tool output. */
export function notificationText(value, limit = 240) {
  if (typeof value !== 'string') return '';
  // Removing a tag can expose another one. Finish stripping complete tags
  // before formatting Markdown, then discard any incomplete delimiters below.
  let text = value;
  let previous;
  do {
    previous = text;
    text = text.replace(/<[^>]*>/g, '');
  } while (text !== previous);
  return text.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[`#*_~]/g, '')
    // Also remove incomplete tags and delimiters exposed by Markdown cleanup.
    .replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

export function buildSystemNotification(event, preferences = {}, language = 'en') {
  const zh = language.startsWith('zh');
  const labels = zh ? {
    completed: ['任务已完成', '点击查看结果'], approval: ['需要审批', '请审批后继续'],
    question: ['需要回答问题', '请回答后继续'], error: ['任务无法继续', '请检查原因后重试'],
    disconnected: ['连接中断', '正在尝试重连，请检查网络'],
  } : {
    completed: ['Task completed', 'Click to view the result'], approval: ['Approval needed', 'Approve to continue'],
    question: ['Answer needed', 'Answer to continue'], error: ['Task needs attention', 'Review the error and retry'],
    disconnected: ['Connection lost', 'Reconnecting. Please check your network'],
  };
  const [label, action] = labels[event.kind] || labels.error;
  const preview = preferences.preview !== false ? notificationText(event.preview) : '';
  return {
    id: event.id,
    title: notificationText(event.sessionName, 80) || 'PilotDeck',
    // Keep the required action visible even when the OS truncates a long preview.
    body: [`${label} · ${action}`, preview].filter(Boolean).join('\n'),
    silent: preferences.sound === false,
    data: { sessionId: event.sessionId, eventId: event.id, scope: event.scope, kind: event.kind, createdAt: event.createdAt, taskId: event.taskId },
  };
}
