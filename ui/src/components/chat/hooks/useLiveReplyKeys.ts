import { useState } from 'react';
import type { ChatMessage } from '../types/types';
import { getIntrinsicMessageKey } from '../utils/messageKeys';

/** Remember replies that arrive during a run, even if the final frame is batched with completion. */
export function useLiveReplyKeys(messages: ChatMessage[], working: boolean, scope = '') {
  const [snapshot, setSnapshot] = useState(() => ({ messages, working, scope, animated: new Set<string>() }));
  if (snapshot.messages === messages && snapshot.working === working && snapshot.scope === scope) return snapshot.animated;
  const animated = snapshot.scope === scope ? new Set(snapshot.animated) : new Set<string>();
  if (snapshot.scope === scope && (working || snapshot.working)) {
    const previous = new Set(snapshot.messages.map(getIntrinsicMessageKey));
    const lastKnown = messages.reduce((last, message, index) => previous.has(getIntrinsicMessageKey(message)) ? index : last, -1);
    for (const message of lastKnown < 0 ? [] : messages.slice(lastKnown + 1)) {
      const key = getIntrinsicMessageKey(message);
      if (key && !previous.has(key) && message.type === 'assistant' && !message.isThinking
        && !message.isToolUse && !message.isSubagentContainer && !message.isInteractivePrompt
        && !message.isAgentActivity && !message.isAgentActivitySummary && !message.isTaskNotification) {
        // Mounted replies finish their own animation. Replies first encountered
        // later by scrolling are history, even when they arrived during this run.
        animated.clear();
        animated.add(key);
      }
    }
  }
  setSnapshot({ messages, working, scope, animated });
  return animated;
}
