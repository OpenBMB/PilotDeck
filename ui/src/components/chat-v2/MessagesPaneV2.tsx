import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { XCircle } from 'lucide-react';
import type {
  ChatMessage,
  ChatRunMode,
  ClaudeWorkStatus,
  PilotDeckWorkStatus,
  PilotDeckPermissionSuggestion,
  PermissionGrantResult,
} from '../chat/types/types';
import { isBackgroundTaskSession, type Project, type ProjectSession, type SessionProvider } from '../../types/app';
import { getIntrinsicMessageKey } from '../chat/utils/messageKeys';
import MessageRowV2 from './MessageRowV2';
import { ProcessLiveStatus, ProcessRunHeader, type ProcessTraceStep } from './ProcessTrace';
import { formatProcessDuration } from './processTraceUtils';
import {
  buildRenderableMessageItems,
  getLiveProcessDetailMessages,
  getLiveProcessGroups,
  getLiveProcessGroupStep,
  shouldRenderLiveProcessGroup,
  type LiveProcessGroup,
  type RenderableMessageItem,
} from './processGrouping';

type DiffLine = { type: string; content: string; lineNum: number };

type MessagesPaneV2Props = {
  scrollContainerRef: RefObject<HTMLDivElement>;
  onWheel: () => void;
  onTouchMove: () => void;
  isLoadingSessionMessages: boolean;
  sessionLoadError?: string | null;
  onRetrySessionLoad?: () => void;
  chatMessages: ChatMessage[];
  activityMessages?: ChatMessage[];
  visibleMessages: ChatMessage[];
  visibleMessageCount: number;
  isLoadingMoreMessages: boolean;
  hasMoreMessages: boolean;
  totalMessages: number;
  loadEarlierMessages: () => void;
  loadAllMessages: () => void;
  allMessagesLoaded: boolean;
  isLoadingAllMessages: boolean;
  provider: SessionProvider;
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  onGrantSessionToolPermission?: (
    suggestion: PilotDeckPermissionSuggestion,
  ) => PermissionGrantResult | null | undefined;
  autoExpandTools?: boolean;
  showRawParameters?: boolean;
  showThinking?: boolean;
  setInput: Dispatch<SetStateAction<string>>;
  isAssistantWorking?: boolean;
  workingStatus?: ClaudeWorkStatus | PilotDeckWorkStatus | null;
  runMode?: ChatRunMode;
};

type KeyedRenderableMessageItem = RenderableMessageItem & {
  itemKey: string;
  renderIndex: number;
  estimatedHeight: number;
};

export type VirtualMessageWindow = {
  startIndex: number;
  endIndex: number;
  topPadding: number;
  bottomPadding: number;
  totalHeight: number;
};

const MESSAGE_VIRTUALIZATION_THRESHOLD = 160;
const MESSAGE_WINDOW_OVERSCAN = 12;
const MESSAGE_GAP_PX = 16;

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function upperBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (values[mid] <= target) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}

function getMessageTextLength(message: ChatMessage): number {
  const contentLength = typeof message.content === 'string' ? message.content.length : 0;
  const toolInputLength = typeof message.toolInput === 'string' ? message.toolInput.length : 0;
  const outputLength = typeof message.toolResult?.content === 'string' ? message.toolResult.content.length : 0;
  return contentLength + Math.min(toolInputLength + outputLength, 2400);
}

// eslint-disable-next-line react-refresh/only-export-components
export function estimateMessageItemHeight(item: RenderableMessageItem): number {
  const textLength = getMessageTextLength(item.message);
  const roughLines = Math.ceil(textLength / 92);
  const baseHeight = item.message.type === 'user' ? 64 : 92;
  const processSummaryCount =
    item.beforeProcessAttachments.length + item.afterProcessAttachments.length;
  const processSummaryHeight = processSummaryCount * 32;
  const runHeaderHeight = (item.beforeRunAttachment ? 34 : 0) + (item.afterRunAttachment ? 34 : 0);
  const attachmentHeight = Array.isArray(item.message.attachments) && item.message.attachments.length > 0 ? 56 : 0;
  const imageHeight = Array.isArray(item.message.images) && item.message.images.length > 0 ? 180 : 0;
  const toolHeight = item.message.isToolUse || item.message.toolName ? 140 : 0;

  return clampNumber(
    baseHeight + roughLines * 20 + runHeaderHeight + processSummaryHeight + attachmentHeight + imageHeight + toolHeight + MESSAGE_GAP_PX,
    72,
    720,
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function getVirtualMessageWindow(
  itemHeights: number[],
  scrollTop: number,
  viewportHeight: number,
  overscan = MESSAGE_WINDOW_OVERSCAN,
): VirtualMessageWindow {
  if (itemHeights.length === 0) {
    return { startIndex: 0, endIndex: 0, topPadding: 0, bottomPadding: 0, totalHeight: 0 };
  }

  const prefixOffsets = [0];
  for (const height of itemHeights) {
    prefixOffsets.push(prefixOffsets[prefixOffsets.length - 1] + Math.max(1, height));
  }

  const totalHeight = prefixOffsets[prefixOffsets.length - 1];
  const safeScrollTop = clampNumber(Number.isFinite(scrollTop) ? scrollTop : 0, 0, totalHeight);
  const safeViewportHeight = Math.max(1, Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 900);
  const rawStart = Math.max(0, upperBound(prefixOffsets, safeScrollTop) - 1);
  const rawEnd = Math.min(itemHeights.length, upperBound(prefixOffsets, safeScrollTop + safeViewportHeight));
  const startIndex = Math.max(0, rawStart - overscan);
  const endIndex = Math.min(itemHeights.length, Math.max(startIndex + 1, rawEnd + overscan));

  return {
    startIndex,
    endIndex,
    topPadding: prefixOffsets[startIndex],
    bottomPadding: Math.max(0, totalHeight - prefixOffsets[endIndex]),
    totalHeight,
  };
}

function MeasuredMessageItem({
  itemKey,
  message,
  isLast,
  compactBottomSpacing = false,
  onHeightChange,
  children,
}: {
  itemKey: string;
  message: ChatMessage;
  isLast: boolean;
  compactBottomSpacing?: boolean;
  onHeightChange: (itemKey: string, height: number) => void;
  children: ReactNode;
}) {
  const itemRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const node = itemRef.current;
    if (!node) return undefined;

    const reportHeight = () => {
      onHeightChange(itemKey, node.getBoundingClientRect().height);
    };

    reportHeight();
    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }

    const observer = new ResizeObserver(reportHeight);
    observer.observe(node);

    return () => observer.disconnect();
  }, [itemKey, onHeightChange]);

  return (
    <div
      ref={itemRef}
      className={`chat-message ${isLast ? '' : compactBottomSpacing ? 'pb-2' : 'pb-4'}`}
      data-message-timestamp={message.timestamp ? String(message.timestamp) : undefined}
    >
      {children}
    </div>
  );
}

export default function MessagesPaneV2({
  scrollContainerRef,
  onWheel,
  onTouchMove,
  isLoadingSessionMessages,
  sessionLoadError,
  onRetrySessionLoad,
  chatMessages,
  activityMessages = [],
  visibleMessages,
  visibleMessageCount,
  isLoadingMoreMessages,
  hasMoreMessages,
  totalMessages,
  loadEarlierMessages,
  loadAllMessages,
  allMessagesLoaded,
  isLoadingAllMessages,
  provider,
  selectedProject,
  selectedSession,
  createDiff,
  onFileOpen,
  onShowSettings,
  onGrantSessionToolPermission,
  autoExpandTools,
  showRawParameters,
  showThinking,
  setInput,
  isAssistantWorking = false,
  workingStatus,
  runMode = 'agent',
}: MessagesPaneV2Props) {
  const { t } = useTranslation('chat');
  const messageKeyMapRef = useRef<WeakMap<ChatMessage, string>>(new WeakMap());
  const generatedMessageKeyCounterRef = useRef(0);
  const measuredHeightsRef = useRef<Map<string, number>>(new Map());
  const heightVersionRafRef = useRef<number | null>(null);
  const [heightVersion, setHeightVersion] = useState(0);
  const [scrollViewport, setScrollViewport] = useState({ scrollTop: 0, height: 0 });
  const [expandedProcessRows, setExpandedProcessRows] = useState<Map<string, boolean>>(() => new Map());

  const getMessageKey = useCallback((message: ChatMessage, index: number) => {
    const existingKey = messageKeyMapRef.current.get(message);
    if (existingKey) return existingKey;

    const intrinsicKey = getIntrinsicMessageKey(message);
    if (intrinsicKey) {
      messageKeyMapRef.current.set(message, intrinsicKey);
      return intrinsicKey;
    }

    generatedMessageKeyCounterRef.current += 1;
    const candidateKey = `message-generated-${index}-${generatedMessageKeyCounterRef.current}`;
    messageKeyMapRef.current.set(message, candidateKey);
    return candidateKey;
  }, []);

  const isProcessExpanded = useCallback((processKey: string, defaultExpanded = false) => (
    expandedProcessRows.get(processKey) ?? defaultExpanded
  ), [expandedProcessRows]);

  const handleProcessExpandedChange = useCallback((processKey: string, expanded: boolean) => {
    setExpandedProcessRows((currentRows) => {
      const currentExpanded = currentRows.get(processKey) ?? false;
      if (currentExpanded === expanded) {
        return currentRows;
      }

      const nextRows = new Map(currentRows);
      if (expanded) {
        nextRows.set(processKey, true);
      } else {
        nextRows.delete(processKey);
      }
      return nextRows;
    });
  }, []);

  const suggestedPrompts: string[] = [
    t('emptyChat.prompts.plan', { defaultValue: 'Plan a refactor for this project' }),
    t('emptyChat.prompts.summary', { defaultValue: 'Summarize recent changes' }),
    t('emptyChat.prompts.review', { defaultValue: 'Review the most recent file I touched' }),
  ];

  const isEmpty = !isLoadingSessionMessages && chatMessages.length === 0;
  const hasSessionLoadError = Boolean(!isLoadingSessionMessages && sessionLoadError && chatMessages.length === 0);
  const isNewConversationEmpty = isEmpty && !selectedSession;
  const isExistingConversationEmpty = isEmpty && Boolean(selectedSession) && !hasSessionLoadError;
  const isReadOnlyBackgroundSession = isBackgroundTaskSession(selectedSession);
  const liveActivities = useMemo(
    () => activityMessages.filter((message) => message.isAgentActivity),
    [activityMessages],
  );
  const renderableMessages = useMemo(
    () => visibleMessages.filter((message) => !message.isAgentActivity),
    [visibleMessages],
  );
  const liveProcessDetailMessages = useMemo(
    () => isAssistantWorking ? getLiveProcessDetailMessages(renderableMessages) : [],
    [isAssistantWorking, renderableMessages],
  );
  const liveProcessGroups = useMemo(
    () => isAssistantWorking
      ? getLiveProcessGroups(renderableMessages, { isAssistantWorking })
        .filter((group) => shouldRenderLiveProcessGroup(group, runMode))
      : [],
    [isAssistantWorking, renderableMessages, runMode],
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
  const renderableMessageItems = useMemo(
    () => buildRenderableMessageItems(renderableMessages, { isAssistantWorking }),
    [isAssistantWorking, renderableMessages],
  );
  const keyedMessageItems = useMemo<KeyedRenderableMessageItem[]>(
    () => renderableMessageItems.map((item, index) => ({
      ...item,
      itemKey: getMessageKey(item.message, index),
      renderIndex: index,
      estimatedHeight: estimateMessageItemHeight(item),
    })),
    [getMessageKey, renderableMessageItems],
  );
  const measuredItemHeights = useMemo(() => {
    void heightVersion;
    return keyedMessageItems.map((item) => measuredHeightsRef.current.get(item.itemKey) ?? item.estimatedHeight);
  }, [heightVersion, keyedMessageItems]);
  const shouldVirtualizeMessages = keyedMessageItems.length > MESSAGE_VIRTUALIZATION_THRESHOLD;
  const virtualWindow = useMemo(
    () => shouldVirtualizeMessages
      ? getVirtualMessageWindow(
          measuredItemHeights,
          scrollViewport.scrollTop,
          scrollViewport.height,
          MESSAGE_WINDOW_OVERSCAN,
        )
      : {
          startIndex: 0,
          endIndex: keyedMessageItems.length,
          topPadding: 0,
          bottomPadding: 0,
          totalHeight: measuredItemHeights.reduce((sum, height) => sum + height, 0),
        },
    [keyedMessageItems.length, measuredItemHeights, scrollViewport.height, scrollViewport.scrollTop, shouldVirtualizeMessages],
  );
  const windowedMessageItems = shouldVirtualizeMessages
    ? keyedMessageItems.slice(virtualWindow.startIndex, virtualWindow.endIndex)
    : keyedMessageItems;
  const liveProcessHeaderIndex = useMemo(() => {
    if (!isAssistantWorking) return -1;
    for (let index = keyedMessageItems.length - 1; index >= 0; index -= 1) {
      if (keyedMessageItems[index].message.type === 'user') {
        return Math.min(index + 1, keyedMessageItems.length);
      }
    }
    return keyedMessageItems.length > 0 ? 0 : -1;
  }, [isAssistantWorking, keyedMessageItems]);
  // The current turn's "started at" is anchored to the latest user message's
  // timestamp (set by the composer when the user submits). This is the only
  // signal that survives a page refresh and reliably resets between turns —
  // activity-based timing is unreliable because `activityMessages` accumulates
  // across turns in the session store.
  const liveProcessStartedAtMs = useMemo(() => {
    if (!isAssistantWorking || liveProcessHeaderIndex <= 0) return null;
    const anchorMessage = keyedMessageItems[liveProcessHeaderIndex - 1]?.message;
    if (anchorMessage?.type !== 'user' || anchorMessage.timestamp == null) return null;
    const parsed = Date.parse(String(anchorMessage.timestamp));
    return Number.isFinite(parsed) ? parsed : null;
  }, [isAssistantWorking, keyedMessageItems, liveProcessHeaderIndex]);
  const hasLiveAssistantContent = useMemo(() => {
    if (!isAssistantWorking || liveProcessHeaderIndex < 0) return false;
    return keyedMessageItems.slice(liveProcessHeaderIndex).some((item) => (
      item.message.type === 'assistant' &&
      !item.message.isThinking &&
      !item.message.isToolUse &&
      typeof item.message.content === 'string' &&
      item.message.content.trim().length > 0
    ));
  }, [isAssistantWorking, keyedMessageItems, liveProcessHeaderIndex]);
  const liveStatusStep = useMemo(
    () => getLiveStatusStep(liveActivities, workingStatus, hasLiveAssistantContent, t),
    [hasLiveAssistantContent, liveActivities, t, workingStatus],
  );
  const hasOpenEndedLiveProcessGroup = liveProcessGroups.some((group) => group.isRunning);
  const shouldRenderBottomLiveStatus = isAssistantWorking && !hasOpenEndedLiveProcessGroup;

  const bumpHeightVersion = useCallback(() => {
    if (heightVersionRafRef.current !== null) return;
    heightVersionRafRef.current = requestAnimationFrame(() => {
      heightVersionRafRef.current = null;
      setHeightVersion((version) => version + 1);
    });
  }, []);

  const handleMeasuredItemHeight = useCallback((itemKey: string, height: number) => {
    const normalizedHeight = Math.max(1, Math.ceil(height));
    const currentHeight = measuredHeightsRef.current.get(itemKey);
    if (currentHeight !== undefined && Math.abs(currentHeight - normalizedHeight) < 2) {
      return;
    }

    measuredHeightsRef.current.set(itemKey, normalizedHeight);
    bumpHeightVersion();
  }, [bumpHeightVersion]);

  useEffect(() => () => {
    if (heightVersionRafRef.current !== null) {
      cancelAnimationFrame(heightVersionRafRef.current);
    }
  }, []);

  useEffect(() => {
    const validKeys = new Set(keyedMessageItems.map((item) => item.itemKey));
    let changed = false;

    for (const itemKey of measuredHeightsRef.current.keys()) {
      if (!validKeys.has(itemKey)) {
        measuredHeightsRef.current.delete(itemKey);
        changed = true;
      }
    }

    if (changed) {
      bumpHeightVersion();
    }
  }, [bumpHeightVersion, keyedMessageItems]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return undefined;

    let frame = 0;
    const updateViewport = () => {
      frame = 0;
      setScrollViewport({
        scrollTop: container.scrollTop,
        height: container.clientHeight,
      });
    };
    const scheduleViewportUpdate = () => {
      if (frame) return;
      frame = requestAnimationFrame(updateViewport);
    };

    updateViewport();
    container.addEventListener('scroll', scheduleViewportUpdate, { passive: true });
    if (typeof ResizeObserver === 'undefined') {
      return () => {
        if (frame) cancelAnimationFrame(frame);
        container.removeEventListener('scroll', scheduleViewportUpdate);
      };
    }

    const resizeObserver = new ResizeObserver(scheduleViewportUpdate);
    resizeObserver.observe(container);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      container.removeEventListener('scroll', scheduleViewportUpdate);
      resizeObserver.disconnect();
    };
  }, [scrollContainerRef]);

  const renderLiveProcessDetailMessages = useCallback((detailMessages: ChatMessage[], groupId: string) => (
    detailMessages.map((message: ChatMessage, index: number) => (
      <MessageRowV2
        key={`${groupId}-${getMessageKey(message, index)}`}
        message={message}
        prevMessage={index > 0 ? detailMessages[index - 1] : null}
        nextMessage={index < detailMessages.length - 1 ? detailMessages[index + 1] : null}
        provider={provider}
        selectedProject={selectedProject}
        createDiff={createDiff}
        onFileOpen={onFileOpen}
        onShowSettings={onShowSettings}
        onGrantSessionToolPermission={onGrantSessionToolPermission}
        autoExpandTools={autoExpandTools}
        showRawParameters={showRawParameters}
        showThinking={showThinking}
        isProcessExpanded={isProcessExpanded}
        onProcessExpandedChange={handleProcessExpandedChange}
      />
    ))
  ), [
    autoExpandTools,
    createDiff,
    getMessageKey,
    onFileOpen,
    onGrantSessionToolPermission,
    onShowSettings,
    provider,
    selectedProject,
    isProcessExpanded,
    handleProcessExpandedChange,
    showRawParameters,
    showThinking,
  ]);

  const renderLiveProcessGroup = useCallback((group: LiveProcessGroup, index: number) => {
    const isLatestGroup = liveProcessGroups[liveProcessGroups.length - 1]?.id === group.id;
    const step = getLiveProcessGroupStep(group, t, group.isRunning && isLatestGroup ? liveStatusStep : null);

    return (
      <ProcessLiveStatus
        key={group.id || `${group.afterOriginalIndex}-${index}`}
        step={step}
        compact
        expanded={isProcessExpanded(group.id)}
        onExpandedChange={(expanded) => handleProcessExpandedChange(group.id, expanded)}
      >
        {group.detailMessages.length > 0
          ? renderLiveProcessDetailMessages(group.detailMessages, group.id)
          : null}
      </ProcessLiveStatus>
    );
  }, [
    handleProcessExpandedChange,
    isProcessExpanded,
    liveProcessGroups,
    liveStatusStep,
    renderLiveProcessDetailMessages,
    t,
  ]);

  const renderMessageItem = useCallback((item: KeyedRenderableMessageItem) => {
    const previousMessage = item.renderIndex > 0 ? keyedMessageItems[item.renderIndex - 1].message : null;
    const nextMessage = item.renderIndex < keyedMessageItems.length - 1
      ? keyedMessageItems[item.renderIndex + 1].message
      : null;
    const isLast = !isAssistantWorking && item.renderIndex === keyedMessageItems.length - 1;
    const anchoredLiveGroups = liveProcessGroupsByAnchor.get(item.originalIndex) || [];
    const rendersLiveHeaderAfterItem = item.renderIndex === liveProcessHeaderIndex - 1;

    return (
      <Fragment key={item.itemKey}>
        {liveProcessHeaderIndex === 0 && item.renderIndex === 0 ? (
          <LiveProcessHeader
            activities={liveActivities}
            startedAtMs={liveProcessStartedAtMs}
            t={t}
          />
        ) : null}
        <MeasuredMessageItem
          itemKey={item.itemKey}
          message={item.message}
          isLast={isLast}
          compactBottomSpacing={anchoredLiveGroups.length > 0 || rendersLiveHeaderAfterItem}
          onHeightChange={handleMeasuredItemHeight}
        >
          {item.beforeRunAttachment ? (
            <CompletedProcessHeader
              durationMs={item.beforeRunAttachment.durationMs}
              t={t}
            />
          ) : null}
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
            onShowSettings={onShowSettings}
            onGrantSessionToolPermission={onGrantSessionToolPermission}
            autoExpandTools={autoExpandTools}
            showRawParameters={showRawParameters}
            showThinking={showThinking}
            isProcessExpanded={isProcessExpanded}
            onProcessExpandedChange={handleProcessExpandedChange}
          />
          {rendersLiveHeaderAfterItem ? (
            <LiveProcessHeader
              activities={liveActivities}
              startedAtMs={liveProcessStartedAtMs}
              t={t}
            />
          ) : null}
          {item.afterRunAttachment ? (
            <CompletedProcessHeader
              durationMs={item.afterRunAttachment.durationMs}
              t={t}
            />
          ) : null}
          {anchoredLiveGroups.length > 0 ? (
            <div className="mt-2 flex min-w-0 flex-col gap-2">
              {anchoredLiveGroups.map(renderLiveProcessGroup)}
            </div>
          ) : null}
        </MeasuredMessageItem>
      </Fragment>
    );
  }, [
    autoExpandTools,
    createDiff,
    handleMeasuredItemHeight,
    handleProcessExpandedChange,
    isProcessExpanded,
    isAssistantWorking,
    keyedMessageItems,
    liveActivities,
    liveProcessHeaderIndex,
    liveProcessStartedAtMs,
    liveProcessGroupsByAnchor,
    onFileOpen,
    onGrantSessionToolPermission,
    onShowSettings,
    provider,
    renderLiveProcessGroup,
    selectedProject,
    showRawParameters,
    showThinking,
    t,
  ]);

  return (
    <div
      ref={scrollContainerRef}
      onWheel={onWheel}
      onTouchMove={onTouchMove}
      className="relative flex-1 overflow-y-auto overflow-x-hidden bg-white dark:bg-neutral-950"
    >
      {hasSessionLoadError ? (
        <div className="mx-auto flex h-full max-w-[720px] flex-col items-center justify-center gap-3 px-6 py-10 text-center">
          <XCircle className="h-5 w-5 text-amber-600 dark:text-amber-400" strokeWidth={1.75} />
          <div className="text-[15px] font-medium text-neutral-900 dark:text-neutral-100">
            {t('session.loadFailedTitle', { defaultValue: 'Could not load this conversation' })}
          </div>
          <div className="max-w-[520px] text-[13px] leading-5 text-neutral-500 dark:text-neutral-400">
            {sessionLoadError}
          </div>
          {onRetrySessionLoad ? (
            <button
              type="button"
              onClick={onRetrySessionLoad}
              className="inline-flex h-8 items-center rounded-md border border-neutral-200 px-3 text-[13px] font-medium text-neutral-700 transition hover:bg-neutral-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-900"
            >
              {t('session.retryLoad', { defaultValue: 'Retry' })}
            </button>
          ) : null}
        </div>
      ) : isLoadingSessionMessages && chatMessages.length === 0 ? (
        <div className="mx-auto flex h-full max-w-[720px] items-center justify-center px-6 py-10 text-[13px] text-neutral-500 dark:text-neutral-400">
          <div className="flex items-center gap-2">
            <div className="h-3.5 w-3.5 animate-spin rounded-full border-b-2 border-neutral-400" />
            <span>{t('loading', { defaultValue: 'Loading...' })}</span>
          </div>
        </div>
      ) : isNewConversationEmpty ? (
        <div className="mx-auto flex h-full max-w-[720px] flex-col items-center justify-center gap-4 px-6 py-10 text-center">
          <div className="text-[15px] font-medium text-neutral-900 dark:text-neutral-100">
            {selectedProject
              ? t('emptyChat.title', { defaultValue: 'Start a new conversation' })
              : t('emptyChat.noProject', { defaultValue: 'Pick a project from the sidebar' })}
          </div>
          {selectedProject ? (
            <div className="flex flex-col gap-1.5">
              {suggestedPrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => setInput(prompt)}
                  className="rounded-lg border border-neutral-200 px-3 py-1.5 text-left text-[13px] text-neutral-700 transition hover:bg-neutral-50 dark:border-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-900"
                >
                  {prompt}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : isExistingConversationEmpty ? (
        <div className="mx-auto flex h-full max-w-[720px] flex-col items-center justify-center gap-2 px-6 py-10 text-center">
          <div className="text-[15px] font-medium text-neutral-900 dark:text-neutral-100">
            {isReadOnlyBackgroundSession
              ? t('emptyChat.readonlyBackgroundTitle', {
                  defaultValue: 'No displayable messages in this task transcript',
                })
              : t('emptyChat.emptySessionTitle', {
                  defaultValue: 'No displayable messages in this conversation',
                })}
          </div>
          <div className="max-w-[520px] text-[13px] leading-5 text-neutral-500 dark:text-neutral-400">
            {isReadOnlyBackgroundSession
              ? t('emptyChat.readonlyBackgroundDescription', {
                  defaultValue:
                    'This read-only background task transcript only contains records the chat view cannot display.',
                })
              : t('emptyChat.emptySessionDescription', {
                  defaultValue:
                    'This conversation exists, but it does not contain messages that can be rendered here.',
                })}
          </div>
        </div>
      ) : (
        <div
          className="mx-auto max-w-[860px] px-6 py-10"
          data-virtualized-messages={shouldVirtualizeMessages ? 'true' : undefined}
          data-rendered-message-count={windowedMessageItems.length}
          data-total-message-count={keyedMessageItems.length}
        >
          {isLoadingMoreMessages && !isLoadingAllMessages && !allMessagesLoaded ? (
            <div className="pb-3 text-center text-[12px] text-neutral-500 dark:text-neutral-400">
              {t('messages.loadingOlder', { defaultValue: 'Loading older messages...' })}
            </div>
          ) : null}

          {hasMoreMessages && !isLoadingMoreMessages && !allMessagesLoaded ? (
            <div className="mb-8 flex items-center justify-between border-b border-neutral-200 pb-3 text-[12px] text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
              <span>
                {t('messages.showingOf', {
                  shown: chatMessages.length,
                  total: totalMessages,
                  defaultValue: `Showing ${chatMessages.length} of ${totalMessages}`,
                })}
              </span>
              <button
                type="button"
                onClick={loadEarlierMessages}
                className="text-[12px] text-neutral-700 underline-offset-2 hover:underline dark:text-neutral-300"
              >
                {t('messages.loadEarlier', { defaultValue: 'Load earlier' })}
              </button>
            </div>
          ) : null}

          {!hasMoreMessages && chatMessages.length > visibleMessageCount ? (
            <div className="mb-8 flex items-center justify-between border-b border-neutral-200 pb-3 text-[12px] text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
              <span>
                {t('messages.showingLast', {
                  count: visibleMessageCount,
                  total: chatMessages.length,
                  defaultValue: `Showing last ${visibleMessageCount} of ${chatMessages.length}`,
                })}
              </span>
              <button
                type="button"
                onClick={loadAllMessages}
                className="text-[12px] text-neutral-700 underline-offset-2 hover:underline dark:text-neutral-300"
              >
                {t('messages.loadAll', { defaultValue: 'Load all' })}
              </button>
            </div>
          ) : null}

          {shouldVirtualizeMessages && virtualWindow.topPadding > 0 ? (
            <div aria-hidden="true" style={{ height: virtualWindow.topPadding }} />
          ) : null}

          {windowedMessageItems.map(renderMessageItem)}

          {shouldVirtualizeMessages && virtualWindow.bottomPadding > 0 ? (
            <div aria-hidden="true" style={{ height: virtualWindow.bottomPadding }} />
          ) : null}

          {isAssistantWorking &&
          liveProcessHeaderIndex === keyedMessageItems.length &&
          keyedMessageItems[liveProcessHeaderIndex - 1]?.message.type !== 'user' ? (
            <LiveProcessHeader
              activities={liveActivities}
              startedAtMs={liveProcessStartedAtMs}
              t={t}
            />
          ) : null}

          {shouldRenderBottomLiveStatus ? (
            <ProcessLiveStatus step={liveStatusStep}>
              {liveProcessDetailMessages.length > 0
                ? renderLiveProcessDetailMessages(liveProcessDetailMessages, 'bottom-live-process')
                : null}
            </ProcessLiveStatus>
          ) : null}
        </div>
      )}
    </div>
  );
}

function getLatestActivity(activities: ChatMessage[]): ChatMessage | null {
  const byId = new Map<string, ChatMessage>();
  for (const activity of activities) {
    const key = activity.activityId || activity.id || `${activity.runId}-${activity.timestamp}`;
    byId.set(key, activity);
  }
  const latest = Array.from(byId.values());
  return [...latest].reverse().find((activity) => activity.state === 'running') || null;
}

function activityToLiveStep(activity: ChatMessage): ProcessTraceStep {
  return {
    id: activity.activityId || activity.id,
    title: activity.title || activity.content || activity.toolName || '',
    detail: activity.detail || '',
    state: activity.state || 'running',
    severity: activity.severity,
    phase: activity.phase,
    toolName: activity.toolName,
  };
}

function getLiveStatusStep(
  activities: ChatMessage[],
  workingStatus: ClaudeWorkStatus | PilotDeckWorkStatus | null | undefined,
  hasAssistantContent: boolean,
  t: (key: string, options?: Record<string, unknown>) => string,
): ProcessTraceStep {
  const latestActivity = getLatestActivity(activities);
  if (latestActivity) {
    return activityToLiveStep(latestActivity);
  }

  if (workingStatus?.compactProgress) {
    const progress = workingStatus.compactProgress;
    return {
      id: 'live-compact',
      title: t('working.compacting', { defaultValue: 'Compacting context...' }),
      detail: progress.label || progress.stage || '',
      phase: 'compact',
      state: progress.state || 'running',
    };
  }

  const rawStatus = String(workingStatus?.text || '').toLowerCase();
  if (rawStatus.includes('permission')) {
    return {
      id: 'live-permission',
      title: t('working.waitingForPermission', { defaultValue: 'Waiting for permission' }),
      phase: 'permission',
      state: 'running',
      severity: 'warning',
    };
  }
  if (rawStatus.includes('compact')) {
    return {
      id: 'live-compact',
      title: t('working.compacting', { defaultValue: 'Compacting context...' }),
      phase: 'compact',
      state: 'running',
    };
  }

  return hasAssistantContent
    ? {
        id: 'live-generation',
        title: t('working.generating', { defaultValue: 'Generating response' }),
        phase: 'generation',
        state: 'running',
      }
    : {
        id: 'live-thinking',
        title: t('working.thinking', { defaultValue: 'Thinking' }),
        phase: 'thinking',
        state: 'running',
      };
}

function getLiveProcessStartedAtMs(activities: ChatMessage[], fallbackStartedAtMs: number): number {
  if (activities.length === 0) return fallbackStartedAtMs;

  // `activityMessages` accumulates across turns in the session store, so the
  // raw list can include activities from previous runs. Scope the start time
  // to the current run by anchoring on the most recently received activity's
  // `runId` and picking the earliest start within that run.
  const latestActivity = activities[activities.length - 1];
  const latestRunId = latestActivity?.runId;
  const currentRunActivities = latestRunId
    ? activities.filter((activity) => activity.runId === latestRunId)
    : activities;

  let earliestMs = Number.POSITIVE_INFINITY;
  for (const activity of currentRunActivities) {
    const value = activity.startedAt || activity.timestamp;
    const parsed = value ? Date.parse(String(value)) : NaN;
    if (Number.isFinite(parsed) && parsed < earliestMs) {
      earliestMs = parsed;
    }
  }
  return Number.isFinite(earliestMs) ? earliestMs : fallbackStartedAtMs;
}

function LiveProcessHeader({
  activities,
  startedAtMs,
  t,
}: {
  activities: ChatMessage[];
  startedAtMs: number | null;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const fallbackStartedAtRef = useRef(Date.now());
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const elapsedMs = useMemo(() => {
    const effectiveStartedAtMs = startedAtMs
      ?? getLiveProcessStartedAtMs(activities, fallbackStartedAtRef.current);
    return Math.max(0, nowMs - effectiveStartedAtMs);
  }, [activities, nowMs, startedAtMs]);
  const duration = formatProcessDuration(elapsedMs);
  const label = t('process.summary.processed', {
    duration,
    defaultValue: `Processed ${duration}`,
  });

  return <ProcessRunHeader label={label} />;
}

function CompletedProcessHeader({
  durationMs,
  t,
}: {
  durationMs: number;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  const duration = formatProcessDuration(durationMs);
  const label = t('process.summary.processed', {
    duration,
    defaultValue: `Processed ${duration}`,
  });

  return <ProcessRunHeader label={label} />;
}
