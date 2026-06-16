import { Fragment, useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatMessage, ChatRunMode } from '../chat/types/types';
import type { Project, SessionProvider } from '../../types/app';
import MessageRowV2 from './MessageRowV2';
import { ProcessLiveStatus, type ProcessTraceStep } from './ProcessTrace';
import {
  buildRenderableMessageItems,
  getLiveProcessGroups,
  getLiveProcessGroupStep,
  getProcessToolKind,
  shouldRenderLiveProcessGroup,
  type LiveProcessGroup,
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
  const renderableItems = useMemo(
    () => buildRenderableMessageItems(renderableMessages, { isAssistantWorking: true }),
    [renderableMessages],
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
  const liveProcessGroups = useMemo(
    () => getLiveProcessGroups(renderableMessages, { isAssistantWorking: true })
        .filter((group) => shouldRenderLiveProcessGroup(group, runMode))
        .map((group) => isRunning ? group : { ...group, isRunning: false }),
    [isRunning, renderableMessages, runMode],
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
  const hasOpenEndedLiveProcessGroup = liveProcessGroups.some((group) => group.isRunning);
  const shouldRenderBottomLiveStatus = isRunning && !hasOpenEndedLiveProcessGroup;

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
    renderLiveProcessDetailMessages,
    t,
    thinkingStatusStep,
  ]);

  if (
    keyedItems.length === 0 &&
    unanchoredLiveProcessGroups.length === 0 &&
    !shouldRenderBottomLiveStatus
  ) {
    return null;
  }

  return (
    <div className="flex min-w-0 flex-col gap-3 px-6 py-4">
      {unanchoredLiveProcessGroups.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-2">
          {unanchoredLiveProcessGroups.map(renderLiveProcessGroup)}
        </div>
      ) : null}
      {keyedItems.map((item) => {
        const previousMessage = item.renderIndex > 0 ? keyedItems[item.renderIndex - 1].message : null;
        const nextMessage = item.renderIndex < keyedItems.length - 1
          ? keyedItems[item.renderIndex + 1].message
          : null;
        const anchoredLiveGroups = liveProcessGroupsByAnchor.get(item.originalIndex) || [];

        return (
          <Fragment key={item.itemKey}>
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
      {shouldRenderBottomLiveStatus ? (
        <ProcessLiveStatus step={thinkingStatusStep} />
      ) : null}
    </div>
  );
}
