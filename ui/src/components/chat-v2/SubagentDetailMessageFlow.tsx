import { Fragment, useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowDown } from 'lucide-react';
import type { ChatMessage, ChatRunMode } from '../chat/types/types';
import { useScrollFollow } from '../chat/hooks/useScrollFollow';
import type { Project, SessionProvider } from '../../types/app';
import { getIntrinsicMessageKey } from '../chat/utils/messageKeys';
import GeneratedMediaCard from '../chat/tools/GeneratedMediaCard';
import ChatHistorySearchBar from './ChatHistorySearchBar';
import MessageRowV2 from './MessageRowV2';
import { TurnFileFooter } from './TurnFileFooter';
import { TurnProcessHeader, TurnProcessRegion } from './TurnProcessDisclosure';
import { FileInputStatus } from './FileInputStatus';
import { pendingFileInputs } from './fileInputStatusUtils';
import { useLiveReplyKeys } from './useLiveReplyKeys';
import { CompactProcessRow, ProcessBlock } from './ProcessBlock';
import { ProcessLiveStatus, type ProcessTraceStep } from './ProcessTrace';
import {
  buildRenderableMessageItems,
  groupProcessIntervals,
  getTurnProcessMemberId,
  turnProcessKey,
  type TurnProcessGroup,
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
    message.renderKey || (message.isCompactBoundary && message.compactionId) || message.id ||
      message.toolId ||
      message.activityId ||
      message.runId ||
      `${message.timestamp || 'message'}-${index}`,
  );
}

function isStreamingSubagentThinkingMessage(message: ChatMessage): boolean {
  return Boolean(message.isThinking && message.isStreaming);
}

export default function SubagentDetailMessageFlow({
  messages,
  provider,
  selectedProject,
  createDiff,
  onFileOpen,
  showThinking = true,
  isRunning = false,
}: SubagentDetailMessageFlowProps) {
  const { t } = useTranslation('chat');
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const follow = useScrollFollow({ containerRef: scrollContainerRef, enabled: true, contentKey: messages.length > 0, contentSelector: '[data-chat-scroll-content]' });
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
  const liveReplyKeys = useLiveReplyKeys(renderableMessages, isRunning);
  const renderableItems = useMemo(
    () => groupProcessIntervals(renderableMessages, buildRenderableMessageItems(renderableMessages, { isAssistantWorking: isRunning }), isRunning),
    [renderableMessages, isRunning],
  );
  const keyedItems = useMemo<KeyedRenderableMessageItem[]>(
    () => renderableItems.map((item, index) => ({
      ...item,
      itemKey: getMessageKey(item.message, index),
      renderIndex: index,
    })),
    [renderableItems],
  );
  const filePreparations = useMemo(() => isRunning ? pendingFileInputs(messages, messages) : [], [isRunning, messages]);
  const hasLiveGroup = renderableItems.some(item => item.turnTrace?.isLive);
  const shouldRenderBottomLiveStatus = isRunning && !hasLiveGroup && !streamingThinkingContent && !filePreparations.length;
  const keyedMessagesForSearch = useMemo<SearchableChatMessageInput[]>(() => {
    return keyedItems.filter(item => !item.mediaArtifact).flatMap(item => item.turnTrace
      ? item.turnTrace.items.map(child => ({ message: child.message, messageKey: getMessageKey(child.message, child.originalIndex), messageIndex: item.renderIndex }))
      : [{ message: item.message, messageKey: item.itemKey, messageIndex: item.renderIndex }]);
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
    onNavigate: match => {
      follow.pause();
      const item = keyedItems[match.messageIndex];
      if (item?.processRun) handleProcessExpandedChange(turnProcessKey("subagent", item.processRun), true);
      const trace = item?.turnTrace;
      if (trace) handleProcessExpandedChange(`${trace.id}:${trace.defaultExpanded}`, true);
    },
  });

  const renderLiveProcessDetailMessages = useCallback((detailMessages: ChatMessage[]) => {
    return detailMessages.map((message, index) => (
      <div key={getMessageKey(message, index)} className="chat-message" data-message-key={getMessageKey(message, index)}>
      {message.isCompactBoundary ? <CompactProcessRow message={message} running={isRunning} /> : <MessageRowV2
        message={message}
        prevMessage={index > 0 ? detailMessages[index - 1] : null}
        nextMessage={index < detailMessages.length - 1 ? detailMessages[index + 1] : null}
        provider={provider}
        selectedProject={selectedProject}
        createDiff={createDiff}
        onFileOpen={onFileOpen}
        showThinking={showThinking}
        isSessionRunning={isRunning}
        isProcessExpanded={isProcessExpanded}
        onProcessExpandedChange={handleProcessExpandedChange}
        isToolSectionExpanded={isToolSectionExpanded}
        onToolSectionExpandedChange={handleToolSectionExpandedChange}
      />}
      </div>
    ));
  }, [
    createDiff,
    handleProcessExpandedChange,
    handleToolSectionExpandedChange,
    isProcessExpanded,
    isRunning,
    isToolSectionExpanded,
    onFileOpen,
    provider,
    selectedProject,
    showThinking,
  ]);

  if (!keyedItems.length && !shouldRenderBottomLiveStatus && !filePreparations.length) return null;

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
      <div ref={scrollContainerRef} data-stream-scroll-viewport className="chat-panel-scrollbar min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden" style={{ overflowAnchor: 'none' }}>
        <div data-chat-scroll-content className="flex min-w-0 flex-col px-6 py-4">
          {keyedItems.map((item) => {
            const previousMessage = item.renderIndex > 0 ? keyedItems[item.renderIndex - 1].message : null;
            const nextMessage = item.renderIndex < keyedItems.length - 1
              ? keyedItems[item.renderIndex + 1].message
              : null;

            const rowContent = item.turnTrace ? <ProcessBlock trace={item.turnTrace}
                    expanded={isProcessExpanded(`${item.turnTrace.id}:${item.turnTrace.defaultExpanded}`, item.turnTrace.defaultExpanded)}
                    onExpandedChange={expanded => handleProcessExpandedChange(`${item.turnTrace!.id}:${item.turnTrace!.defaultExpanded}`, expanded)}>
                    {renderLiveProcessDetailMessages(item.turnTrace.items.map(child => child.message))}
                    {item.turnTrace.isLive && filePreparations.map(activity => <FileInputStatus key={activity.activityId} activity={activity} />)}
                  </ProcessBlock> : item.mediaArtifact ? (
                    <GeneratedMediaCard message={item.message} running={isRunning} visible={item.mediaExpanded} />
                  ) : <MessageRowV2
                    message={item.message}
                    animateTextOnMount={liveReplyKeys.has(getIntrinsicMessageKey(item.message) || "")}
                    prevMessage={previousMessage}
                    nextMessage={nextMessage}
                    beforeProcessAttachments={item.beforeProcessAttachments}
                    afterProcessAttachments={item.afterProcessAttachments}
                    provider={provider}
                    selectedProject={selectedProject}
                    createDiff={createDiff}
                    onFileOpen={onFileOpen}
                    showThinking={showThinking}
                    isSessionRunning={isRunning}
                    isProcessExpanded={isProcessExpanded}
                    onProcessExpandedChange={handleProcessExpandedChange}
                    isToolSectionExpanded={isToolSectionExpanded}
                    onToolSectionExpandedChange={handleToolSectionExpandedChange}
                  />;
            const renderTurnHeader = (group: TurnProcessGroup) => group.memberIds.length ? <TurnProcessHeader
              group={group} scope="subagent" showWhileRunning={false}
              expanded={isProcessExpanded(turnProcessKey('subagent', group), group.defaultExpanded)}
              onExpandedChange={expanded => handleProcessExpandedChange(turnProcessKey('subagent', group), expanded)} /> : null;

            return (
              <Fragment key={item.itemKey}>
                <div
                  className={item.processRun || item.mediaArtifact ? "chat-message" : "chat-message pb-2"}
                  data-message-key={item.itemKey}
                  data-message-timestamp={item.message.timestamp ? String(item.message.timestamp) : undefined}
                >
                  {item.beforeTurnProcess ? renderTurnHeader(item.beforeTurnProcess) : null}
                  {item.processRun ? <TurnProcessRegion group={item.processRun} scope="subagent"
                    member={getTurnProcessMemberId(item)} output={item.processOutput}
                    prose={item.message.type === 'assistant' && !item.turnTrace && !item.message.isToolUse}
                    expanded={Boolean(item.processOutput || isProcessExpanded(turnProcessKey('subagent', item.processRun), item.processRun.defaultExpanded))}>
                    {rowContent}
                  </TurnProcessRegion> : rowContent}
                  {item.afterTurnProcess ? renderTurnHeader(item.afterTurnProcess) : null}
                  {item.turnFiles ? <TurnFileFooter files={item.turnFiles} project={selectedProject} onBrowse={onFileOpen} /> : null}
                </div>
              </Fragment>
            );
          })}
          {!hasLiveGroup && filePreparations.map(activity => <div key={activity.activityId} className="pb-2"><FileInputStatus activity={activity} /></div>)}
          {shouldRenderBottomLiveStatus ? <ProcessLiveStatus step={thinkingStatusStep} /> : null}
        </div>
      </div>
      {follow.canReturnToLatest ? (
        <button type="button" onClick={follow.scrollToBottom} aria-label={t('session.scroll.returnToLatest', { defaultValue: 'Back to latest' })}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-neutral-200 bg-white p-2 text-neutral-600 shadow-sm dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300">
          <ArrowDown className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
}
