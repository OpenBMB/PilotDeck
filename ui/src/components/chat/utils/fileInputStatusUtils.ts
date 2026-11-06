import type { ChatMessage } from '../types/types';

/** Reconcile ephemeral preparation against actual dispatch, even if its closing frame is delayed. */
export function pendingFileInputs(activities: ChatMessage[], messages: ChatMessage[], runId?: string | null): ChatMessage[] {
  const latest = new Map<string, ChatMessage>();
  for (const activity of activities) {
    if (activity.phase !== 'file_input' || (runId && activity.runId && runId !== activity.runId)) continue;
    latest.set(activity.activityId || activity.id || '', activity);
  }
  return [...latest.values()].filter(activity => activity.state === 'running' && activity.fileInputProgress
    && !messages.some(message => message.isToolUse && (message.toolId || message.toolCallId) === activity.toolId
      && (!activity.runId || !message.runId || activity.runId === message.runId)));
}
