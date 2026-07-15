import { Fragment, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatMessage, ChatRunMode } from '../chat/types/types';
import type { Project, SessionProvider } from '../../types/app';
import MessageRowV2 from './MessageRowV2';
import { ProcessLiveStatus, StreamingThinkingPreview, type ProcessTraceStep } from './ProcessTrace';
import {
  buildRenderableMessageItems,
  getLiveProcessGroups,
  getLiveProcessGroupStep,
  getProcessToolKind,
  shouldRenderLiveProcessGroup,
  splitLiveProcessGroupDetailMessages,
  type LiveProcessGroup,
  type ProcessAttachment,
  type RenderableMessageItem,
} from './processGrouping';

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
    message.id ||
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
  const [expandedProcessRows, setExpandedProcessRows] = useState<Map<string, boolean>>(() => new Map());

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
    const lastToolMsg = [...messages].reverse().find(
      (m) => m.isToolUse && m.toolName && !m.isSubagentContainer,
    );
    if (lastToolMsg) {
      const kind = getProcessToolKind(lastToolMsg);
      const toolKindTitleMap: Record<string, string> = {
        search: t('process.live.runningSearch', { defaultValue: 'Searching' }),
        edit: t('process.live.runningEdit', { defaultValue: 'Editing file' }),
        read: t('process.live.runningRead', { defaultValue: 'Reading file' }),
        command: t('process.live.runningCommand', { defaultValue: 'Running command' }),
      };
      if (toolKindTitleMap[kind]) {
        return {
          id: 'subagent-detail-thinking',
          title: toolKindTitleMap[kind],
          phase: kind === 'search' ? 'rag' : 'tool',
          state: 'running' as const,
        };
      }
    }
    return {
      id: 'subagent-detail-thinking',
      title: t('subagent.status.thinking', { defaultValue: 'Thinking' }),
      phase: 'thinking',
      state: 'running' as const,
    };
  }, [messages, t]);

  const renderableMessages = useMemo(
    () => {
      const result = messages
        .filter((message) =>
          !message.isAgentActivity &&
          !isStreamingSubagentThinkingMessage(message) &&
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
  const shouldRenderBottomLiveStatus = isRunning && !hasOpenEndedLiveProcessGroup;
  const shouldRenderBottomStreamingThinking = Boolean(streamingThinkingContent && !hasOpenEndedLiveProcessGroup);

  const isProcessExpanded = useCallback((processKey: string, defaultExpanded = false) => (
    expandedProcessRows.get(processKey) ?? defaultExpanded
  ), [expandedProcessRows]);

  const handleProcessExpandedChange = useCallback((processKey: string, expanded: boolean) => {
    setExpandedProcessRows((prev) => {
      const next = new Map(prev);
      next.set(processKey, expanded);
      return next;
    });
  }, []);

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
      />
    ));
  }, [
    createDiff,
    handleProcessExpandedChange,
    isProcessExpanded,
    onFileOpen,
    provider,
    selectedProject,
    showThinking,
  ]);

  const renderLiveProcessGroup = useCallback((group: LiveProcessGroup, index: number) => {
    const isLatestGroup = liveProcessGroups[liveProcessGroups.length - 1]?.id === group.id;
    const step = getLiveProcessGroupStep(group, t, group.isRunning && isLatestGroup ? thinkingStatusStep : null);
    const expanded = isProcessExpanded(group.id);
    const { beforeStatusMessages, statusDetailMessages } = splitLiveProcessGroupDetailMessages(group);
    const showStreamingThinkingBeforeStatus = Boolean(streamingThinkingContent && group.isRunning && isLatestGroup);
    return (
      <Fragment key={group.id || `${group.afterOriginalIndex}-${index}`}>
        {expanded && beforeStatusMessages.length > 0 ? (
          <div className="pl-5">
            {renderLiveProcessDetailMessages(beforeStatusMessages, `${group.id}-before-status`)}
          </div>
        ) : null}
        {showStreamingThinkingBeforeStatus ? (
          <div className="pl-5">
            <StreamingThinkingPreview content={streamingThinkingContent!} />
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
    liveProcessGroups,
    renderLiveProcessDetailMessages,
    streamingThinkingContent,
    t,
    thinkingStatusStep,
  ]);

  if (
    keyedItems.length === 0 &&
    bottomUnanchoredLiveProcessGroups.length === 0 &&
    unanchoredLiveProcessGroupsByBeforeIndex.size === 0 &&
    !shouldRenderBottomLiveStatus &&
    !shouldRenderBottomStreamingThinking
  ) {
    return null;
  }

  return (
    <div className="flex min-w-0 flex-col gap-3 px-6 py-4">
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
            />
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
      {shouldRenderBottomLiveStatus || shouldRenderBottomStreamingThinking ? (
        <div className="flex min-w-0 flex-col">
          <ProcessLiveStatus step={thinkingStatusStep} />
          {shouldRenderBottomStreamingThinking ? (
            <StreamingThinkingPreview content={streamingThinkingContent!} />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
