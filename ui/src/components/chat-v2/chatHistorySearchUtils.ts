import type { ChatMessage } from '../chat/types/types';
import { getToolConfig, shouldHideToolResult } from '../chat/tools/configs/toolConfigs';

export type ChatHistorySearchMatch = {
  /** Index in the rendered message list. */
  messageIndex: number;
  /** Stable key used on `.chat-message[data-message-key]`. */
  messageKey: string;
  /** Character offset of the match within the message's searchable text. */
  offset: number;
  /** Match length in characters. */
  length: number;
};

export type SearchableChatMessageInput = {
  message: ChatMessage;
  messageKey: string;
  messageIndex?: number;
};

export type SearchableChatMessage = {
  message: ChatMessage;
  messageKey: string;
  messageIndex: number;
  text: string;
};

const HIGHLIGHT_CLASS = 'chat-history-search-highlight';
const ACTIVE_HIGHLIGHT_CLASS = 'chat-history-search-highlight-active';

function appendSearchPart(parts: string[], value: unknown): void {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    return;
  }
  const text = String(value).trim();
  if (text) parts.push(text);
}

function parseToolPayload(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function callToolDisplayGetter<T>(
  getter: ((value: unknown, helpers?: unknown) => T) | undefined,
  value: unknown,
  helpers?: unknown,
): T | undefined {
  if (typeof getter !== 'function') return undefined;
  try {
    return getter(value, helpers);
  } catch {
    return undefined;
  }
}

function visibleFileName(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.replace(/\\/g, '/');
  return normalized.split('/').pop() || value;
}

function collectVisibleToolInputText(message: ChatMessage): string[] {
  const toolName = typeof message.toolName === 'string' && message.toolName.trim()
    ? message.toolName.trim()
    : 'UnknownTool';
  const config = getToolConfig(toolName);
  const displayConfig = config.input;
  if (!displayConfig || displayConfig.type === 'hidden' || message.toolInput === undefined) {
    return [];
  }

  const parsedInput = parseToolPayload(message.toolInput);
  const parts: string[] = [];

  if (displayConfig.type === 'one-line') {
    const value = callToolDisplayGetter(displayConfig.getValue, parsedInput);
    const secondary = callToolDisplayGetter(displayConfig.getSecondary, parsedInput);

    if (displayConfig.style === 'terminal') {
      appendSearchPart(parts, value);
      appendSearchPart(parts, secondary);
      return parts;
    }

    const visibleLabel = displayConfig.label || toolName;
    appendSearchPart(parts, visibleLabel);
    appendSearchPart(parts, displayConfig.action === 'open-file' ? visibleFileName(value) : value);
    appendSearchPart(parts, secondary);
    return parts;
  }

  if (displayConfig.type === 'collapsible') {
    const rawTitle = typeof displayConfig.title === 'function'
      ? callToolDisplayGetter(displayConfig.title as (value: unknown, helpers?: unknown) => unknown, parsedInput, {
          toolResult: message.toolResult,
        })
      : displayConfig.title;
    appendSearchPart(parts, toolName);
    appendSearchPart(parts, rawTitle || 'Details');
  }

  return parts;
}

function collectVisibleToolResultText(message: ChatMessage): string[] {
  const toolResult = message.toolResult;
  if (!toolResult) return [];

  const toolName = typeof message.toolName === 'string' && message.toolName.trim()
    ? message.toolName.trim()
    : 'UnknownTool';
  if (shouldHideToolResult(toolName, toolResult)) return [];

  const toolContent = toolResult.content;
  if (toolResult.isError) {
    const parts: string[] = [];
    appendSearchPart(parts, toolContent);
    return parts;
  }

  const config = getToolConfig(toolName);
  const resultConfig = config.result;
  if (!resultConfig) return [];

  const parts: string[] = [];
  const parsedResult = parseToolPayload(toolResult);
  if (resultConfig.type === 'collapsible') {
    const rawTitle = typeof resultConfig.title === 'function'
      ? callToolDisplayGetter(resultConfig.title as (value: unknown, helpers?: unknown) => unknown, parsedResult)
      : resultConfig.title;
    appendSearchPart(parts, toolName);
    appendSearchPart(parts, rawTitle || 'Details');
    return parts;
  }

  if (resultConfig.type === 'card' && resultConfig.contentType === 'plan-card') {
    const contentProps = callToolDisplayGetter(resultConfig.getContentProps, parsedResult);
    if (contentProps && typeof contentProps === 'object') {
      const record = contentProps as Record<string, unknown>;
      appendSearchPart(parts, record.planTitle);
      appendSearchPart(parts, record.planSummary);
      appendSearchPart(parts, record.planFilePath);
    }
  }

  return parts;
}

function collectVisibleSubagentContainerText(message: ChatMessage): string[] {
  const parsedInput = parseToolPayload(message.toolInput);
  if (!parsedInput || typeof parsedInput !== 'object') {
    return [];
  }

  const input = parsedInput as Record<string, unknown>;
  const parts: string[] = [];
  appendSearchPart(parts, input.subagent_type || input.subagentType || 'agent');
  appendSearchPart(parts, input.description);
  return parts;
}

/** Collect plain text from a chat message for in-page search. */
export function extractSearchableText(message: ChatMessage): string {
  if (message.isThinking) {
    return '';
  }
  if (message.isSubagentContainer) {
    return collectVisibleSubagentContainerText(message).join('\n');
  }

  const parts: string[] = [];

  if (typeof message.content === 'string' && message.content.trim()) {
    parts.push(message.content);
  }

  if (message.isToolUse || message.toolName) {
    parts.push(...collectVisibleToolInputText(message));
    parts.push(...collectVisibleToolResultText(message));
  }

  return parts.join('\n');
}

export function buildSearchableMessages(
  items: SearchableChatMessageInput[],
): SearchableChatMessage[] {
  return items
    .map(({ message, messageKey, messageIndex }, fallbackIndex) => ({
      message,
      messageKey,
      messageIndex: messageIndex ?? fallbackIndex,
      text: extractSearchableText(message),
    }))
    .filter((entry) => entry.text.trim().length > 0);
}

/** Find all case-insensitive substring matches across searchable messages. */
export function findChatHistoryMatches(
  items: SearchableChatMessage[],
  query: string,
): ChatHistorySearchMatch[] {
  const needle = query.trim();
  if (!needle) return [];

  const lowerNeedle = needle.toLowerCase();
  const matches: ChatHistorySearchMatch[] = [];

  items.forEach((entry) => {
    const haystack = entry.text;
    const lowerHaystack = haystack.toLowerCase();
    let fromIndex = 0;

    while (fromIndex < lowerHaystack.length) {
      const found = lowerHaystack.indexOf(lowerNeedle, fromIndex);
      if (found < 0) break;
      matches.push({
        messageIndex: entry.messageIndex,
        messageKey: entry.messageKey,
        offset: found,
        length: needle.length,
      });
      fromIndex = found + Math.max(1, needle.length);
    }
  });

  return matches;
}

/** Scroll the messages container so a virtualized row is brought into view. */
export function scrollToMessageIndex(
  container: HTMLElement,
  itemHeights: number[],
  messageIndex: number,
): void {
  if (messageIndex < 0 || messageIndex >= itemHeights.length) return;

  let offset = 0;
  for (let index = 0; index < messageIndex; index += 1) {
    offset += Math.max(1, itemHeights[index] ?? 0);
  }

  const targetTop = Math.max(0, offset - container.clientHeight * 0.25);
  container.scrollTop = targetTop;
}

export function clearSearchHighlights(container: HTMLElement): void {
  container.querySelectorAll(`mark.${HIGHLIGHT_CLASS}`).forEach((node) => {
    const mark = node as HTMLElement;
    const parent = mark.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
    parent.normalize();
  });
}

function highlightTextNodeMatches(
  node: Text,
  query: string,
  firstOccurrence: number,
  highlightedOccurrences: Set<number>,
  activeOccurrence: number | null,
): { activeElement: HTMLElement | null; nextOccurrence: number } {
  const text = node.textContent || '';
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (!lowerQuery) {
    return { activeElement: null, nextOccurrence: firstOccurrence };
  }

  const fragment = document.createDocumentFragment();
  let activeElement: HTMLElement | null = null;
  let occurrence = firstOccurrence;
  let searchOffset = 0;
  let contentOffset = 0;
  let highlighted = false;

  while (searchOffset < lowerText.length) {
    const found = lowerText.indexOf(lowerQuery, searchOffset);
    if (found < 0) break;

    const occurrenceIndex = occurrence;
    occurrence += 1;
    if (highlightedOccurrences.has(occurrenceIndex)) {
      if (found > contentOffset) {
        fragment.appendChild(document.createTextNode(text.slice(contentOffset, found)));
      }

      const mark = document.createElement('mark');
      mark.className = HIGHLIGHT_CLASS;
      if (occurrenceIndex === activeOccurrence) {
        mark.classList.add(ACTIVE_HIGHLIGHT_CLASS);
        mark.setAttribute('aria-current', 'true');
        activeElement = mark;
      }
      mark.textContent = text.slice(found, found + query.length);
      fragment.appendChild(mark);
      contentOffset = found + query.length;
      highlighted = true;
    }

    searchOffset = found + Math.max(1, lowerQuery.length);
  }

  if (!highlighted) {
    return { activeElement: null, nextOccurrence: occurrence };
  }
  if (contentOffset < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(contentOffset)));
  }
  const parent = node.parentNode;
  if (!parent) {
    return { activeElement: null, nextOccurrence: occurrence };
  }
  parent.replaceChild(fragment, node);

  return { activeElement, nextOccurrence: occurrence };
}

function countOccurrencesBeforeOffset(text: string, query: string, offset: number): number {
  const lowerText = text.slice(0, offset).toLowerCase();
  const lowerQuery = query.toLowerCase();
  if (!lowerQuery) return 0;

  let count = 0;
  let fromIndex = 0;
  while (fromIndex < lowerText.length) {
    const found = lowerText.indexOf(lowerQuery, fromIndex);
    if (found < 0) break;
    count += 1;
    fromIndex = found + Math.max(1, lowerQuery.length);
  }
  return count;
}

function escapeMessageKeyForSelector(messageKey: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(messageKey);
  }
  return messageKey.replace(/[\0-\x1f\x7f"\\]/g, (character) => {
    if (character === '"' || character === '\\') return `\\${character}`;
    return `\\${character.charCodeAt(0).toString(16)} `;
  });
}

/** Highlight every mounted match and return the active element that should be revealed. */
export function highlightSearchMatches(
  container: HTMLElement,
  searchableMessages: SearchableChatMessage[],
  matches: ChatHistorySearchMatch[],
  query: string,
  activeMatch: ChatHistorySearchMatch | null,
): HTMLElement | null {
  clearSearchHighlights(container);
  if (!query || matches.length === 0) return null;

  const searchableByKey = new Map(searchableMessages.map((entry) => [entry.messageKey, entry]));
  const matchesByKey = new Map<string, ChatHistorySearchMatch[]>();
  matches.forEach((match) => {
    const messageMatches = matchesByKey.get(match.messageKey) || [];
    messageMatches.push(match);
    matchesByKey.set(match.messageKey, messageMatches);
  });

  let activeElement: HTMLElement | null = null;
  let activeMessageElement: HTMLElement | null = null;

  matchesByKey.forEach((messageMatches, messageKey) => {
    const searchableMessage = searchableByKey.get(messageKey);
    if (!searchableMessage) return;

    const messageEl = container.querySelector<HTMLElement>(
      `.chat-message[data-message-key="${escapeMessageKeyForSelector(messageKey)}"]`,
    );
    if (!messageEl) return;

    const highlightedOccurrences = new Set(
      messageMatches.map((match) => (
        countOccurrencesBeforeOffset(searchableMessage.text, query, match.offset)
      )),
    );
    const activeOccurrence = activeMatch?.messageKey === messageKey
      ? countOccurrencesBeforeOffset(searchableMessage.text, query, activeMatch.offset)
      : null;
    if (activeOccurrence !== null) {
      activeMessageElement = messageEl;
    }

    const walker = document.createTreeWalker(messageEl, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];
    while (walker.nextNode()) {
      const textNode = walker.currentNode as Text;
      if (!textNode.textContent?.trim()) continue;
      if (textNode.parentElement?.closest('mark')) continue;
      textNodes.push(textNode);
    }

    let currentOccurrence = 0;
    textNodes.forEach((textNode) => {
      const result = highlightTextNodeMatches(
        textNode,
        query,
        currentOccurrence,
        highlightedOccurrences,
        activeOccurrence,
      );
      currentOccurrence = result.nextOccurrence;
      if (result.activeElement) {
        activeElement = result.activeElement;
      }
    });
  });

  return activeElement ?? activeMessageElement;
}

/** Center a result by scrolling only the conversation container from its current position. */
export function scrollSearchTargetIntoView(
  container: HTMLElement,
  target: HTMLElement,
  behavior: ScrollBehavior = 'smooth',
): void {
  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const targetCenterInScrollContent =
    container.scrollTop + (targetRect.top - containerRect.top) + targetRect.height / 2;
  const targetTop = Math.max(0, targetCenterInScrollContent - container.clientHeight / 2);

  if (typeof container.scrollTo === 'function') {
    container.scrollTo({ top: targetTop, behavior });
  } else {
    container.scrollTop = targetTop;
  }
}
