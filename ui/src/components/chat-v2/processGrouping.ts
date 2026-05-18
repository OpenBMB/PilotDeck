import type { TFunction } from 'i18next';
import type { ChatMessage, ChatRunMode } from '../chat/types/types';
import type { ProcessTraceMetric, ProcessTraceStep } from './ProcessTrace';
import { formatProcessDuration } from './processTraceUtils';

export type ProcessAttachment = {
  id: string;
  processSummary: ChatMessage;
  processDetailMessages: ChatMessage[];
  startIndex: number;
  endIndex: number;
};

export type RenderableMessageItem = {
  message: ChatMessage;
  originalIndex: number;
  beforeProcessAttachments: ProcessAttachment[];
  afterProcessAttachments: ProcessAttachment[];
};

export type LiveProcessGroup = {
  id: string;
  afterOriginalIndex: number;
  beforeOriginalIndex: number | null;
  startIndex: number;
  endIndex: number;
  messages: ChatMessage[];
  detailMessages: ChatMessage[];
  isRunning: boolean;
};

export type BuildRenderableMessageItemsOptions = {
  isAssistantWorking?: boolean;
};

type MessageTurn = {
  start: number;
  end: number;
  summary: ActivitySummaryAttachment | null;
};

type ActivitySummaryAttachment = {
  message: ChatMessage;
  originalIndex: number;
};

type CompletedProcessSegment = {
  id: string;
  startIndex: number;
  endIndex: number;
  messages: ChatMessage[];
  detailMessages: ChatMessage[];
  previousHostIndex: number | null;
  nextHostIndex: number | null;
};

type ProcessCounts = {
  editedTargets: string[];
  readTargets: string[];
  searchCount: number;
  commandCount: number;
  subagentCount: number;
  compactCount: number;
  thinkingCount: number;
  otherToolCount: number;
  toolCallCount: number;
  toolErrorCount: number;
};

const USER_VISIBLE_TOOL_NAMES = new Set([
  'AskUserQuestion',
  'ExitPlanMode',
  'ExitPlanModeV2',
  'exit_plan_mode',
]);

function parseMessageTime(value: unknown): number | null {
  if (!value) return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function getActivitySummaryKey(message: ChatMessage, index: number): string {
  return message.runId || message.id || `${message.startedAt || ''}-${message.endedAt || ''}-${index}`;
}

function createMessageTurns(messages: ChatMessage[]): MessageTurn[] {
  if (messages.length === 0) {
    return [];
  }

  const starts: number[] = [];
  messages.forEach((message, index) => {
    if (message.type === 'user') {
      starts.push(index);
    }
  });

  if (starts.length === 0 || starts[0] > 0) {
    starts.unshift(0);
  }

  return starts.map((start, index) => ({
    start,
    end: starts[index + 1] ?? messages.length,
    summary: null,
  }));
}

function findTurnIndexByPosition(turns: MessageTurn[], index: number): number {
  return turns.findIndex((turn) => index >= turn.start && index < turn.end);
}

function findTurnIndexByTime(messages: ChatMessage[], turns: MessageTurn[], timestamp: number): number {
  let matchedIndex = -1;

  for (let turnIndex = 0; turnIndex < turns.length; turnIndex += 1) {
    const startMessage = messages[turns[turnIndex].start];
    if (startMessage?.type !== 'user') {
      continue;
    }

    const startTime = parseMessageTime(startMessage.timestamp);
    if (startTime == null) {
      continue;
    }

    if (startTime <= timestamp) {
      matchedIndex = turnIndex;
      continue;
    }

    if (startTime > timestamp) {
      break;
    }
  }

  return matchedIndex;
}

function getSummaryAnchorTime(summary: ChatMessage): number | null {
  return (
    parseMessageTime(summary.startedAt) ??
    parseMessageTime(summary.timestamp) ??
    parseMessageTime(summary.endedAt)
  );
}

function getSummarySortTime(summary: ChatMessage): number {
  return (
    parseMessageTime(summary.endedAt) ??
    parseMessageTime(summary.timestamp) ??
    parseMessageTime(summary.startedAt) ??
    0
  );
}

function isNewerSummary(
  next: ActivitySummaryAttachment,
  current: ActivitySummaryAttachment | null,
): boolean {
  if (!current) {
    return true;
  }
  const nextTime = getSummarySortTime(next.message);
  const currentTime = getSummarySortTime(current.message);
  if (nextTime !== currentTime) {
    return nextTime > currentTime;
  }
  return next.originalIndex > current.originalIndex;
}

function attachSummariesToTurns(messages: ChatMessage[], turns: MessageTurn[]): void {
  const summariesByKey = new Map<string, ActivitySummaryAttachment>();

  messages.forEach((message, originalIndex) => {
    if (message.isAgentActivitySummary) {
      summariesByKey.set(getActivitySummaryKey(message, originalIndex), { message, originalIndex });
    }
  });

  const summaries = Array.from(summariesByKey.values()).sort(
    (a, b) => a.originalIndex - b.originalIndex,
  );

  for (const summary of summaries) {
    const anchorTime = getSummaryAnchorTime(summary.message);
    const turnIndexFromTime = anchorTime == null ? -1 : findTurnIndexByTime(messages, turns, anchorTime);
    const turnIndex = turnIndexFromTime >= 0
      ? turnIndexFromTime
      : findTurnIndexByPosition(turns, summary.originalIndex);

    if (turnIndex < 0) {
      continue;
    }

    if (isNewerSummary(summary, turns[turnIndex].summary)) {
      turns[turnIndex].summary = summary;
    }
  }
}

function parseToolInput(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== 'string') {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function getToolInputString(message: ChatMessage, key: string): string {
  const value = parseToolInput(message.toolInput)[key];
  return typeof value === 'string' ? value : '';
}

export function getToolTarget(message: ChatMessage): string {
  return (
    getToolInputString(message, 'file_path') ||
    getToolInputString(message, 'path') ||
    getToolInputString(message, 'pattern') ||
    getToolInputString(message, 'query') ||
    getToolInputString(message, 'command') ||
    ''
  );
}

function getDisplayTarget(target: string): string {
  if (!target) return '';
  const normalized = target.replace(/\\/g, '/');
  return normalized.split('/').filter(Boolean).pop() || target;
}

function hasToolError(message: ChatMessage): boolean {
  return Boolean(message.toolResult?.isError || message.type === 'error');
}

function isPermissionToolError(message: ChatMessage): boolean {
  if (!message.toolResult?.isError) {
    return false;
  }

  const errorCode = typeof message.toolResult.errorCode === 'string'
    ? message.toolResult.errorCode
    : '';
  if (
    errorCode === 'permission_denied' ||
    errorCode === 'permission_required' ||
    errorCode === 'permission_cancelled'
  ) {
    return true;
  }

  const content = typeof message.toolResult.content === 'string'
    ? message.toolResult.content
    : '';
  const lower = content.toLowerCase();
  return (
    lower.includes('permission') &&
    (
      lower.includes('denied') ||
      lower.includes('not allowed') ||
      lower.includes('requires') ||
      lower.includes('grant')
    )
  );
}

function isUserVisibleTool(message: ChatMessage): boolean {
  if (!message.isToolUse) return false;
  const toolName = String(message.toolName || '');
  return USER_VISIBLE_TOOL_NAMES.has(toolName);
}

export function isProcessMessage(message: ChatMessage): boolean {
  if (message.isAgentActivity || message.isAgentActivitySummary) {
    return false;
  }
  if (message.type === 'user' || message.type === 'error') {
    return false;
  }
  if (message.isInteractivePrompt || isUserVisibleTool(message) || isPermissionToolError(message)) {
    return false;
  }
  return Boolean(
    message.isToolUse ||
      message.isSubagentContainer ||
      message.isTaskNotification ||
      message.isCompactBoundary ||
      message.isThinking ||
      message.type === 'tool',
  );
}

function isExpandableProcessMessage(message: ChatMessage): boolean {
  if (!message.isToolUse || message.isSubagentContainer || isPermissionToolError(message)) {
    return false;
  }
  const toolName = String(message.toolName || '');
  if (!toolName || toolName === 'Task' || USER_VISIBLE_TOOL_NAMES.has(toolName)) {
    return false;
  }
  return true;
}

function canHostProcessSummary(message: ChatMessage): boolean {
  return (
    message.type === 'assistant' &&
    !message.isAgentActivitySummary &&
    !message.isAgentActivity &&
    !message.isToolUse &&
    !message.isInteractivePrompt &&
    !message.isSubagentContainer &&
    !message.isTaskNotification &&
    !message.isThinking &&
    typeof message.content === 'string' &&
    message.content.trim().length > 0
  );
}

function isCollapsibleCompletedProcessMessage(message: ChatMessage): boolean {
  return isProcessMessage(message);
}

export function getProcessToolKind(
  message: ChatMessage,
): 'edit' | 'read' | 'search' | 'command' | 'subagent' | 'compact' | 'thinking' | 'tool' {
  if (message.isCompactBoundary) return 'compact';
  if (message.isThinking) return 'thinking';
  if (message.isSubagentContainer || message.toolName === 'Task' || message.isTaskNotification) {
    return 'subagent';
  }

  const toolName = String(message.toolName || '').toLowerCase();
  if (/edit|write|applypatch|patch|update|create|modify|multi_edit|multiedit/.test(toolName)) {
    return 'edit';
  }
  if (/read|cat|view/.test(toolName)) {
    return 'read';
  }
  if (/grep|glob|search|websearch|rag|find|rg/.test(toolName) || message.phase === 'rag') {
    return 'search';
  }
  if (/bash|shell|terminal|exec|command|run/.test(toolName)) {
    return 'command';
  }
  return 'tool';
}

function uniqueCount(values: string[]): number {
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  return normalized.length > 0 ? new Set(normalized).size : values.length;
}

function collectProcessCounts(messages: ChatMessage[]): ProcessCounts {
  const counts: ProcessCounts = {
    editedTargets: [],
    readTargets: [],
    searchCount: 0,
    commandCount: 0,
    subagentCount: 0,
    compactCount: 0,
    thinkingCount: 0,
    otherToolCount: 0,
    toolCallCount: 0,
    toolErrorCount: 0,
  };

  for (const message of messages) {
    if (message.isToolUse || message.toolName) {
      counts.toolCallCount += 1;
    }
    if (hasToolError(message)) {
      counts.toolErrorCount += 1;
    }

    const kind = getProcessToolKind(message);
    if (kind === 'edit') {
      counts.editedTargets.push(getToolTarget(message));
    } else if (kind === 'read') {
      counts.readTargets.push(getToolTarget(message));
    } else if (kind === 'search') {
      counts.searchCount += 1;
    } else if (kind === 'command') {
      counts.commandCount += 1;
    } else if (kind === 'subagent') {
      counts.subagentCount += 1;
    } else if (kind === 'compact') {
      counts.compactCount += 1;
    } else if (kind === 'thinking') {
      counts.thinkingCount += 1;
    } else {
      counts.otherToolCount += 1;
    }
  }

  return counts;
}

function getDurationMs(start: unknown, end: unknown): number {
  const startTime = parseMessageTime(start);
  const endTime = parseMessageTime(end);
  if (startTime == null || endTime == null) {
    return 0;
  }
  return Math.max(0, endTime - startTime);
}

function createSyntheticProcessSummary(
  messages: ChatMessage[],
  turn: MessageTurn,
  hostIndex: number,
  detailMessages: ChatMessage[],
  segmentStartIndex: number,
  segmentEndIndex: number,
  attachmentId: string,
): ChatMessage {
  const host = messages[hostIndex];
  const counts = collectProcessCounts(detailMessages);
  const startedAt = messages[segmentStartIndex]?.timestamp ?? messages[turn.start]?.timestamp;
  const endedAt = messages[segmentEndIndex]?.timestamp ?? host?.timestamp;

  return {
    id: `process-summary-${attachmentId}`,
    type: 'system',
    content: '',
    timestamp: endedAt || new Date().toISOString(),
    isAgentActivitySummary: true,
    startedAt: startedAt ? String(startedAt) : '',
    endedAt: endedAt ? String(endedAt) : '',
    durationMs: getDurationMs(startedAt, endedAt),
    state: counts.toolErrorCount > 0 ? 'failed' : 'completed',
    toolCallCount: counts.toolCallCount,
    toolErrorCount: counts.toolErrorCount,
    ragSearchCount: counts.searchCount,
    editedFileCount: uniqueCount(counts.editedTargets),
    exploredFileCount: uniqueCount(counts.readTargets),
    commandCount: counts.commandCount,
    subagentCount: counts.subagentCount,
    compactCount: counts.compactCount,
    thinkingCount: counts.thinkingCount,
    otherToolCount: counts.otherToolCount,
    keySteps: [],
  };
}

function findNextHostIndex(messages: ChatMessage[], turn: MessageTurn, fromIndex: number): number | null {
  for (let index = fromIndex; index < turn.end; index += 1) {
    const message = messages[index];
    if (message && canHostProcessSummary(message)) {
      return index;
    }
  }
  return null;
}

function collectCompletedProcessSegments(messages: ChatMessage[], turn: MessageTurn): CompletedProcessSegment[] {
  const segments: CompletedProcessSegment[] = [];
  let previousHostIndex: number | null = null;
  let segmentStartIndex = -1;
  let segmentMessages: ChatMessage[] = [];

  const finishSegment = (beforeOriginalIndex: number) => {
    if (segmentMessages.length === 0 || segmentStartIndex < 0) {
      segmentStartIndex = -1;
      segmentMessages = [];
      return;
    }

    const endIndex = beforeOriginalIndex - 1;
    const first = segmentMessages[0];
    const last = segmentMessages[segmentMessages.length - 1];
    const nextHostIndex = previousHostIndex == null
      ? findNextHostIndex(messages, turn, beforeOriginalIndex)
      : null;

    segments.push({
      id: [
        'completed-process',
        first.id || first.toolId || segmentStartIndex,
        last.id || last.toolId || endIndex,
      ].join('-'),
      startIndex: segmentStartIndex,
      endIndex,
      messages: segmentMessages,
      detailMessages: segmentMessages.filter(isExpandableProcessMessage),
      previousHostIndex,
      nextHostIndex,
    });

    segmentStartIndex = -1;
    segmentMessages = [];
  };

  for (let index = turn.start; index < turn.end; index += 1) {
    const message = messages[index];
    if (!message || message.isAgentActivity || message.isAgentActivitySummary) {
      continue;
    }

    if (isCollapsibleCompletedProcessMessage(message)) {
      if (segmentMessages.length === 0) {
        segmentStartIndex = index;
      }
      segmentMessages.push(message);
      continue;
    }

    finishSegment(index);

    if (canHostProcessSummary(message)) {
      previousHostIndex = index;
    }
  }

  finishSegment(turn.end);
  return segments;
}

function pushProcessAttachment(
  item: RenderableMessageItem,
  placement: 'before' | 'after',
  attachment: ProcessAttachment,
): void {
  if (placement === 'before') {
    item.beforeProcessAttachments.push(attachment);
  } else {
    item.afterProcessAttachments.push(attachment);
  }
}

export function buildRenderableMessageItems(
  messages: ChatMessage[],
  options: BuildRenderableMessageItemsOptions = {},
): RenderableMessageItem[] {
  const items: RenderableMessageItem[] = [];
  const itemsByIndex = new Map<number, RenderableMessageItem>();
  const syntheticItems: RenderableMessageItem[] = [];
  const collapsedIndices = new Set<number>();
  const turns = createMessageTurns(messages);
  const liveTurn = options.isAssistantWorking ? turns[turns.length - 1] : null;

  messages.forEach((message, originalIndex) => {
    if (message.isAgentActivitySummary) {
      return;
    }
    if (
      liveTurn &&
      originalIndex >= liveTurn.start &&
      originalIndex < liveTurn.end &&
      isProcessMessage(message)
    ) {
      collapsedIndices.add(originalIndex);
      return;
    }

    const item: RenderableMessageItem = {
      message,
      originalIndex,
      beforeProcessAttachments: [],
      afterProcessAttachments: [],
    };
    items.push(item);
    itemsByIndex.set(originalIndex, item);
  });

  attachSummariesToTurns(messages, turns);

  turns.forEach((turn, turnIndex) => {
    const isLatestTurn = turnIndex === turns.length - 1;
    if (options.isAssistantWorking && isLatestTurn) {
      return;
    }

    const segments = collectCompletedProcessSegments(messages, turn);

    if (segments.length === 0) {
      if (turn.summary) {
        items.push({
          message: turn.summary.message,
          originalIndex: turn.summary.originalIndex,
          beforeProcessAttachments: [],
          afterProcessAttachments: [],
        });
      }
      return;
    }

    for (const segment of segments) {
      for (let index = segment.startIndex; index <= segment.endIndex; index += 1) {
        collapsedIndices.add(index);
      }

      const hostIndex = segment.previousHostIndex ?? segment.nextHostIndex ?? segment.endIndex;
      const summary = createSyntheticProcessSummary(
        messages,
        turn,
        hostIndex,
        segment.messages,
        segment.startIndex,
        segment.endIndex,
        segment.id,
      );
      const attachment: ProcessAttachment = {
        id: segment.id,
        processSummary: summary,
        processDetailMessages: segment.detailMessages,
        startIndex: segment.startIndex,
        endIndex: segment.endIndex,
      };
      const previousHost = segment.previousHostIndex == null
        ? null
        : itemsByIndex.get(segment.previousHostIndex);
      const nextHost = segment.nextHostIndex == null
        ? null
        : itemsByIndex.get(segment.nextHostIndex);

      if (previousHost) {
        pushProcessAttachment(previousHost, 'after', attachment);
      } else if (nextHost) {
        pushProcessAttachment(nextHost, 'before', attachment);
      } else {
        syntheticItems.push({
          message: summary,
          originalIndex: segment.startIndex - 0.1,
          beforeProcessAttachments: [],
          afterProcessAttachments: [],
        });
      }
    }
  });

  return [...items, ...syntheticItems]
    .filter((item) => !collapsedIndices.has(item.originalIndex))
    .sort((a, b) => a.originalIndex - b.originalIndex);
}

export function getLiveProcessDetailMessages(messages: ChatMessage[]): ChatMessage[] {
  return getLiveProcessGroups(messages, { isAssistantWorking: true })
    .flatMap((group) => group.detailMessages);
}

export function getLiveProcessGroups(
  messages: ChatMessage[],
  options: BuildRenderableMessageItemsOptions = {},
): LiveProcessGroup[] {
  const turns = createMessageTurns(messages);
  const liveTurn = turns[turns.length - 1];
  if (!liveTurn) {
    return [];
  }

  const groups: Omit<LiveProcessGroup, 'isRunning'>[] = [];
  let previousVisibleIndex = liveTurn.start;
  let groupStartIndex = -1;
  let groupMessages: ChatMessage[] = [];

  const finishGroup = (beforeOriginalIndex: number | null) => {
    if (groupMessages.length === 0 || previousVisibleIndex < 0) {
      groupStartIndex = -1;
      groupMessages = [];
      return;
    }

    const first = groupMessages[0];
    const last = groupMessages[groupMessages.length - 1];
    groups.push({
      id: [
        'live-process',
        first.id || first.toolId || groupStartIndex,
        last.id || last.toolId || beforeOriginalIndex || messages.length,
      ].join('-'),
      afterOriginalIndex: previousVisibleIndex,
      beforeOriginalIndex,
      startIndex: groupStartIndex,
      endIndex: beforeOriginalIndex ?? messages.length,
      messages: groupMessages,
      detailMessages: groupMessages.filter(isExpandableProcessMessage),
    });
    groupStartIndex = -1;
    groupMessages = [];
  };

  for (let index = liveTurn.start; index < liveTurn.end; index += 1) {
    const message = messages[index];
    if (!message || message.isAgentActivity || message.isAgentActivitySummary) {
      continue;
    }

    if (isProcessMessage(message)) {
      if (groupMessages.length === 0) {
        groupStartIndex = index;
      }
      groupMessages.push(message);
      continue;
    }

    finishGroup(index);
    previousVisibleIndex = index;
  }

  finishGroup(null);

  return groups.map((group, index) => {
    const isLatestGroup = index === groups.length - 1;
    const isOpenEnded = group.beforeOriginalIndex == null;
    return {
      ...group,
      isRunning: Boolean(options.isAssistantWorking && isLatestGroup && isOpenEnded),
    };
  });
}

export function shouldRenderLiveProcessGroup(group: LiveProcessGroup, runMode: ChatRunMode): boolean {
  if (runMode !== 'plan') {
    return true;
  }
  return !group.messages.every((message) => message.isCompactBoundary);
}

function numberField(message: ChatMessage, key: string): number {
  const value = message[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function formatCompletedProcessTitle(
  messageOrMessages: ChatMessage | ChatMessage[],
  t: TFunction<'chat'>,
): string {
  const counts = Array.isArray(messageOrMessages)
    ? collectProcessCounts(messageOrMessages)
    : {
        editedTargets: [],
        readTargets: [],
        searchCount: numberField(messageOrMessages, 'ragSearchCount'),
        commandCount: numberField(messageOrMessages, 'commandCount'),
        subagentCount: numberField(messageOrMessages, 'subagentCount'),
        compactCount: numberField(messageOrMessages, 'compactCount'),
        thinkingCount: numberField(messageOrMessages, 'thinkingCount'),
        otherToolCount: numberField(messageOrMessages, 'otherToolCount'),
        toolCallCount: numberField(messageOrMessages, 'toolCallCount'),
        toolErrorCount: numberField(messageOrMessages, 'toolErrorCount'),
      };

  const editCount = Array.isArray(messageOrMessages)
    ? uniqueCount(counts.editedTargets)
    : numberField(messageOrMessages, 'editedFileCount');
  const readCount = Array.isArray(messageOrMessages)
    ? uniqueCount(counts.readTargets)
    : numberField(messageOrMessages, 'exploredFileCount');
  const labels: string[] = [];

  if (editCount > 0) {
    labels.push(t('process.live.editedFiles', {
      count: editCount,
      defaultValue: `Edited ${editCount} ${editCount === 1 ? 'file' : 'files'}`,
    }));
  }
  if (readCount > 0) {
    labels.push(t('process.live.exploredFiles', {
      count: readCount,
      defaultValue: `Explored ${readCount} ${readCount === 1 ? 'file' : 'files'}`,
    }));
  }
  if (counts.searchCount > 0) {
    labels.push(t('process.live.searches', {
      count: counts.searchCount,
      defaultValue: `Searched ${counts.searchCount} ${counts.searchCount === 1 ? 'time' : 'times'}`,
    }));
  }
  if (counts.commandCount > 0) {
    labels.push(t('process.live.commands', {
      count: counts.commandCount,
      defaultValue: `Ran ${counts.commandCount} ${counts.commandCount === 1 ? 'command' : 'commands'}`,
    }));
  }
  if (counts.subagentCount > 0) {
    labels.push(t('process.live.subagentCompleted', { defaultValue: 'Subagent finished' }));
  }
  if (counts.compactCount > 0) {
    labels.push(t('process.live.compactCompleted', { defaultValue: 'Compacted context' }));
  }
  if (counts.thinkingCount > 0 && labels.length === 0) {
    labels.push(t('process.live.thoughtCompleted', { defaultValue: 'Thought through next step' }));
  }
  if (labels.length === 0 && counts.otherToolCount > 0) {
    labels.push(t('process.live.toolCalls', {
      count: counts.otherToolCount,
      defaultValue: `Used ${counts.otherToolCount} ${counts.otherToolCount === 1 ? 'tool' : 'tools'}`,
    }));
  }
  if (counts.toolErrorCount > 0) {
    labels.push(t('process.live.errors', {
      count: counts.toolErrorCount,
      defaultValue: `${counts.toolErrorCount} ${counts.toolErrorCount === 1 ? 'error' : 'errors'}`,
    }));
  }

  return labels.join(' ');
}

export function getRunningProcessTitle(
  group: LiveProcessGroup,
  t: TFunction<'chat'>,
): string {
  const latestMessage = [...group.messages].reverse().find((message) => isProcessMessage(message));
  if (!latestMessage) {
    return t('working.processing', { defaultValue: 'Processing' });
  }

  const kind = getProcessToolKind(latestMessage);
  const target = getDisplayTarget(getToolTarget(latestMessage));
  if (kind === 'edit') {
    return target
      ? t('process.live.runningEditTarget', { target, defaultValue: `Editing ${target}` })
      : t('process.live.runningEdit', { defaultValue: 'Editing file' });
  }
  if (kind === 'read') {
    return target
      ? t('process.live.runningReadTarget', { target, defaultValue: `Reading ${target}` })
      : t('process.live.runningRead', { defaultValue: 'Reading file' });
  }
  if (kind === 'search') {
    return target
      ? t('process.live.runningSearchTarget', { target, defaultValue: `Searching ${target}` })
      : t('process.live.runningSearch', { defaultValue: 'Searching' });
  }
  if (kind === 'command') {
    return target
      ? t('process.live.runningCommandTarget', { target, defaultValue: `Running ${target}` })
      : t('process.live.runningCommand', { defaultValue: 'Running command' });
  }
  if (kind === 'subagent') {
    return t('process.live.runningSubagent', { defaultValue: 'Running subagent' });
  }
  if (kind === 'compact') {
    return t('working.compacting', { defaultValue: 'Compacting context...' });
  }
  if (kind === 'thinking') {
    return t('working.thinking', { defaultValue: 'Thinking' });
  }
  return latestMessage.title || latestMessage.content || latestMessage.toolName || t('working.processing', { defaultValue: 'Processing' });
}

export function getLiveProcessGroupStep(
  group: LiveProcessGroup,
  t: TFunction<'chat'>,
  fallbackRunningStep: ProcessTraceStep | null,
): ProcessTraceStep {
  const fallbackPhase = String(fallbackRunningStep?.phase || '');
  const canUseFallbackStep = fallbackRunningStep?.title &&
    !['generation', 'thinking', 'permission'].includes(fallbackPhase);
  if (group.isRunning && canUseFallbackStep) {
    return {
      ...fallbackRunningStep,
      id: group.id,
      state: fallbackRunningStep.state || 'running',
    };
  }

  const title = group.isRunning
    ? getRunningProcessTitle(group, t)
    : formatCompletedProcessTitle(group.messages, t);
  const latestMessage = group.messages[group.messages.length - 1];
  const kind = latestMessage ? getProcessToolKind(latestMessage) : 'tool';

  return {
    id: group.id,
    title,
    state: group.isRunning ? 'running' : 'completed',
    phase: kind === 'search' ? 'rag' : kind === 'command' ? 'tool' : latestMessage?.phase,
    toolName: latestMessage?.toolName,
  };
}

export function processSummaryToTrace(
  message: ChatMessage,
  t: TFunction<'chat'>,
): {
  label: string;
  collapsedDetail: string;
  statusLabel: string;
  status: string;
  metrics: ProcessTraceMetric[];
  steps: ProcessTraceStep[];
} {
  const rawStatus = String(message.state || 'completed');
  const duration = formatProcessDuration(
    typeof message.durationMs === 'number' ? message.durationMs : 0,
  );
  const label = formatCompletedProcessTitle(message, t) ||
    t('process.summary.processed', {
      duration,
      defaultValue: `Processed ${duration}`,
    });
  const toolCalls = numberField(message, 'toolCallCount');
  const searches = numberField(message, 'ragSearchCount');
  const errors = numberField(message, 'toolErrorCount');
  const status = rawStatus === 'failed' && errors > 0 ? 'completed' : rawStatus;
  const metrics: ProcessTraceMetric[] = [
    toolCalls > 0
      ? {
          key: 'toolCalls',
          label: t('process.metrics.toolCalls', { count: toolCalls, defaultValue: '{{count}} tool calls' }),
        }
      : null,
    searches > 0
      ? {
          key: 'searches',
          label: t('process.metrics.searches', { count: searches, defaultValue: '{{count}} searches' }),
        }
      : null,
    errors > 0
      ? {
          key: 'errors',
          label: t('process.metrics.errors', { count: errors, defaultValue: '{{count}} errors' }),
        }
      : null,
  ].filter((metric): metric is ProcessTraceMetric => Boolean(metric));
  const steps = Array.isArray(message.keySteps)
    ? message.keySteps
        .filter((step): step is Record<string, unknown> => Boolean(step) && typeof step === 'object')
        .map((step) => ({
          id: typeof step.activityId === 'string'
            ? step.activityId
            : typeof step.id === 'string'
              ? step.id
              : undefined,
          title: typeof step.title === 'string' ? step.title : undefined,
          detail: typeof step.detail === 'string' ? step.detail : undefined,
          state: typeof step.state === 'string' ? step.state : undefined,
          severity: typeof step.severity === 'string' ? step.severity : undefined,
          phase: typeof step.phase === 'string' ? step.phase : undefined,
          toolName: typeof step.toolName === 'string' ? step.toolName : undefined,
        }))
    : [];

  return {
    label,
    collapsedDetail: '',
    statusLabel: status === 'failed'
      ? t('process.summary.failed', { defaultValue: 'Process failed' })
      : status === 'cancelled'
        ? t('process.summary.cancelled', { defaultValue: 'Process stopped' })
        : t('process.summary.completed', { defaultValue: 'Process completed' }),
    status,
    metrics,
    steps,
  };
}
