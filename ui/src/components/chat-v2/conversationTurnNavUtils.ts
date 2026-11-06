import type { ChatMessage } from '../chat/types/types';
import { getIntrinsicMessageKey } from '../chat/utils/messageKeys';

function preview(text: string, limit: number) {
  return Array.from(text.slice(0, limit * 8).replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`#*_~>]/g, '').replace(/\s+/g, ' ').trim()).slice(0, limit).join('');
}

export function buildConversationTurns(messages: ChatMessage[]) {
  const turns: { key: string; prompt: string; response: string }[] = [];
  for (const message of messages) {
    if (message.type === 'user') {
      const key = getIntrinsicMessageKey(message);
      if (key) turns.push({ key, prompt: preview(message.content || message.attachments?.map(file => file.name).join(', ') || '', 50), response: '' });
    } else if (turns.length && message.type === 'assistant' && !message.isThinking && !message.isToolUse
      && !message.isSubagentContainer && !message.isAgentActivity && !message.isAgentActivitySummary
      && !message.isTaskNotification && !message.isInteractivePrompt && !message.isInterruptedNotice && message.content?.trim()) {
      turns[turns.length - 1].response = preview(message.content, 160);
    }
  }
  return turns;
}
