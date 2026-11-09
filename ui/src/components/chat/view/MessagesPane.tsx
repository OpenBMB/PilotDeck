import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { XCircle, GitBranch, ArrowDown } from 'lucide-react';
import { adjustScrollLayout, notifyScrollLayout } from '../hooks/useScrollFollow';
import { recordUiDiagnostic, reloadUi } from '../../../lib/uiDiagnostics';
import type {
  ChatMessage,
  ChatRunMode,
  ClaudeWorkStatus,
  PilotDeckWorkStatus,
  PilotDeckPermissionSuggestion,
  SessionPermissionGrantResult,
  SessionRuntimeState,
  PendingPermissionRequest,
} from '../types/types';
import type { SessionStore } from '../../../stores/useSessionStore';
import { getSessionRequestParams, isReadOnlySession, type Project, type ProjectSession, type SessionProvider } from '../../../types/app';
import { getIntrinsicMessageKey } from '../utils/messageKeys';
import GeneratedMediaCard from '../tools/GeneratedMediaCard';
import type { QueuedInputSummary } from '../types/queuedInput';
import { expandingDisclosure } from '../utils/disclosureInteraction';
import MessageRow from './MessageRow';
import { disclosureAncestorKeys } from '../utils/disclosureState';
import { TurnFileFooter } from './TurnFileFooter';
import { useLiveReplyKeys } from '../hooks/useLiveReplyKeys';
import { TurnProcessHeader, TurnProcessRegion } from './TurnProcessDisclosure';
import { FileInputStatus } from './FileInputStatus';
import { pendingFileInputs } from '../utils/fileInputStatusUtils';
import { ConversationTurnNav } from './ConversationTurnNav';
import { CompactProcessRow, ProcessBlock } from './ProcessBlock';
import SendingMessages from './SendingMessages';
import AssistantReplyQuoteAction from './AssistantReplyQuoteAction';
import SubagentDetailModal from './SubagentDetailModal';
import ChatHistorySearchBar from './ChatHistorySearchBar';
import { useRegisterChatHistorySearchControls } from './ChatHistorySearchController';
import { useChatHistorySearch } from '../hooks/useChatHistorySearch';
import { getSessionRequestIdentity } from '../utils/sessionRequestIdentity';
import type { SearchableChatMessageInput } from '../utils/chatHistorySearchUtils';
import { useSubagentMessages } from '../hooks/useSubagentMessages';
import { ProcessLiveStatus, type ProcessTraceStep } from './ProcessTrace';
import {
  buildRenderableMessageItems,
  groupProcessIntervals,
  getTurnProcessMemberId,
  turnProcessKey,
  type TurnProcessGroup,
  isPendingToolUseMessage,
  isPendingProcessMessage,
  type RenderableMessageItem,
} from '../utils/processGrouping';
import {
  getChatResponseReserveTarget,
  shouldKeepChatResponseReservedSpace,
} from '../utils/chatResponseReservedSpace';
type DiffLine = { type: string; content: string; lineNum: number };

type MessagesPaneProps = {
  scrollContainerRef: RefObject<HTMLDivElement>;
  showReturnToLatest?: boolean;
  onResumeScroll?: () => void;
  onPauseScroll?: (messageKey?: string) => void;
  isLoadingSessionMessages: boolean;
  sessionLoadError?: string | null;
  onRetrySessionLoad?: () => void;
  chatMessages: ChatMessage[];
  sendingInputs?: QueuedInputSummary[];
  activityMessages?: ChatMessage[];
  visibleMessages: ChatMessage[];
  visibleMessageCount: number;
  isLoadingMoreMessages: boolean;
  historyLoadError?: boolean;
  hasMoreMessages: boolean;
  totalMessages: number;
  loadEarlierMessages: () => void;
  loadAllMessages: () => void | Promise<void>;
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
  ) => SessionPermissionGrantResult | null | undefined;
  autoExpandTools?: boolean;
  showThinking?: boolean;
  inlineThinking?: boolean;
  setInput: Dispatch<SetStateAction<string>>;
  isAssistantWorking?: boolean;
  pendingPermissionRequests?: PendingPermissionRequest[];
  sessionRuntimeState?: SessionRuntimeState;
  activeRunId?: string | null;
  workingStatus?: ClaudeWorkStatus | PilotDeckWorkStatus | null;
  runMode?: ChatRunMode;
  planModeActive?: boolean;
  sessionStore?: SessionStore;
  onFork?: (message: ChatMessage, carriedMessageCount: number) => void;
  onRegenerate?: (message: ChatMessage, editedText: string) => Promise<void>;
  forkDisabled?: boolean;
  forkParentSessionTitle?: string | null;
};

type KeyedRenderableMessageItem = RenderableMessageItem & {
  layoutSignature: string;
  closedHeight: number | null;
  itemKey: string;
  renderIndex: number;
  estimatedHeight: number;
};

function isHistoricalSubagentItem(
  item: Pick<KeyedRenderableMessageItem, 'message' | 'renderIndex'>,
  activeRunId: string | null,
  sessionRuntimeState: SessionRuntimeState,
  liveProcessHeaderIndex: number,
): boolean {
  if (!item.message.isSubagentContainer || sessionRuntimeState === 'inactive' || !activeRunId) {
    return false;
  }
  const messageRunId = item.message.turnId || item.message.runId || null;
  if (messageRunId) return messageRunId !== activeRunId;
  return liveProcessHeaderIndex >= 0 && item.renderIndex < liveProcessHeaderIndex;
}

export type VirtualMessageWindow = {
  startIndex: number;
  endIndex: number;
  topPadding: number;
  bottomPadding: number;
  totalHeight: number;
};

// The default conversation window contains at most 100 messages. Rendering that
// window directly is cheap and, more importantly, avoids handing the initial
// session-scroll restoration to the virtualizer before both sides agree on the
// new scroll position. Larger explicitly-loaded histories still virtualize.
const MESSAGE_VIRTUALIZATION_THRESHOLD = 160;
const MESSAGE_WINDOW_OVERSCAN = 12;
const MESSAGE_GAP_PX = 16;

function isStreamingThinkingMessage(message: ChatMessage): boolean {
  return Boolean(message.isThinking && message.isStreaming);
}

function isRenderableAssistantProse(message: ChatMessage): boolean {
  return (
    message.type === 'assistant' &&
    !message.isToolUse &&
    !message.isThinking &&
    !message.isStreaming &&
    !message.isInteractivePrompt &&
    !message.isSubagentContainer &&
    !message.isTaskNotification &&
    !message.isAgentActivity &&
    !message.isAgentActivitySummary &&
    typeof message.content === 'string' &&
    message.content.trim().length > 0
  );
}

function isSubagentThinkingPlaceholder(message: ChatMessage): boolean {
  const id = String(message.id || '');
  return Boolean(message.isThinking && (id.startsWith('subagent_thinking_') || id.startsWith('__subagent_thinking_')));
}

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
  const turnHeaderHeight = (item.beforeTurnProcess ? 34 : 0) + (item.afterTurnProcess ? 34 : 0);
  const artifactCount = item.turnFiles?.visible ? item.turnFiles.artifacts.length : 0;
  const artifactHeight = artifactCount > 0 ? Math.min(artifactCount, 3) * 64 + 34 : 0;
  if (item.mediaArtifact) return turnHeaderHeight + artifactHeight + (item.mediaExpanded === false ? 0 : 360);
  if (item.processRun && !item.processOutput && !item.processRun.defaultExpanded) return turnHeaderHeight + artifactHeight;
  if (item.turnTrace) return 50 + turnHeaderHeight + artifactHeight;
  const textLength = getMessageTextLength(item.message);
  const roughLines = Math.ceil(textLength / 92);
  const baseHeight = item.message.type === 'user' ? 64 : 92;
  const processSummaryCount =
    item.beforeProcessAttachments.length + item.afterProcessAttachments.length;
  const processSummaryHeight = processSummaryCount * 32;
  const runHeaderHeight = turnHeaderHeight + (item.beforeRunAttachment ? 34 : 0) + (item.afterRunAttachment ? 34 : 0);
  const attachmentHeight = Array.isArray(item.message.attachments) && item.message.attachments.length > 0 ? 56 : 0;
  const imageHeight = Array.isArray(item.message.images) && item.message.images.length > 0 ? 180 : 0;
  const toolHeight = item.message.isToolUse || item.message.toolName ? 140 : 0;

  return clampNumber(
    baseHeight + roughLines * 20 + runHeaderHeight + processSummaryHeight + attachmentHeight + artifactHeight + imageHeight + toolHeight + MESSAGE_GAP_PX,
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
    prefixOffsets.push(prefixOffsets[prefixOffsets.length - 1] + Math.max(0, height));
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
  flushBottomSpacing = false,
  onHeightChange,
  onMountedChange,
  layoutSignature,
  toolLayoutVersion,
  children,
}: {
  itemKey: string;
  message: ChatMessage;
  isLast: boolean;
  compactBottomSpacing?: boolean;
  flushBottomSpacing?: boolean;
  onHeightChange: (itemKey: string, height: number, signature: string, toolLayout: Map<string, boolean>) => void;
  onMountedChange: (itemKey: string, mounted: boolean) => void;
  layoutSignature: string;
  toolLayoutVersion: Map<string, boolean>;
  children: ReactNode;
}) {
  const itemRef = useRef<HTMLDivElement | null>(null);
  const layoutRef = useRef({ layoutSignature, toolLayoutVersion });
  layoutRef.current = { layoutSignature, toolLayoutVersion };
  useLayoutEffect(() => {
    const node = itemRef.current;
    if (node) onHeightChange(itemKey, node.getBoundingClientRect().height, layoutSignature, toolLayoutVersion);
  }, [itemKey, onHeightChange, layoutSignature, toolLayoutVersion]);

  useLayoutEffect(() => {
    const node = itemRef.current;
    if (!node) return undefined;
    onMountedChange(itemKey, true);

    const reportHeight = () => {
      onHeightChange(itemKey, node.getBoundingClientRect().height, layoutRef.current.layoutSignature, layoutRef.current.toolLayoutVersion);
    };

    reportHeight();
    if (typeof ResizeObserver === 'undefined') return () => onMountedChange(itemKey, false);

    let rafId: number | null = null;
    const throttledReport = () => {
      if (rafId != null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        reportHeight();
      });
    };

    const observer = new ResizeObserver(throttledReport);
    observer.observe(node);

    return () => {
      onMountedChange(itemKey, false);
      observer.disconnect();
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, [itemKey, onHeightChange, onMountedChange]);

  return (
    <div
      ref={itemRef}
      className={`chat-message ${isLast || flushBottomSpacing ? '' : compactBottomSpacing ? 'pb-2' : 'pb-4'}`}
      data-message-key={itemKey}
      data-message-timestamp={message.timestamp ? String(message.timestamp) : undefined}
    >
      {children}
    </div>
  );
}

function countCarriedMessagesBefore(
  messages: ChatMessage[],
  originalIndex: number,
): number {
  return messages
    .slice(0, originalIndex)
    .filter((message) => message.type === 'user' || message.type === 'assistant' || message.isToolUse)
    .length;
}

function countForkCarriedMessages(
  messages: ChatMessage[],
  originalIndex: number,
  message: ChatMessage,
): number {
  if (message.type !== 'assistant') {
    return message.type === 'user' ? countCarriedMessagesBefore(messages, originalIndex) : 0;
  }

  let forkTargetIndex = -1;
  for (let index = originalIndex; index >= 0; index -= 1) {
    if (messages[index]?.type === 'user') {
      forkTargetIndex = index;
      break;
    }
  }
  return countCarriedMessagesBefore(messages, forkTargetIndex >= 0 ? forkTargetIndex : originalIndex);
}

function isForkedChatSession(session: ProjectSession | null): boolean {
  return Boolean(
    session?.parentSessionId &&
    !isReadOnlySession(session),
  );
}

function MessagesPane({
  scrollContainerRef,
  showReturnToLatest = false,
  onResumeScroll,
  onPauseScroll,
  isLoadingSessionMessages,
  sessionLoadError,
  onRetrySessionLoad,
  chatMessages,
  sendingInputs = [],
  activityMessages = [],
  visibleMessages,
  isLoadingMoreMessages,
  historyLoadError = false,
  hasMoreMessages,
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
  showThinking,
  inlineThinking,
  setInput,
  isAssistantWorking = false,
  pendingPermissionRequests = [],
  sessionRuntimeState = 'synchronizing',
  activeRunId = null,
  workingStatus,
  sessionStore,
  onFork,
  onRegenerate,
  forkDisabled = false,
  forkParentSessionTitle = null,
}: MessagesPaneProps) {
  const { t } = useTranslation('chat');
  const historySentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const sentinel = historySentinelRef.current;
    const root = scrollContainerRef.current;
    if (!sentinel || !root || !hasMoreMessages || allMessagesLoaded || isLoadingMoreMessages || isLoadingSessionMessages
      || historyLoadError || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) loadEarlierMessages();
    }, { root, rootMargin: '300px 0px 0px', threshold: 0 });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [scrollContainerRef, hasMoreMessages, allMessagesLoaded, isLoadingMoreMessages, historyLoadError,
    loadEarlierMessages, chatMessages.length, isLoadingSessionMessages]);
  const waitingFor = pendingPermissionRequests.some(request => /^(ask_?user_?question)$/i.test(request.toolName))
    ? 'question' : pendingPermissionRequests.length ? 'approval' : null;
  const messageKeyMapRef = useRef<WeakMap<ChatMessage, string>>(new WeakMap());
  const generatedMessageKeyCounterRef = useRef(0);
  const measuredHeightsRef = useRef(new Map<string, { height: number; signature: string; toolLayout: Map<string, boolean> }>());
  const mountedItemKeys = useRef(new Set<string>());
  const heightVersionRafRef = useRef<number | null>(null);
  const [heightVersion, setHeightVersion] = useState(0);
  const [scrollViewport, setScrollViewport] = useState({ scrollTop: 0, height: 0 });
  const [expandedProcessRows, setExpandedProcessRows] = useState<Map<string, { expanded: boolean; defaultExpanded: boolean }>>(() => new Map());
  const [expandedToolSections, setExpandedToolSections] = useState<Map<string, boolean>>(() => new Map());
  const [openSubagentId, setOpenSubagentId] = useState<string | null>(null);

  const handleOpenSubagentDetail = useCallback((subagentId: string) => {
    setOpenSubagentId(subagentId);
  }, []);

  const sessionId = selectedSession?.id ?? null;
  const messageWindowScope = `${selectedProject?.fullPath || selectedProject?.name || 'no-project'}:${sessionId ?? 'new-session'}`;
  const projectPath = selectedProject?.fullPath || selectedProject?.path || undefined;

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

  const latestInputKey = useMemo(() => {
    for (let index = chatMessages.length - 1; index >= 0; index--) {
      const message = chatMessages[index];
      if (message.type !== 'user') continue;
      const turnId = message.turnId || message.runId;
      if (!turnId) return getMessageKey(message, index);
      // Persistence can replace the optimistic id, timestamp and attachment
      // text. The turn and user-input ordinal survive that reconciliation,
      // while a new steering message in the same run advances the ordinal.
      const inputCount = chatMessages.reduce((count, candidate) => count + Number(
        candidate.type === 'user' && (candidate.turnId || candidate.runId) === turnId,
      ), 0);
      return JSON.stringify([turnId, inputCount]);
    }
    return 'no-input';
  }, [chatMessages, getMessageKey]);
  // A new submission ends deliberate openings from the preceding turn. Reset
  // before committing children so no stale expanded frame flashes on screen.
  const disclosureEpoch = `${messageWindowScope}:${latestInputKey}:${sendingInputs.at(-1)?.id ?? ''}`;
  const [expansionEpoch, setExpansionEpoch] = useState(disclosureEpoch);
  if (expansionEpoch !== disclosureEpoch) {
    setExpansionEpoch(disclosureEpoch);
    setExpandedProcessRows(new Map());
    setExpandedToolSections(new Map());
  }

  const isToolSectionExpanded = useCallback((sectionKey: string, defaultExpanded = false) => (
    expandedToolSections.get(`${disclosureEpoch}:${sectionKey}`) ?? defaultExpanded
  ), [expandedToolSections, disclosureEpoch]);

  const handleToolSectionExpandedChange = useCallback((sectionKey: string, expanded: boolean) => {
    const key = `${disclosureEpoch}:${sectionKey}`;
    setExpandedToolSections((currentSections) => {
      if (currentSections.get(key) === expanded) {
        return currentSections;
      }
      const nextSections = new Map(currentSections);
      nextSections.set(key, expanded);
      return nextSections;
    });
  }, [disclosureEpoch]);

  const suggestedPrompts: string[] = [
    t('emptyChat.prompts.plan', { defaultValue: 'Plan a refactor for this project' }),
    t('emptyChat.prompts.summary', { defaultValue: 'Summarize recent changes' }),
    t('emptyChat.prompts.review', { defaultValue: 'Review the most recent file I touched' }),
  ];

  const isEmpty = !isLoadingSessionMessages && chatMessages.length === 0 && sendingInputs.length === 0;
  const hasSessionLoadError = Boolean(!isLoadingSessionMessages && sessionLoadError && chatMessages.length === 0);
  const isNewConversationEmpty = isEmpty && !selectedSession;
  const isExistingConversationEmpty = isEmpty && Boolean(selectedSession) && !hasSessionLoadError;
  const sessionIsReadOnly = isReadOnlySession(selectedSession);
  const liveActivities = useMemo(
    () => activityMessages.filter((message) => message.isAgentActivity),
    [activityMessages],
  );
  const subagentActivities = useMemo(
    () => liveActivities.filter(isSubagentActivity),
    [liveActivities],
  );
  const nonSubagentLiveActivities = useMemo(
    () => liveActivities.filter((activity) => !isSubagentActivity(activity)),
    [liveActivities],
  );
  const subagentActivityById = useMemo(() => {
    const byId = new Map<string, ChatMessage>();
    for (const activity of subagentActivities) {
      const subagentId = getSubagentActivityId(activity);
      if (subagentId) {
        byId.set(subagentId, activity);
      }
    }
    return byId;
  }, [subagentActivities]);
  const subagentThinkingByIdRef = useRef(new Map<string, string>());
  const subagentThinkingById = (() => {
    if (!sessionId || !sessionStore) {
      if (subagentThinkingByIdRef.current.size === 0) return subagentThinkingByIdRef.current;
      subagentThinkingByIdRef.current = new Map();
      return subagentThinkingByIdRef.current;
    }
    const prev = subagentThinkingByIdRef.current;
    let changed = false;
    const next = new Map<string, string>();
    for (const [subagentId, activity] of subagentActivityById) {
      const state = String(activity.state || '');
      if (['completed', 'failed', 'cancelled'].includes(state)) continue;
      const msgs = sessionStore.getSubagentDetailMessages?.(sessionId, subagentId) ?? [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.id.startsWith('__subagent_thinking_') && m.content?.trim()) {
          next.set(subagentId, m.content);
          if (prev.get(subagentId) !== m.content) changed = true;
          break;
        }
      }
    }
    if (!changed && prev.size === next.size) return prev;
    subagentThinkingByIdRef.current = next;
    return next;
  })();
  const openSubagentActivity = openSubagentId
    ? subagentActivityById.get(openSubagentId)
    : undefined;
  const sessionRequestParams = useMemo(
    () => getSessionRequestParams(selectedSession),
    [selectedSession],
  );
  const subagentDetail = useSubagentMessages(
    openSubagentId ? sessionId : null,
    openSubagentId,
    projectPath,
    sessionStore,
    openSubagentActivity?.state,
    sessionRequestParams,
  );
  const renderableMessages = useMemo(
    () => {
      const filtered = visibleMessages.filter((message) =>
        !message.isAgentActivity &&
        !isSubagentThinkingPlaceholder(message) &&
        !(message.isThinking && !showThinking)
      );
      return filtered;
    },
    [visibleMessages, showThinking],
  );
  const liveReplyKeys = useLiveReplyKeys(renderableMessages, isAssistantWorking, messageWindowScope);
  const { keys: presentedReplyKeys } = useMemo(() => ({
    scope: messageWindowScope, keys: new Set<string>(),
  }), [messageWindowScope]);
  const renderableMessageItems = useMemo(
    () => groupProcessIntervals(renderableMessages,
      buildRenderableMessageItems(renderableMessages, { isAssistantWorking }), isAssistantWorking),
    [isAssistantWorking, renderableMessages],
  );
  const processDefaults = useMemo(() => {
    const defaults = new Map<string, boolean>();
    for (const item of renderableMessageItems) {
      if (item.turnTrace) defaults.set(`${messageWindowScope}:${item.turnTrace.id}`, item.turnTrace.defaultExpanded);
      const group = item.processRun || item.beforeTurnProcess || item.afterTurnProcess;
      if (group) defaults.set(turnProcessKey(messageWindowScope, group), group.defaultExpanded);
    }
    return defaults;
  }, [renderableMessageItems, messageWindowScope]);
  const isProcessExpanded = useCallback((processKey: string, defaultExpanded = false) => {
    const choice = expandedProcessRows.get(`${disclosureEpoch}:${processKey}`);
    // A reply or settled batch closes openings made while work was live.
    // Reopening the closed group is a new choice and survives later deltas.
    if (choice?.expanded && choice.defaultExpanded && !defaultExpanded) return false;
    return choice?.expanded ?? (sendingInputs.length ? false : defaultExpanded);
  }, [expandedProcessRows, sendingInputs.length, disclosureEpoch]);
  const handleProcessExpandedChange = useCallback((processKey: string, expanded: boolean) => {
    const key = `${disclosureEpoch}:${processKey}`;
    const defaultExpanded = processDefaults.get(processKey) ?? false;
    setExpandedProcessRows(currentRows => {
      const current = currentRows.get(key);
      if (current?.expanded === expanded && current.defaultExpanded === defaultExpanded) return currentRows;
      const nextRows = new Map(currentRows);
      nextRows.set(key, { expanded, defaultExpanded });
      return nextRows;
    });
  }, [disclosureEpoch, processDefaults]);
  const keyedMessageItems = useMemo<KeyedRenderableMessageItem[]>(
    () => renderableMessageItems.map((item, index) => {
      const turnOpen = !item.processRun || item.processOutput || isProcessExpanded(turnProcessKey(messageWindowScope, item.processRun), item.processRun.defaultExpanded);
      const traceOpen = !item.turnTrace || isProcessExpanded(`${messageWindowScope}:${item.turnTrace.id}`, item.turnTrace.defaultExpanded);
      const chromeHeight = (item.beforeTurnProcess ? 34 : 0) + (item.afterTurnProcess ? 34 : 0)
        + (item.turnFiles?.visible && item.turnFiles.artifacts.length ? Math.min(item.turnFiles.artifacts.length, 3) * 64 + 34 : 0);
      const closedHeight = !turnOpen || (item.mediaArtifact && item.mediaExpanded === false) ? chromeHeight
        : !traceOpen ? chromeHeight + 32 : null;
      const version = (message: ChatMessage) => `${Boolean(message.isStreaming)}:${message.content?.length ?? 0}:${Boolean(message.toolResult)}:${typeof message.toolResult?.content === 'string' ? message.toolResult.content.length : 0}`;
      const layoutSignature = `${Boolean(turnOpen)}:${Boolean(traceOpen)}:${item.mediaExpanded}:${chromeHeight}:` +
        (closedHeight === null ? item.turnTrace ? item.turnTrace.items.map(child => version(child.message)).join('|') : version(item.message) : 'closed');
      return {
        ...item,
        // Message ids are only guaranteed to be unique inside one conversation.
        // Namespacing prevents a height measured in the previous session from
        // being reused by a same-id row in the next session.
        itemKey: `${messageWindowScope}:${getMessageKey(item.message, index)}`,
        renderIndex: index,
        estimatedHeight: estimateMessageItemHeight(item),
        layoutSignature,
        closedHeight,
      };
    }),
    [getMessageKey, messageWindowScope, renderableMessageItems, isProcessExpanded],
  );
  const lastUserMessageItemKey = useMemo(() => {
    for (let index = keyedMessageItems.length - 1; index >= 0; index -= 1) {
      if (keyedMessageItems[index].message.type === 'user') return keyedMessageItems[index].itemKey;
    }
    return null;
  }, [keyedMessageItems]);
  const measuredItemHeights = useMemo(() => {
    void heightVersion;
    return keyedMessageItems.map(item => {
      const record = measuredHeightsRef.current.get(item.itemKey);
      const mounted = mountedItemKeys.current.has(item.itemKey);
      if (!mounted && item.closedHeight !== null) return item.closedHeight;
      const measured = record && (mounted || (record.signature === item.layoutSignature && record.toolLayout === expandedToolSections)) ? record.height : undefined;
      const open = item.processOutput || (item.mediaArtifact && item.mediaExpanded !== false)
        || (item.processRun && isProcessExpanded(turnProcessKey(messageWindowScope, item.processRun), item.processRun.defaultExpanded));
      const hasFiles = item.turnFiles?.visible && item.turnFiles.artifacts.length > 0;
      // A previously hidden work seat can now own a visible file footer.
      return (open || hasFiles) && (measured ?? item.estimatedHeight) === 0
        ? hasFiles ? Math.max(50, item.estimatedHeight) : 50
        : measured ?? item.estimatedHeight;
    });
  }, [heightVersion, keyedMessageItems, isProcessExpanded, messageWindowScope, expandedToolSections]);
  const shouldVirtualizeMessages = useMemo(() => (
    keyedMessageItems.length > MESSAGE_VIRTUALIZATION_THRESHOLD
    // A modest number of long answers can be heavier than hundreds of short
    // messages. Keep small conversations intact for ordinary text selection.
    || (keyedMessageItems.length > 40
      && keyedMessageItems.reduce((height, item) => height + item.estimatedHeight, 0) > 20_000)
  ), [keyedMessageItems]);
  // Keep the reader's row mounted when prepending history changes the virtual
  // offsets. The shared scroll controller then corrects any measured remainder.
  const virtualSnapshotRef = useRef<{ scope: string; keys: string[]; heights: number[] } | null>(null);
  const previousVirtual = virtualSnapshotRef.current;
  const readingKey = scrollContainerRef.current?.dataset.readingAnchorKey;
  const previousReadingIndex = readingKey && previousVirtual?.scope === messageWindowScope
    ? previousVirtual.keys.indexOf(readingKey) : -1;
  const nextReadingIndex = readingKey ? keyedMessageItems.findIndex((item) => item.itemKey === readingKey) : -1;
  const virtualAnchorDelta = shouldVirtualizeMessages && previousReadingIndex >= 0 && nextReadingIndex >= 0 && previousVirtual
    ? measuredItemHeights.slice(0, nextReadingIndex).reduce((sum, height) => sum + height, 0)
      - previousVirtual.heights.slice(0, previousReadingIndex).reduce((sum, height) => sum + height, 0)
    : 0;
  const projectedScrollTop = virtualAnchorDelta
    ? (scrollContainerRef.current?.scrollTop ?? scrollViewport.scrollTop) + virtualAnchorDelta
    : scrollViewport.scrollTop;
  useLayoutEffect(() => {
    virtualSnapshotRef.current = {
      scope: messageWindowScope,
      keys: keyedMessageItems.map((item) => item.itemKey),
      heights: measuredItemHeights,
    };
    if (virtualAnchorDelta && scrollContainerRef.current) {
      adjustScrollLayout(scrollContainerRef.current, projectedScrollTop);
      setScrollViewport((current) => ({ ...current, scrollTop: scrollContainerRef.current!.scrollTop }));
    }
    if (shouldVirtualizeMessages && scrollContainerRef.current) notifyScrollLayout(scrollContainerRef.current);
  }, [keyedMessageItems, measuredItemHeights, messageWindowScope, projectedScrollTop, scrollContainerRef, virtualAnchorDelta, shouldVirtualizeMessages]);
  const virtualWindow = useMemo(
    () => shouldVirtualizeMessages
      ? getVirtualMessageWindow(
          measuredItemHeights,
          projectedScrollTop,
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
    [keyedMessageItems.length, measuredItemHeights, scrollViewport.height, projectedScrollTop, shouldVirtualizeMessages],
  );
  const windowedMessageItems = shouldVirtualizeMessages
    ? keyedMessageItems.slice(virtualWindow.startIndex, virtualWindow.endIndex)
    : keyedMessageItems;
  const latestUserRenderIndex = useMemo(() => {
    for (let index = keyedMessageItems.length - 1; index >= 0; index -= 1) {
      if (keyedMessageItems[index].message.type === 'user') return index;
    }
    return -1;
  }, [keyedMessageItems]);
  const shouldReserveResponseSpace = shouldKeepChatResponseReservedSpace(
    latestUserRenderIndex,
    isAssistantWorking,
  );
  const reservedSpaceTarget = getChatResponseReserveTarget(scrollViewport.height);
  const liveProcessHeaderIndex = useMemo(() => {
    if (!isAssistantWorking) return -1;
    if (latestUserRenderIndex >= 0) {
      return Math.min(latestUserRenderIndex + 1, keyedMessageItems.length);
    }
    return keyedMessageItems.length > 0 ? 0 : -1;
  }, [isAssistantWorking, keyedMessageItems.length, latestUserRenderIndex]);
  const openSubagentContainerItem = openSubagentId
    ? keyedMessageItems.find((item) => (
        item.message.isSubagentContainer && item.message.subagentId === openSubagentId
      ))
    : undefined;
  const isOpenSubagentHistorical = openSubagentContainerItem
    ? isHistoricalSubagentItem(
        openSubagentContainerItem,
        activeRunId,
        sessionRuntimeState,
        liveProcessHeaderIndex,
      )
    : false;
  const isOpenSubagentRunning = Boolean(
    !isOpenSubagentHistorical &&
      sessionRuntimeState !== 'inactive' &&
      openSubagentActivity &&
      !['completed', 'failed', 'cancelled'].includes(String(openSubagentActivity.state || '')),
  );
  const currentTurnMessages = useMemo(() => {
    const userIndex = visibleMessages.reduce((last, message, index) => message.type === 'user' ? index : last, -1);
    return visibleMessages.slice(Math.max(0, userIndex));
  }, [visibleMessages]);
  const hasStreamingAssistantContent = currentTurnMessages.some(message => message.type === 'assistant'
    && !message.isThinking && !message.isToolUse && message.isStreaming && Boolean(message.content?.trim()));
  const hasPendingToolUse = currentTurnMessages.some(isPendingToolUseMessage);
  const currentToolActivities = useMemo(() => nonSubagentLiveActivities.filter((activity) => {
    if (activity.phase === 'file_input') return false;
    if (activeRunId && activity.runId && activity.runId !== activeRunId) return false;
    const start = currentTurnMessages[0]?.timestamp;
    if (!activity.runId && start && new Date(activity.timestamp).getTime() < new Date(start).getTime()) return false;
    if (activity.toolId) {
      const tool = currentTurnMessages.find((message) => (message.toolId || message.toolCallId) === activity.toolId);
      return Boolean(tool && isPendingToolUseMessage(tool));
    }
    return activity.phase !== 'tool';
  }), [activeRunId, currentTurnMessages, nonSubagentLiveActivities]);
  const filePreparations = useMemo(() => isAssistantWorking
    ? pendingFileInputs(nonSubagentLiveActivities, currentTurnMessages, activeRunId) : [],
  [isAssistantWorking, nonSubagentLiveActivities, currentTurnMessages, activeRunId]);
  const currentRunSubagentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const item of keyedMessageItems) {
      if (
        item.message.isSubagentContainer
        && item.message.subagentId
        && !isHistoricalSubagentItem(
          item,
          activeRunId,
          sessionRuntimeState,
          liveProcessHeaderIndex,
        )
      ) {
        ids.add(item.message.subagentId);
      }
    }
    return ids;
  }, [activeRunId, keyedMessageItems, liveProcessHeaderIndex, sessionRuntimeState]);
  const runningSubagentActivity = useMemo(() => {
    if (sessionRuntimeState === 'inactive') return null;
    return [...subagentActivities].reverse().find((activity) => {
      if (!isRunningActivity(activity)) return false;
      if (!activeRunId) return true;
      if (activity.parentRunId) return activity.parentRunId === activeRunId;
      const subagentId = getSubagentActivityId(activity);
      return Boolean(subagentId && currentRunSubagentIds.has(subagentId));
    }) || null;
  }, [activeRunId, currentRunSubagentIds, sessionRuntimeState, subagentActivities]);
  const liveThinkingMessage = useMemo(() => {
    if (!isAssistantWorking) {
      return null;
    }
    for (let i = visibleMessages.length - 1; i >= 0; i--) {
      const msg = visibleMessages[i];
      if (isStreamingThinkingMessage(msg) && typeof msg.content === 'string' && msg.content.trim()) {
        return msg;
      }
      if (msg.type === 'user') break;
    }
    return null;
  }, [isAssistantWorking, visibleMessages]);
  const liveThinkingContent = liveThinkingMessage?.content || null;
  const liveStatusStep = useMemo<ProcessTraceStep>(() => {
    if (waitingFor) return {
      id: `live-waiting-${waitingFor}`,
      title: t(waitingFor === 'question' ? 'working.waitingForAnswer' : 'working.waitingForApproval', { defaultValue: waitingFor === 'question' ? 'Waiting for your answer' : 'Waiting for approval' }),
      phase: 'permission', state: 'waiting', severity: 'warning',
    };
    if (liveThinkingContent) {
      return {
        id: 'live-thinking',
        title: t('working.thinking', { defaultValue: 'Thinking...' }),
        phase: showThinking ? 'thinking' : 'generation',
        state: 'running',
      };
    }
    if (runningSubagentActivity) {
      return {
        id: runningSubagentActivity.activityId || runningSubagentActivity.id || 'live-subagent-waiting',
        title: t('working.waitingForSubagent', { defaultValue: 'Waiting for subagent' }),
        phase: 'subagent',
        state: 'running',
        toolName: 'agent',
      };
    }
    return getLiveStatusStep(currentToolActivities, workingStatus, hasPendingToolUse, t);
  }, [
    hasPendingToolUse,
    currentToolActivities,
    runningSubagentActivity,
    liveThinkingContent,
    showThinking,
    t,
    workingStatus,
    waitingFor,
  ]);
  const hasRunningProcessGroup = renderableMessageItems.some(item => item.turnTrace?.isLive);
  const hasPendingProcessWork = currentTurnMessages.some(isPendingProcessMessage) || Boolean(runningSubagentActivity);
  const thinkingHasOwnStatus = Boolean(!waitingFor && showThinking && liveThinkingMessage);
  const shouldRenderBottomLiveStatus = isAssistantWorking && !waitingFor && !thinkingHasOwnStatus
    && !hasStreamingAssistantContent && !filePreparations.length && (!hasRunningProcessGroup || !hasPendingProcessWork);

  const bumpHeightVersion = useCallback(() => {
    if (heightVersionRafRef.current !== null) return;
    heightVersionRafRef.current = requestAnimationFrame(() => {
      heightVersionRafRef.current = null;
      setHeightVersion((version) => version + 1);
    });
  }, []);

  const handleMountedItemChange = useCallback((itemKey: string, mounted: boolean) => {
    if (mounted) mountedItemKeys.current.add(itemKey); else mountedItemKeys.current.delete(itemKey);
  }, []);
  const handleMeasuredItemHeight = useCallback((itemKey: string, height: number, signature: string, toolLayout: Map<string, boolean>) => {
    const normalizedHeight = Math.max(0, Math.ceil(height));
    const current = measuredHeightsRef.current.get(itemKey);
    const currentHeight = current?.height;
    if (current?.signature === signature && current.toolLayout === toolLayout && currentHeight !== undefined && (currentHeight === normalizedHeight || (currentHeight > 0 && normalizedHeight > 0 && Math.abs(currentHeight - normalizedHeight) < 2))) {
      return;
    }

    measuredHeightsRef.current.set(itemKey, { height: normalizedHeight, signature, toolLayout });
    bumpHeightVersion();
  }, [bumpHeightVersion]);

  useEffect(() => () => {
    if (heightVersionRafRef.current !== null) {
      cancelAnimationFrame(heightVersionRafRef.current);
    }
  }, []);

  useLayoutEffect(() => {
    // MessagesPane stays mounted while the selected conversation changes. Its
    // virtual height/viewport caches must not survive that boundary: the DOM may
    // clamp scrollTop while no scroll event is emitted, leaving React to render
    // a window from the previous conversation behind a large top spacer.
    messageKeyMapRef.current = new WeakMap();
    generatedMessageKeyCounterRef.current = 0;
    measuredHeightsRef.current.clear();
    setHeightVersion((version) => version + 1);

    const container = scrollContainerRef.current;
    setScrollViewport({
      scrollTop: container?.scrollTop ?? 0,
      height: container?.clientHeight ?? 0,
    });
  }, [messageWindowScope, scrollContainerRef]);

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
  }, [messageWindowScope, scrollContainerRef]);

  useLayoutEffect(() => {
    // Programmatic scroll restoration and browser scroll clamping do not
    // consistently dispatch a scroll event. Re-read the actual element after
    // the projected message list changes so the virtual window cannot drift.
    const container = scrollContainerRef.current;
    if (!container) return;
    const nextScrollTop = container.scrollTop;
    const nextHeight = container.clientHeight;
    setScrollViewport((current) => (
      current.scrollTop === nextScrollTop && current.height === nextHeight
        ? current
        : { scrollTop: nextScrollTop, height: nextHeight }
    ));
  }, [keyedMessageItems, messageWindowScope, scrollContainerRef]);

  const renderMessageItem = useCallback((item: KeyedRenderableMessageItem) => {
    const previousMessage = item.renderIndex > 0 ? keyedMessageItems[item.renderIndex - 1].message : null;
    const nextMessage = item.renderIndex < keyedMessageItems.length - 1
      ? keyedMessageItems[item.renderIndex + 1].message
      : null;
    const isLast = !isAssistantWorking && item.renderIndex === keyedMessageItems.length - 1;
    const forkCarriedMessageCount = countForkCarriedMessages(
      renderableMessages,
      item.originalIndex,
      item.message,
    );
    const messageSessionRuntimeState = isHistoricalSubagentItem(
      item,
      activeRunId,
      sessionRuntimeState,
      liveProcessHeaderIndex,
    )
      ? 'inactive'
      : sessionRuntimeState;
    const showAssistantActions = (() => {
      if (!isRenderableAssistantProse(item.message)) {
        return false;
      }
      if (isAssistantWorking && item.renderIndex >= liveProcessHeaderIndex) {
        return false;
      }

      for (let index = item.renderIndex + 1; index < keyedMessageItems.length; index += 1) {
        const candidate = keyedMessageItems[index]?.message;
        if (!candidate) {
          continue;
        }
        if (candidate.type === 'user') {
          break;
        }
        if (candidate.type === 'error') {
          return false;
        }
        if (isRenderableAssistantProse(candidate)) {
          return false;
        }
      }
      return true;
    })();

    const renderRow = (rowItem: RenderableMessageItem, inTrace = false) => rowItem.message.isCompactBoundary ? (
      <CompactProcessRow message={rowItem.message} running={Boolean(item.turnTrace?.isLive)} />
    ) : rowItem.mediaArtifact ? (
      <GeneratedMediaCard message={rowItem.message} running={isAssistantWorking} visible={rowItem.mediaExpanded} />
    ) : (
      <MessageRow
        key={rowItem.message.isThinking || rowItem.message.isToolUse || rowItem.message.isSubagentContainer ? disclosureEpoch : undefined}
        message={rowItem.message}
        animateTextOnMount={liveReplyKeys.has(getIntrinsicMessageKey(rowItem.message) || "")}
        presentedReplyKeys={presentedReplyKeys}
        prevMessage={previousMessage}
        nextMessage={nextMessage}
        beforeProcessAttachments={rowItem.beforeProcessAttachments}
        afterProcessAttachments={rowItem.afterProcessAttachments}
        provider={provider}
        selectedProject={selectedProject}
        createDiff={createDiff}
        onFileOpen={onFileOpen}
        onShowSettings={onShowSettings}
        onGrantSessionToolPermission={onGrantSessionToolPermission}
        autoExpandTools={Boolean(autoExpandTools && item.renderIndex > latestUserRenderIndex && !sendingInputs.length)}
        showThinking={showThinking}
        inlineThinking={inlineThinking}
        isProcessExpanded={isProcessExpanded}
        onProcessExpandedChange={handleProcessExpandedChange}
        isToolSectionExpanded={isToolSectionExpanded}
        onToolSectionExpandedChange={handleToolSectionExpandedChange}
        onOpenSubagentDetail={handleOpenSubagentDetail}
        subagentActivityById={subagentActivityById}
        subagentThinkingById={subagentThinkingById}
        isSessionRunning={isAssistantWorking && (!inTrace || Boolean(item.turnTrace?.isLive))}
        sessionRuntimeState={inTrace && !item.turnTrace?.isLive ? 'inactive' : messageSessionRuntimeState}
        onFork={onFork}
        forkCarriedMessageCount={forkCarriedMessageCount}
        forkDisabled={forkDisabled}
        showAssistantActions={!inTrace && showAssistantActions}
        canEdit={Boolean(
          onRegenerate
          && !sessionIsReadOnly
          && !inTrace
          && item.itemKey === lastUserMessageItemKey
        )}
        onRegenerate={onRegenerate}
      />
    );

    const rowContent = item.turnTrace ? (
            <ProcessBlock trace={item.turnTrace}
              expanded={isProcessExpanded(`${messageWindowScope}:${item.turnTrace.id}`, item.turnTrace.defaultExpanded)}
              onExpandedChange={expanded => handleProcessExpandedChange(`${messageWindowScope}:${item.turnTrace!.id}`, expanded)}>
              {item.turnTrace.items.map(child => {
                const childKey = `${messageWindowScope}:${getMessageKey(child.message, child.originalIndex)}`;
                return <div key={childKey} className="chat-message" data-message-key={childKey}>{renderRow(child, true)}</div>;
              })}
              {item.turnTrace.isLive && filePreparations.map(activity => <FileInputStatus key={activity.activityId} activity={activity} />)}
            </ProcessBlock>
          ) : renderRow(item);
    const renderTurnHeader = (group: TurnProcessGroup) => <TurnProcessHeader group={group} scope={messageWindowScope}
      expanded={isProcessExpanded(turnProcessKey(messageWindowScope, group), group.defaultExpanded)}
      onExpandedChange={expanded => handleProcessExpandedChange(turnProcessKey(messageWindowScope, group), expanded)}
      waiting={group.isRunning && Boolean(waitingFor)} />;

    return (
      <Fragment key={item.itemKey}>
        <MeasuredMessageItem
          itemKey={item.itemKey}
          message={item.message}
          isLast={isLast}
          compactBottomSpacing={Boolean(item.afterTurnProcess || item.turnTrace || item.message.isThinking || item.message.isToolUse)}
          flushBottomSpacing={Boolean(item.processRun || item.mediaArtifact)}
          onHeightChange={handleMeasuredItemHeight}
          onMountedChange={handleMountedItemChange}
          layoutSignature={item.layoutSignature}
          toolLayoutVersion={expandedToolSections}
        >
          {item.beforeTurnProcess ? renderTurnHeader(item.beforeTurnProcess) : null}
          {item.processRun ? <TurnProcessRegion group={item.processRun} scope={messageWindowScope}
            member={getTurnProcessMemberId(item)} output={item.processOutput} prose={isRenderableAssistantProse(item.message)}
            expanded={Boolean(item.processOutput || isProcessExpanded(turnProcessKey(messageWindowScope, item.processRun), item.processRun.defaultExpanded))}>
            {rowContent}
          </TurnProcessRegion> : rowContent}
          {item.afterTurnProcess ? renderTurnHeader(item.afterTurnProcess) : null}
          {item.turnFiles && !sendingInputs.length ? <TurnFileFooter files={item.turnFiles} project={selectedProject} onBrowse={onFileOpen} /> : null}
        </MeasuredMessageItem>
      </Fragment>
    );
  }, [
    messageWindowScope,
    disclosureEpoch,
    sendingInputs.length,
    latestUserRenderIndex,
    getMessageKey,
    autoExpandTools,
    activeRunId,
    createDiff,
    handleMeasuredItemHeight,
    handleMountedItemChange,
    expandedToolSections,
    handleOpenSubagentDetail,
    handleProcessExpandedChange,
    handleToolSectionExpandedChange,
    inlineThinking,
    isProcessExpanded,
    isToolSectionExpanded,
    isAssistantWorking,
    sessionRuntimeState,
    keyedMessageItems,
    liveReplyKeys,
    presentedReplyKeys,
    filePreparations,
    renderableMessages,
    liveProcessHeaderIndex,
    waitingFor,
    onFileOpen,
    onFork,
    onRegenerate,
    forkDisabled,
    lastUserMessageItemKey,
    sessionIsReadOnly,
    onGrantSessionToolPermission,
    onShowSettings,
    provider,
    selectedProject,
    showThinking,
    subagentActivityById,
    subagentThinkingById,
  ]);

  const keyedMessagesForSearch = useMemo<SearchableChatMessageInput[]>(() => {
    return keyedMessageItems.filter(item => !item.mediaArtifact).flatMap((item) => (
      item.turnTrace ? item.turnTrace.items.map((child) => ({
        message: child.message,
        messageKey: `${messageWindowScope}:${getMessageKey(child.message, child.originalIndex)}`,
        messageIndex: item.renderIndex,
      })) : [{ message: item.message, messageKey: item.itemKey, messageIndex: item.renderIndex }]
    ));
  }, [keyedMessageItems, messageWindowScope, getMessageKey]);

  const revealSearchTrace = useCallback((match: { messageIndex: number; messageKey: string }) => {
    onPauseScroll?.(match.messageKey);
    const item = keyedMessageItems[match.messageIndex];
    if (item?.processRun) handleProcessExpandedChange(turnProcessKey(messageWindowScope, item.processRun), true);
    const trace = item?.turnTrace;
    if (trace) handleProcessExpandedChange(`${messageWindowScope}:${trace.id}`, true);
  }, [onPauseScroll, keyedMessageItems, messageWindowScope, handleProcessExpandedChange]);
  const chatHistorySearch = useChatHistorySearch({
    scrollContainerRef,
    historyReady: !isLoadingSessionMessages,
    keyedMessages: keyedMessagesForSearch,
    measuredItemHeights,
    allMessagesLoaded,
    hasMoreMessages,
    loadAllMessages,
    sessionId,
    requestIdentity: getSessionRequestIdentity(selectedProject, selectedSession),
    renderWindowKey: `${virtualWindow.startIndex}:${virtualWindow.endIndex}`,
    onNavigate: revealSearchTrace,
  });
  useRegisterChatHistorySearchControls(chatHistorySearch);
  const [hasLayoutWarning, setHasLayoutWarning] = useState(false);
  useEffect(() => {
    setHasLayoutWarning(false);
    if (isAssistantWorking || isLoadingSessionMessages || keyedMessageItems.length === 0) return;
    // Check after completion/refresh layout has settled. Never interpret a
    // hidden tab/panel, or an ordinary empty conversation, as a rendering fault.
    const timer = window.setTimeout(() => {
      const node = scrollContainerRef.current;
      if (!node || node.clientHeight <= 0 || !node.getClientRects().length
        || document.visibilityState === 'hidden') return;
      const viewport = node.getBoundingClientRect();
      const hasVisibleRow = Array.from(node.querySelectorAll<HTMLElement>('[data-message-key]'))
        .some((row) => {
          const rect = row.getBoundingClientRect();
          return rect.height > 0 && rect.bottom > viewport.top && rect.top < viewport.bottom;
        });
      if (hasVisibleRow) return;
      recordUiDiagnostic('chat-empty-viewport', {
        messages: chatMessages.length, renderItems: keyedMessageItems.length,
        windowStart: virtualWindow.startIndex, windowEnd: virtualWindow.endIndex,
        scrollTop: node.scrollTop, scrollHeight: node.scrollHeight,
        viewportHeight: node.clientHeight, virtualized: shouldVirtualizeMessages,
      });
      setHasLayoutWarning(true);
    }, 800);
    return () => window.clearTimeout(timer);
  }, [isAssistantWorking, isLoadingSessionMessages, keyedMessageItems, chatMessages.length,
    scrollContainerRef, virtualWindow.startIndex, virtualWindow.endIndex, shouldVirtualizeMessages]);


  return (
    <div className="conversation-pane relative min-h-0 flex-1 overflow-hidden">
      {isLoadingMoreMessages && !isLoadingAllMessages && !allMessagesLoaded ? (
        <div role="status" className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
          <span className="rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground shadow-sm">
            {t('session.loading.olderMessages', { defaultValue: 'Loading older messages...' })}
          </span>
        </div>
      ) : null}
      {hasLayoutWarning ? (
        <div role="alert" className="absolute inset-x-4 top-4 z-20 mx-auto flex max-w-xl items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <span>{t('common:uiText.chatLayoutError')}</span>
          <button type="button" onClick={reloadUi} className="shrink-0 rounded px-2 py-1 underline underline-offset-2 hover:bg-amber-100 dark:hover:bg-amber-900">
            {t('common:uiText.reloadInterface')}
          </button>
        </div>
      ) : null}
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
          historyError={chatHistorySearch.historyError}
          isLoadingHistory={chatHistorySearch.isLoadingHistory}
          onRetryHistory={chatHistorySearch.retryHistory}
        />
      ) : null}
      <div
        ref={scrollContainerRef}
        data-chat-search-surface
        data-stream-scroll-viewport
        style={{ overflowAnchor: 'none' }}
        className="chat-panel-scrollbar h-full overflow-y-auto overflow-x-hidden bg-white dark:bg-neutral-950"
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
      ) : isExistingConversationEmpty && isForkedChatSession(selectedSession) ? (
        <div className="mx-auto flex h-full max-w-[720px] flex-col items-center justify-center gap-3 px-6 py-10 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-100 dark:bg-neutral-800">
            <GitBranch className="h-5 w-5 text-neutral-500 dark:text-neutral-400" strokeWidth={2} />
          </div>
          <div className="text-[15px] font-medium text-neutral-900 dark:text-neutral-100">
            {t('fork.emptyTitle', { defaultValue: 'New branch ready' })}
          </div>
          <div className="max-w-[520px] text-[13px] leading-5 text-neutral-500 dark:text-neutral-400">
            {t('fork.emptyDescription', {
              parent: forkParentSessionTitle || selectedSession?.parentSessionId || '',
              defaultValue:
                'This branch starts from the beginning of the original conversation. The forked prompt is waiting in the composer — edit it and send to continue here.',
            })}
          </div>
        </div>
      ) : isExistingConversationEmpty ? (
        <div className="mx-auto flex h-full max-w-[720px] flex-col items-center justify-center gap-2 px-6 py-10 text-center">
          <div className="text-[15px] font-medium text-neutral-900 dark:text-neutral-100">
            {sessionIsReadOnly
              ? t('emptyChat.readonlyTranscriptTitle', {
                  defaultValue: 'No displayable messages in this read-only transcript',
                })
              : t('emptyChat.emptySessionTitle', {
                  defaultValue: 'No displayable messages in this conversation',
                })}
          </div>
          <div className="max-w-[520px] text-[13px] leading-5 text-neutral-500 dark:text-neutral-400">
            {sessionIsReadOnly
              ? t('emptyChat.readonlyTranscriptDescription', {
                  defaultValue:
                    'This read-only transcript only contains records the chat view cannot display.',
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
          data-chat-scroll-content
          onClickCapture={event => {
            const trigger = expandingDisclosure(event.target);
            if (!trigger) return;
            onPauseScroll?.(trigger.closest<HTMLElement>('[data-message-key]')?.dataset.messageKey);
            disclosureAncestorKeys(trigger, messageWindowScope).forEach(key => handleProcessExpandedChange(key, true));
          }}
          data-virtualized-messages={shouldVirtualizeMessages ? 'true' : undefined}
          data-rendered-message-count={windowedMessageItems.length}
          data-total-message-count={keyedMessageItems.length}
        >
            <div ref={historySentinelRef} data-history-sentinel={hasMoreMessages && !allMessagesLoaded ? 'true' : undefined} className="min-h-px">
              {historyLoadError ? <div role="alert" className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground">
                {t('session.messages.loadFailed', { defaultValue: 'Unable to load earlier messages.' })}
                <button type="button" onClick={loadEarlierMessages} className="hover-brand-text underline">
                  {t('session.retryLoad', { defaultValue: 'Retry' })}
                </button>
              </div> : null}
            </div>

          {isForkedChatSession(selectedSession) ? (
            <div className="mb-6 flex items-center gap-2 rounded-xl border border-neutral-200 bg-neutral-50 px-3 py-2 text-[12px] text-neutral-600 dark:border-neutral-800 dark:bg-neutral-900/60 dark:text-neutral-300">
              <GitBranch className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
              <span>
                {t('fork.banner', {
                  parent: forkParentSessionTitle || selectedSession?.parentSessionId || '',
                  defaultValue: `Forked from ${forkParentSessionTitle || selectedSession?.parentSessionId || 'parent session'}`,
                })}
              </span>
            </div>
          ) : null}

          {shouldVirtualizeMessages && virtualWindow.topPadding > 0 ? (
            <div aria-hidden="true" style={{ height: virtualWindow.topPadding }} />
          ) : null}

          {windowedMessageItems
            .filter((item) => latestUserRenderIndex < 0 || item.renderIndex <= latestUserRenderIndex)
            .map(renderMessageItem)}

          <div
            className="chat-current-turn-reserve motion-safe:transition-[min-height] motion-safe:duration-200"
            data-chat-response-reserved-space={shouldReserveResponseSpace ? 'true' : undefined}
            style={{ minHeight: shouldReserveResponseSpace && sendingInputs.length === 0 ? reservedSpaceTarget : 0 }}
          >
            {latestUserRenderIndex >= 0
              ? windowedMessageItems
                  .filter((item) => item.renderIndex > latestUserRenderIndex)
                  .map(renderMessageItem)
              : null}

            {shouldVirtualizeMessages && virtualWindow.bottomPadding > 0 ? (
              <div aria-hidden="true" style={{ height: virtualWindow.bottomPadding }} />
            ) : null}

            {!hasRunningProcessGroup && filePreparations.map(activity => <div key={activity.activityId} className="pb-2"><FileInputStatus activity={activity} /></div>)}
            {shouldRenderBottomLiveStatus ? <ProcessLiveStatus step={liveStatusStep} /> : null}
          </div>
          <SendingMessages items={sendingInputs} />
        </div>
      )}

      <AssistantReplyQuoteAction />
      {openSubagentId ? (
        <SubagentDetailModal
          subagentId={openSubagentId}
          messages={subagentDetail.messages}
          isLoading={subagentDetail.isLoading}
          error={subagentDetail.error}
          provider={provider}
          selectedProject={selectedProject}
          createDiff={createDiff}
          onFileOpen={onFileOpen}
          showThinking={showThinking}
          isRunning={isOpenSubagentRunning}
          onClose={() => setOpenSubagentId(null)}
        />
      ) : null}
      </div>
      <ConversationTurnNav key={messageWindowScope} messages={chatMessages} items={keyedMessageItems}
        heights={measuredItemHeights} scrollRef={scrollContainerRef} onPause={onPauseScroll}
        loadAll={loadAllMessages} hasMore={hasMoreMessages || chatMessages.length > visibleMessages.length}
        loading={isLoadingAllMessages || isLoadingMoreMessages} />
      {showReturnToLatest && onResumeScroll ? (
        <button
          type="button"
          onClick={onResumeScroll}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-3 py-2 text-xs text-neutral-700 shadow-md dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
        >
          <ArrowDown className="h-3.5 w-3.5" aria-hidden="true" />
          {t('session.scroll.returnToLatest', { defaultValue: 'Back to latest' })}
        </button>
      ) : null}
    </div>
  );
}

export default memo(MessagesPane);

function isSubagentActivity(activity: ChatMessage): boolean {
  const activityId = String(activity.activityId || activity.runId || '');
  return activity.phase === 'subagent' || activityId.startsWith('subagent:');
}

function getSubagentActivityId(activity: ChatMessage): string {
  const activityId = String(activity.activityId || activity.runId || '');
  return activityId.startsWith('subagent:')
    ? activityId.slice('subagent:'.length)
    : '';
}

function isRunningActivity(activity: ChatMessage): boolean {
  return !['completed', 'failed', 'cancelled'].includes(String(activity.state || 'running'));
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
    toolId: activity.toolId,
  };
}

function getLiveStatusStep(
  activities: ChatMessage[],
  workingStatus: ClaudeWorkStatus | PilotDeckWorkStatus | null | undefined,
  hasPendingToolUse: boolean,
  t: (key: string, options?: Record<string, unknown>) => string,
): ProcessTraceStep {
  const retryProgress = (workingStatus as any)?.retryProgress;
  if (retryProgress) {
    const parts: string[] = [];
    const retryReasons = ['network_error', 'server_error', 'continuation', 'rate_limit', 'overloaded', 'zero_usage'];
    if (retryReasons.includes(retryProgress.reason)) parts.push(t(`working.retryReasons.${retryProgress.reason}`));
    if (retryProgress.provider) parts.push(retryProgress.provider);
    if (retryProgress.model) parts.push(retryProgress.model);
    const delayStr = retryProgress.delayMs ? t('working.retryDelay', { seconds: Math.max(1, Math.ceil(retryProgress.delayMs / 1000)) }) : '';
    return {
      id: 'live-retry',
      title: t('working.retrying', {
        defaultValue: 'Reconnecting {{attempt}}/{{max}}{{delay}}',
        attempt: retryProgress.attempt,
        max: retryProgress.maxAttempts,
        delay: delayStr,
      }),
      detail: parts.join(' · '),
      phase: 'retry',
      state: 'running',
      severity: 'warning',
    };
  }

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
  if (hasPendingToolUse) {
    return {
      id: 'live-tool-exec',
      title: t('working.executingTool', { defaultValue: 'Running tool...' }),
      phase: 'tool',
      state: 'running',
    };
  }
  if (rawStatus.includes('model_request_started')) {
    return {
      id: 'live-model-call',
      title: t('working.callingModel', { defaultValue: 'Calling model...' }),
      phase: 'generation',
      state: 'running',
    };
  }
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

  return {
    id: 'live-model-call',
    title: t('working.callingModel', { defaultValue: 'Calling model...' }),
    phase: 'generation',
    state: 'running',
  };
}
