import { Fragment, useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown } from 'lucide-react';
import type { ChatMessage, ChatRunMode } from '../chat/types/types';
import { useScrollFollow } from '../chat/hooks/useScrollFollow';
import type { Project, SessionProvider } from '../../types/app';
import ChatHistorySearchBar from './ChatHistorySearchBar';
import MessageRowV2 from './MessageRowV2';
import { ProcessLiveStatus, type ProcessTraceStep } from './ProcessTrace';
import {
  buildRenderableMessageItems,
  getLiveProcessGroups,
  getLiveProcessGroupStep,
  shouldRenderLiveProcessGroup,
  splitLiveProcessGroupDetailMessages,
  type LiveProcessGroup,
  type ProcessAttachment,
  type RenderableMessageItem,
} from './processGrouping';
import { useChatHistorySearch } from './useChatHistorySearch';
import type { SearchableChatMessageInput } from './chatHistorySearchUtils';

type DiffLine = { type: string; content: string; lineNum: number };

interface SubagentDetailMessageFlowProps {
  messages: ChatMessage[];
  provider: SessionProvider;
  selectedProject: Project | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  showThinking?: boolean;
  isRunning?: boolean;
  runMode?: ChatRunMode;
}

type KeyedRenderableMessageItem = RenderableMessageItem & {
  itemKey: string;
  renderIndex: number;
};

function getMessageKey(message: ChatMessage, index: number): string {
  return String(
    message.renderKey || message.id ||
      message.toolId ||
      message.activityId ||
      message.runId ||
      `${message.timestamp || 'message'}-${index}`,
  );
}

function isStreamingSubagentThinkingMessage(message: ChatMessage): boolean {
  return Boolean(message.isThinking && String(message.id || '').startsWith('__subagent_thinking_'));
}

function processAttachmentOverlapsLiveGroup(
  attachment: ProcessAttachment,
  liveGroups: LiveProcessGroup[],
): boolean {
  return liveGroups.some((group) => (
    attachment.startIndex <= group.endIndex && attachment.endIndex >= group.startIndex
  ));
}

function removeLiveOverlappingProcessAttachments(
  item: RenderableMessageItem,
  liveGroups: LiveProcessGroup[],
): RenderableMessageItem {
  if (liveGroups.length === 0) return item;

  return {
    ...item,
    beforeProcessAttachments: item.beforeProcessAttachments.filter(
      (attachment) => !processAttachmentOverlapsLiveGroup(attachment, liveGroups),
    ),
    afterProcessAttachments: item.afterProcessAttachments.filter(
      (attachment) => !processAttachmentOverlapsLiveGroup(attachment, liveGroups),
    ),
  };
}

export default function SubagentDetailMessageFlow({
  messages,
  provider,
  selectedProject,
  createDiff,
  onFileOpen,
  showThinking = true,
  isRunning = false,
  runMode = 'agent',
}: SubagentDetailMessageFlowProps) {
  const { t } = useTranslation('chat');
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const follow = useScrollFollow({ containerRef: scrollContainerRef, enabled: isRunning, contentKey: messages.length > 0, contentSelector: '[data-chat-scroll-content]' });
  const [expandedProcessRows, setExpandedProcessRows] = useState<Map<string, boolean>>(() => new Map());
  const [expandedToolSections, setExpandedToolSections] = useState<Map<string, boolean>>(() => new Map());

  const streamingThinkingContent = useMemo(() => {
    if (!showThinking || !isRunning) return null;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (
        isStreamingSubagentThinkingMessage(message) &&
        typeof message.content === 'string' &&
        message.content.trim()
      ) {
        return message.content;
      }
    }
    return null;
  }, [isRunning, messages, showThinking]);

  const thinkingStatusStep = useMemo<ProcessTraceStep>(() => {
    return {
      id: 'subagent-detail-thinking',
      title: t('subagent.status.thinking', { defaultValue: 'Thinking' }),
      phase: 'thinking',
      state: 'running' as const,
    };
  }, [t]);

  const renderableMessages = useMemo(
    () => {
      const result = messages
        .filter((message) =>
          !message.isAgentActivity &&
          !(message.isThinking && !showThinking)
        )
        .map((message) => message.isSubagentContainer
          ? { ...message, isSubagentContainer: false }
          : message
        );
      return result;
    },
    [messages, showThinking],
  );
  const baseRenderableItems = useMemo(
    () => buildRenderableMessageItems(renderableMessages, { isAssistantWorking: true })
      .filter((item) => !item.message.isAgentActivitySummary),
    [renderableMessages],
  );
  const liveProcessGroups = useMemo(
    () => getLiveProcessGroups(renderableMessages, { isAssistantWorking: true })
        .filter((group) => shouldRenderLiveProcessGroup(group, runMode))
        .map((group) => isRunning ? group : { ...group, isRunning: false }),
    [isRunning, renderableMessages, runMode],
  );
  const renderableItems = useMemo(
    () => baseRenderableItems.map((item) => removeLiveOverlappingProcessAttachments(item, liveProcessGroups)),
    [baseRenderableItems, liveProcessGroups],
  );
  const keyedItems = useMemo<KeyedRenderableMessageItem[]>(
    () => renderableItems.map((item, index) => ({
      ...item,
      itemKey: getMessageKey(item.message, index),
      renderIndex: index,
    })),
    [renderableItems],
  );
  const visibleOriginalIndices = useMemo(
    () => new Set(keyedItems.map((item) => item.originalIndex)),
    [keyedItems],
  );
  const liveProcessGroupsByAnchor = useMemo(() => {
    const groupsByAnchor = new Map<number, LiveProcessGroup[]>();
    for (const group of liveProcessGroups) {
      const groups = groupsByAnchor.get(group.afterOriginalIndex) || [];
      groups.push(group);
      groupsByAnchor.set(group.afterOriginalIndex, groups);
    }
    return groupsByAnchor;
  }, [liveProcessGroups]);
  const unanchoredLiveProcessGroups = useMemo(
    () => liveProcessGroups.filter((group) => !visibleOriginalIndices.has(group.afterOriginalIndex)),
    [liveProcessGroups, visibleOriginalIndices],
  );
  const unanchoredLiveProcessGroupsByBeforeIndex = useMemo(() => {
    const groupsByBeforeIndex = new Map<number, LiveProcessGroup[]>();
    for (const group of unanchoredLiveProcessGroups) {
      if (group.beforeOriginalIndex == null) continue;
      const insertionItem = keyedItems.find((item) => item.originalIndex >= group.beforeOriginalIndex!);
      if (!insertionItem) continue;
      const groups = groupsByBeforeIndex.get(insertionItem.originalIndex) || [];
      groups.push(group);
      groupsByBeforeIndex.set(insertionItem.originalIndex, groups);
    }
    return groupsByBeforeIndex;
  }, [keyedItems, unanchoredLiveProcessGroups]);
  const bottomUnanchoredLiveProcessGroups = useMemo(
    () => unanchoredLiveProcessGroups.filter((group) => {
      if (group.beforeOriginalIndex == null) return true;
      return !keyedItems.some((item) => item.originalIndex >= group.beforeOriginalIndex!);
    }),
    [keyedItems, unanchoredLiveProcessGroups],
  );
  const hasOpenEndedLiveProcessGroup = liveProcessGroups.some((group) => group.isRunning);
  const shouldRenderBottomLiveStatus = isRunning && !hasOpenEndedLiveProcessGroup && !streamingThinkingContent;
  const keyedMessagesForSearch = useMemo<SearchableChatMessageInput[]>(() => {
    return keyedItems.map((item) => (
      {
        message: item.message,
        messageKey: item.itemKey,
        messageIndex: item.renderIndex,
      }
    ));
  }, [keyedItems]);
  const measuredItemHeights = useMemo(
    () => keyedItems.map(() => 96),
    [keyedItems],
  );

  const isProcessExpanded = useCallback((processKey: string, defaultExpanded = false) => (
    expandedProcessRows.get(processKey) ?? defaultExpanded
  ), [expandedProcessRows]);

  const loadAllSearchMessages = useCallback(() => {}, []);
  const handleProcessExpandedChange = useCallback((processKey: string, expanded: boolean) => {
    setExpandedProcessRows((prev) => {
      const next = new Map(prev);
      next.set(processKey, expanded);
      return next;
    });
  }, []);

  const isToolSectionExpanded = useCallback((sectionKey: string, defaultExpanded = false) => (
    expandedToolSections.get(sectionKey) ?? defaultExpanded
  ), [expandedToolSections]);

  const handleToolSectionExpandedChange = useCallback((sectionKey: string, expanded: boolean) => {
    setExpandedToolSections((currentSections) => {
      if (currentSections.get(sectionKey) === expanded) return currentSections;
      const nextSections = new Map(currentSections);
      nextSections.set(sectionKey, expanded);
      return nextSections;
    });
  }, []);

  const chatHistorySearch = useChatHistorySearch({
    scrollContainerRef,
    keyedMessages: keyedMessagesForSearch,
    measuredItemHeights,
    allMessagesLoaded: true,
    hasMoreMessages: false,
    loadAllMessages: loadAllSearchMessages,
    sessionId: null,
    captureFindShortcutInModal: true,
    onNavigate: follow.pause,
  });

  const renderLiveProcessDetailMessages = useCallback((detailMessages: ChatMessage[], groupId: string) => {
    return detailMessages.map((message, index) => (
      <MessageRowV2
        key={`${groupId}-${index}-${getMessageKey(message, index)}`}
        message={message}
        prevMessage={index > 0 ? detailMessages[index - 1] : null}
        nextMessage={index < detailMessages.length - 1 ? detailMessages[index + 1] : null}
        provider={provider}
        selectedProject={selectedProject}
        createDiff={createDiff}
        onFileOpen={onFileOpen}
        showThinking={showThinking}
        isProcessExpanded={isProcessExpanded}
        onProcessExpandedChange={handleProcessExpandedChange}
        isToolSectionExpanded={isToolSectionExpanded}
        onToolSectionExpandedChange={handleToolSectionExpandedChange}
      />
    ));
  }, [
    createDiff,
    handleProcessExpandedChange,
    handleToolSectionExpandedChange,
    isProcessExpanded,
    isToolSectionExpanded,
    onFileOpen,
    provider,
    selectedProject,
    showThinking,
  ]);

  const renderLiveProcessGroup = useCallback((group: LiveProcessGroup, index: number) => {
    const step = getLiveProcessGroupStep(group, t, null);
    const expanded = isProcessExpanded(group.id);
    const { beforeStatusMessages, statusDetailMessages } = splitLiveProcessGroupDetailMessages(group);
    return (
      <Fragment key={group.id || `${group.afterOriginalIndex}-${index}`}>
        {expanded && beforeStatusMessages.length > 0 ? (
          <div className="pl-5">
            {renderLiveProcessDetailMessages(beforeStatusMessages, `${group.id}-before-status`)}
          </div>
        ) : null}
        <ProcessLiveStatus
          step={step}
          compact
          expanded={expanded}
          onExpandedChange={(expanded) => handleProcessExpandedChange(group.id, expanded)}
        >
          {statusDetailMessages.length > 0
            ? renderLiveProcessDetailMessages(statusDetailMessages, group.id)
            : null}
        </ProcessLiveStatus>
      </Fragment>
    );
  }, [
    handleProcessExpandedChange,
    isProcessExpanded,
    renderLiveProcessDetailMessages,
    t,
  ]);

  if (
    keyedItems.length === 0 &&
    bottomUnanchoredLiveProcessGroups.length === 0 &&
    unanchoredLiveProcessGroupsByBeforeIndex.size === 0 &&
    !shouldRenderBottomLiveStatus
  ) {
    return null;
  }

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {chatHistorySearch.isOpen ? (
        <ChatHistorySearchBar
          query={chatHistorySearch.query}
          onQueryChange={chatHistorySearch.setQuery}
          matchCount={chatHistorySearch.matches.length}
          activeMatchIndex={chatHistorySearch.activeMatchIndex}
          onPrevious={chatHistorySearch.goToPrevious}
          onNext={chatHistorySearch.goToNext}
          onClose={chatHistorySearch.closeSearch}
          inputRef={chatHistorySearch.inputRef}
        />
      ) : null}
      <div ref={scrollContainerRef} data-stream-scroll-viewport className="min-h-0 flex-1 overflow-y-auto" style={{ overflowAnchor: 'none' }}>
        <div data-chat-scroll-content className="flex min-w-0 flex-col gap-3 px-6 py-4">
          {keyedItems.map((item) => {
            const previousMessage = item.renderIndex > 0 ? keyedItems[item.renderIndex - 1].message : null;
            const nextMessage = item.renderIndex < keyedItems.length - 1
              ? keyedItems[item.renderIndex + 1].message
              : null;
            const anchoredLiveGroups = liveProcessGroupsByAnchor.get(item.originalIndex) || [];
            const beforeLiveGroups = unanchoredLiveProcessGroupsByBeforeIndex.get(item.originalIndex) || [];

            return (
              <Fragment key={item.itemKey}>
                {beforeLiveGroups.length > 0 ? (
                  <div className="flex min-w-0 flex-col gap-2">
                    {beforeLiveGroups.map(renderLiveProcessGroup)}
                  </div>
                ) : null}
                <div
                  className="chat-message"
                  data-message-key={item.itemKey}
                  data-message-timestamp={item.message.timestamp ? String(item.message.timestamp) : undefined}
                >
                  <MessageRowV2
                    message={item.message}
                    prevMessage={previousMessage}
                    nextMessage={nextMessage}
                    beforeProcessAttachments={item.beforeProcessAttachments}
                    afterProcessAttachments={item.afterProcessAttachments}
                    provider={provider}
                    selectedProject={selectedProject}
                    createDiff={createDiff}
                    onFileOpen={onFileOpen}
                    showThinking={showThinking}
                    isProcessExpanded={isProcessExpanded}
                    onProcessExpandedChange={handleProcessExpandedChange}
                    isToolSectionExpanded={isToolSectionExpanded}
                    onToolSectionExpandedChange={handleToolSectionExpandedChange}
                  />
                </div>
                {anchoredLiveGroups.length > 0 ? (
                  <div className="flex min-w-0 flex-col gap-2">
                    {anchoredLiveGroups.map(renderLiveProcessGroup)}
                  </div>
                ) : null}
              </Fragment>
            );
          })}
          {bottomUnanchoredLiveProcessGroups.length > 0 ? (
            <div className="flex min-w-0 flex-col gap-2">
              {bottomUnanchoredLiveProcessGroups.map(renderLiveProcessGroup)}
            </div>
          ) : null}
          {shouldRenderBottomLiveStatus ? <ProcessLiveStatus step={thinkingStatusStep} /> : null}
        </div>
      </div>
      {follow.isPaused ? (
        <button type="button" onClick={follow.scrollToBottom} aria-label={t('session.scroll.returnToLatest', { defaultValue: 'Back to latest' })}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-neutral-200 bg-white p-2 text-neutral-600 shadow-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
          <ArrowDown className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}
