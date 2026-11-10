import type { TFunction } from 'i18next';
import { isMediaGeneration, isMediaSurfaceVisible } from '../tools/mediaPresentation';
import type { ChatMessage, ChatRunMode } from '../types/types';
import { isToolPermissionError } from './chatPermissions';
import type { ProcessTraceMetric, ProcessTraceStep } from '../view/ProcessTrace';
import { formatProcessDuration } from './processTraceUtils';

export type ProcessAttachmentImage = {
  data: string;
  name?: string;
  mimeType?: string;
  /** Origin of the image — currently always a tool result (e.g. read_file on a PNG). */
  source: 'tool_result';
  /** Source tool's id, useful as a stable React key. */
  toolId?: string;
};

export type ProcessAttachment = {
  id: string;
  processSummary: ChatMessage;
  /** Complete event sequence, including events without expandable details. */
  processMessages: ChatMessage[];
  processDetailMessages: ChatMessage[];
  startIndex: number;
  endIndex: number;
  /**
   * Inline images returned by tools inside this collapsed segment (e.g.
   * `read_file` on a PNG). Surfaced alongside the collapsed summary so the
   * user can still see the picture without expanding the trace — otherwise
   * the image hides behind the "Explored N files" pill, even though the
   * model already replied "this is a 3D surface plot…" right after.
   */
  inlineImages: ProcessAttachmentImage[];
};

export type ProcessRunAttachment = {
  id: string;
  durationMs: number;
  startIndex: number;
  endIndex: number;
};

export type TurnProcessGroup = {
  id: string;
  isRunning: boolean;
  defaultExpanded: boolean;
  durationMs: number | null;
  hasRecordedDuration?: boolean;
  outcome?: 'completed' | 'cancelled' | 'failed';
  startedAt?: string;
  memberIds: string[];
};

export type RenderableMessageItem = {
  /** One file result surface at the end of the turn, outside process disclosures. */
  turnFiles?: { turnId?: string; artifacts: NonNullable<ChatMessage['artifacts']>; visible: boolean };
  /** A separate media surface; the original tool call remains in the process. */
  mediaArtifact?: true;
  /** Pending generation is shown for assets too; completed assets fold away. */
  mediaExpanded?: boolean;
  turnTrace?: { id: string; isLive: boolean; defaultExpanded: boolean; items: RenderableMessageItem[] };
  /** One shared disclosure owns all process seats in this user turn. */
  processRun?: TurnProcessGroup;
  /** The latest prose/artifact reply remains visible when the turn folds. */
  processOutput?: boolean;
  beforeTurnProcess?: TurnProcessGroup;
  afterTurnProcess?: TurnProcessGroup;
  message: ChatMessage;
  originalIndex: number;
  beforeRunAttachment: ProcessRunAttachment | null;
  afterRunAttachment: ProcessRunAttachment | null;
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

const ACTIVITY_METRICS = [
  { kind: 'image', field: 'viewedImageCount', label: 'viewedImages', verb: 'Viewed', noun: 'image' },
  { kind: 'image-generation', field: 'generatedImageCount', label: 'generatedImages', verb: 'Generated', noun: 'image' },
  { kind: 'image-edit', field: 'editedImageCount', label: 'editedImages', verb: 'Edited', noun: 'image' },
  { kind: 'video-generation', field: 'generatedVideoCount', label: 'generatedVideos', verb: 'Generated', noun: 'video' },
  { kind: 'browse', field: 'openedPageCount', label: 'openedPages', verb: 'Opened', noun: 'page' },
  { kind: 'interaction', field: 'browserActionCount', label: 'browserActions', verb: 'Performed', noun: 'browser action' },
  { kind: 'skill', field: 'loadedSkillCount', label: 'loadedSkills', verb: 'Loaded', noun: 'skill' },
] as const;
type ActivityCountField = typeof ACTIVITY_METRICS[number]['field'];

function additionalActivityCounts(message?: ChatMessage): Record<ActivityCountField, number> {
  return Object.fromEntries(ACTIVITY_METRICS.map(({ field }) => [field, message ? numberField(message, field) : 0])) as Record<ActivityCountField, number>;
}

type ProcessCounts = Record<ActivityCountField, number> & {
  editedTargets: string[];
  readTargets: string[];
  searchCount: number;
  fetchCount: number;
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
  'ask_user_question',
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

function getStableMessagePart(message: ChatMessage | undefined, fallback: string): string {
  const value = message?.turnId || message?.runId || message?.toolId || message?.id || message?.activityId;
  return String(value || fallback);
}

function getStableProcessSegmentId(
  messages: ChatMessage[],
  turn: MessageTurn,
  firstMessage: ChatMessage,
  startIndex: number,
): string {
  const turnPart = getStableMessagePart(messages[turn.start], `turn-${turn.start}`);
  const firstPart = String(
    (firstMessage.isCompactBoundary && firstMessage.compactionId) ||
    firstMessage.toolId ||
      firstMessage.toolCallId ||
      firstMessage.activityId ||
      firstMessage.id ||
      firstMessage.runId ||
      `message-${startIndex}`,
  );
  return `process-segment-${turnPart}-${firstPart}`;
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
    const identity = summary.message.turnId || summary.message.runId;
    const matchingTurns = identity ? turns.flatMap((turn, index) => {
      const anchor = messages[turn.start];
      return anchor.type === 'user' && (anchor.turnId || anchor.runId) === identity ? [index] : [];
    }) : [];
    const anchorTime = getSummaryAnchorTime(summary.message);
    const turnIndexFromTime = anchorTime == null ? -1 : findTurnIndexByTime(messages, turns, anchorTime);
    // Terminal summaries belong to the final accepted input of their run,
    // including mid-turn guidance. Its start can precede accepted_input, so
    // clock proximity must never move a known run into a previous request.
    const turnIndex = matchingTurns.length ? matchingTurns[matchingTurns.length - 1] : turnIndexFromTime >= 0
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
    getToolInputString(message, 'file') ||
    getToolInputString(message, 'filepath') ||
    getToolInputString(message, 'image_path') ||
    getToolInputString(message, 'output_path') ||
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
  return isToolPermissionError(message);
}

function isUserVisibleTool(message: ChatMessage): boolean {
  if (!message.isToolUse) return false;
  const toolName = String(message.toolName || '');
  return USER_VISIBLE_TOOL_NAMES.has(toolName);
}

export function isProcessMessage(message: ChatMessage): boolean {
  if (message.isThinking || message.isAgentActivity || message.isAgentActivitySummary) {
    return false;
  }
  if (message.type === 'user' || message.type === 'error') {
    return false;
  }
  if (message.isSubagentContainer) {
    return false;
  }
  if (message.isInteractivePrompt || isUserVisibleTool(message) || isPermissionToolError(message)) {
    return false;
  }
  return Boolean(
    message.isToolUse ||
      message.isTaskNotification ||
      message.isCompactBoundary ||
      message.type === 'tool',
  );
}

function isExpandableProcessMessage(message: ChatMessage): boolean {
  if (message.isThinking) {
    return true;
  }
  if (!message.isToolUse || message.isSubagentContainer || isPermissionToolError(message)) {
    return false;
  }
  const toolName = String(message.toolName || '');
  if (!toolName || toolName === 'Task' || isUserVisibleTool(message)) {
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
    typeof message.content === 'string' &&
    message.content.trim().length > 0
  );
}

export function isEmptyAssistantShell(message: ChatMessage): boolean {
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
    !message.artifacts?.length &&
    !message.images?.length &&
    typeof message.content === 'string' &&
    message.content.trim().length === 0
  );
}

function isEmptyRenderableMessageItem(item: RenderableMessageItem): boolean {
  if (item.beforeRunAttachment || item.afterRunAttachment) return false;
  if (item.beforeProcessAttachments.length > 0 || item.afterProcessAttachments.length > 0) {
    return false;
  }
  return isEmptyAssistantShell(item.message);
}

function isCollapsibleCompletedProcessMessage(message: ChatMessage): boolean {
  return isProcessMessage(message);
}

export function getProcessToolKind(
  message: ChatMessage,
): 'edit' | 'read' | 'search' | 'fetch' | 'command' | 'subagent' | 'compact' | 'thinking' | 'tool' | typeof ACTIVITY_METRICS[number]['kind'] {
  if (message.isCompactBoundary) return 'compact';
  if (message.isThinking) return 'thinking';
  if (message.isSubagentContainer || message.toolName === 'Task' || message.isTaskNotification) {
    return 'subagent';
  }

  const toolName = String(message.toolName || '').toLowerCase();
  // Semantic categories must precede broad file/tool fallbacks: edit_image
  // does not edit a text file, and a browser screenshot does not open a page.
  if (/(?:^|__)(view_image|open_image|read_image|image_view|vision_analyze|analyze_image)$/.test(toolName)) return 'image';
  if (toolName === 'generate_image') return 'image-generation';
  if (toolName === 'edit_image') return 'image-edit';
  if (toolName === 'generate_video') return 'video-generation';
  if (toolName === 'read_skill' || toolName === 'skill_view') return 'skill';
  if (/(?:^|__)(?:browser_navigate|browser_open)$/.test(toolName)) return 'browse';
  if (/(?:^|__)(?:browser|computer)_/.test(toolName)) return 'interaction';
  if (toolName === 'save_generated_image' || toolName === 'save_generated_video') return 'edit';
  if (/^(task_?(?:create|update|list|get|stop|output|wait)|todo_?(?:write|read))$/.test(toolName)) return 'tool';
  if (isWebFetchToolMessage(message)) return 'fetch';
  if (toolName === 'str_replace_editor' && getToolInputString(message, 'command') === 'view') {
    return /\.(png|jpe?g|gif|webp|bmp|tiff?|svg|avif|heic|ico)(?:[?#].*)?$/i.test(getToolTarget(message)) ? 'image' : 'read';
  }
  if (/edit|write|applypatch|patch|update|create|modify|multi_edit|multiedit/.test(toolName)) {
    return 'edit';
  }
  if (/read|cat|view/.test(toolName)) {
    if (/\.(png|jpe?g|gif|webp|bmp|tiff?|svg|avif|heic|ico)(?:[?#].*)?$/i.test(getToolTarget(message))
      || (Array.isArray(message.toolResult?.images) && message.toolResult.images.length > 0)) return 'image';
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
    ...additionalActivityCounts(),
    editedTargets: [],
    readTargets: [],
    searchCount: 0,
    fetchCount: 0,
    commandCount: 0,
    subagentCount: 0,
    compactCount: 0,
    thinkingCount: 0,
    otherToolCount: 0,
    toolCallCount: 0,
    toolErrorCount: 0,
  };

  const seenCalls = new Set<string>();
  for (const message of messages) {
    const callId = message.toolId || message.toolCallId || message.id;
    const identity = callId ? `${message.turnId || message.runId || ''}:${callId}` : '';
    if ((message.isToolUse || message.toolName) && identity) {
      if (seenCalls.has(identity)) continue;
      seenCalls.add(identity);
    }
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
    } else if (kind === 'fetch') {
      counts.fetchCount += 1;
    } else if (kind === 'command') {
      counts.commandCount += 1;
    } else if (kind === 'subagent') {
      counts.subagentCount += 1;
    } else if (kind === 'compact') {
      counts.compactCount += 1;
    } else if (kind === 'thinking') {
      counts.thinkingCount += 1;
    } else {
      const metric = ACTIVITY_METRICS.find(metric => metric.kind === kind);
      if (metric) { counts[metric.field] += 1; continue; }
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

function getTurnEndIndex(messages: ChatMessage[], turn: MessageTurn): number {
  for (let index = turn.end - 1; index >= turn.start; index -= 1) {
    const message = messages[index];
    if (!message || message.isAgentActivity || message.isAgentActivitySummary) {
      continue;
    }
    return index;
  }
  return turn.end - 1;
}

function getTurnRunDurationMs(messages: ChatMessage[], turn: MessageTurn): number | null {
  const timing = getRecordedTurnTiming(messages.slice(turn.start, turn.end));
  if (timing) return timing.durationMs;
  const summaryDuration = turn.summary?.message.durationMs;
  if (typeof summaryDuration === 'number' && Number.isFinite(summaryDuration)) {
    return Math.max(0, summaryDuration);
  }

  const summaryStart = turn.summary?.message.startedAt;
  const summaryEnd = turn.summary?.message.endedAt;
  const fallbackEndIndex = getTurnEndIndex(messages, turn);
  const startedAt = summaryStart ?? messages[turn.start]?.timestamp;
  const endedAt = summaryEnd ?? messages[fallbackEndIndex]?.timestamp;
  const durationMs = getDurationMs(startedAt, endedAt);
  return durationMs > 0 ? durationMs : null;
}

function getRecordedTurnTiming(messages: ChatMessage[]): { startedAt: number; completedAt: number; durationMs: number } | null {
  const bounds = messages.flatMap(message => {
    const startedAt = parseMessageTime(message.turnTiming?.startedAt);
    const completedAt = parseMessageTime(message.turnTiming?.completedAt);
    return startedAt !== null && completedAt !== null && completedAt >= startedAt ? [{ startedAt, completedAt }] : [];
  });
  if (!bounds.length) return null;
  bounds.sort((a, b) => a.startedAt - b.startedAt);
  let completedAt = bounds[0].startedAt;
  let durationMs = 0;
  for (const bound of bounds) {
    durationMs += Math.max(0, bound.completedAt - Math.max(completedAt, bound.startedAt));
    completedAt = Math.max(completedAt, bound.completedAt);
  }
  return { startedAt: bounds[0].startedAt, completedAt, durationMs };
}

function hasCompletedTurnWork(messages: ChatMessage[], turn: MessageTurn): boolean {
  if (turn.summary) {
    return true;
  }

  for (let index = turn.start; index < turn.end; index += 1) {
    const message = messages[index];
    if (!message || message.isAgentActivity || message.isAgentActivitySummary || message.type === 'user') {
      continue;
    }
    if (canHostProcessSummary(message) || isProcessMessage(message)) {
      return true;
    }
  }

  return false;
}

function hasAgentActivitySummaryDetails(message: ChatMessage): boolean {
  const numericDetailFields = [
    'toolCallCount',
    'toolErrorCount',
    'ragSearchCount',
    'webFetchCount',
    'editedFileCount',
    'exploredFileCount',
    'commandCount',
    'subagentCount',
    'compactCount',
    'thinkingCount',
    'otherToolCount',
    ...ACTIVITY_METRICS.map(({ field }) => field),
  ];
  const hasMetrics = numericDetailFields.some((key) => {
    const value = message[key];
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
  });
  if (hasMetrics) {
    return true;
  }

  if (Array.isArray(message.keySteps) && message.keySteps.length > 0) {
    return true;
  }

  const state = String(message.state || 'completed');
  return state !== 'completed';
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
    state: 'completed',
    toolCallCount: counts.toolCallCount,
    toolErrorCount: counts.toolErrorCount,
    ragSearchCount: counts.searchCount,
    webFetchCount: counts.fetchCount,
    editedFileCount: uniqueCount(counts.editedTargets),
    exploredFileCount: uniqueCount(counts.readTargets),
    commandCount: counts.commandCount,
    subagentCount: counts.subagentCount,
    compactCount: counts.compactCount,
    compactState: detailMessages.find(message => message.isCompactBoundary
      && (message.compactState === 'failed' || message.compactState === 'cancelled'))?.compactState,
    thinkingCount: counts.thinkingCount,
    otherToolCount: counts.otherToolCount,
    ...Object.fromEntries(ACTIVITY_METRICS.map(({ field }) => [field, counts[field]])),
    keySteps: [],
  };
}

function collectToolResultImages(messages: ChatMessage[]): ProcessAttachmentImage[] {
  const images: ProcessAttachmentImage[] = [];
  for (const message of messages) {
    const list = (message.toolResult?.images ?? []) as Array<{ data?: unknown; name?: unknown; mimeType?: unknown }>;
    if (!Array.isArray(list)) continue;
    for (const image of list) {
      if (!image || typeof image.data !== 'string' || image.data.length === 0) continue;
      images.push({
        data: image.data,
        name: typeof image.name === 'string' && image.name.length > 0 ? image.name : undefined,
        mimeType: typeof image.mimeType === 'string' ? image.mimeType : undefined,
        source: 'tool_result',
        toolId: typeof message.toolId === 'string' ? message.toolId : undefined,
      });
    }
  }
  return images;
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
    const identityMessage = segmentMessages.find((message) => message.toolId || message.toolCallId) || first;
    const nextHostIndex = previousHostIndex == null
      ? findNextHostIndex(messages, turn, beforeOriginalIndex)
      : null;

    segments.push({
      id: getStableProcessSegmentId(messages, turn, identityMessage, segmentStartIndex),
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

    if (isEmptyAssistantShell(message)) {
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

  const liveStandaloneThinkingIndices = new Set<number>();
  if (liveTurn) {
    let groupStart = -1;
    let hasNonThinking = false;
    const pendingThinkingIndices: number[] = [];

    for (let i = liveTurn.start; i < liveTurn.end; i += 1) {
      const msg = messages[i];
      if (!msg || msg.isAgentActivity || msg.isAgentActivitySummary) continue;

      if (isProcessMessage(msg)) {
        if (groupStart < 0) groupStart = i;
        if (!msg.isThinking) hasNonThinking = true;
        else pendingThinkingIndices.push(i);
      } else if (isEmptyAssistantShell(msg)) {
        continue;
      } else {
        if (groupStart >= 0 && !hasNonThinking) {
          for (const idx of pendingThinkingIndices) {
            liveStandaloneThinkingIndices.add(idx);
          }
        }
        groupStart = -1;
        hasNonThinking = false;
        pendingThinkingIndices.length = 0;
      }
    }
    if (groupStart >= 0 && !hasNonThinking) {
      for (const idx of pendingThinkingIndices) {
        liveStandaloneThinkingIndices.add(idx);
      }
    }
  }

  messages.forEach((message, originalIndex) => {
    if (message.isAgentActivitySummary) {
      return;
    }
    const inLiveTurn = Boolean(liveTurn && originalIndex >= liveTurn.start && originalIndex < liveTurn.end);
    if (isMediaGeneration(message)) {
      const callKey = message.toolId || message.toolCallId || message.id || String(originalIndex);
      syntheticItems.push({
        mediaArtifact: true,
        mediaExpanded: isMediaSurfaceVisible(message, inLiveTurn),
        message: { ...message, renderKey: `media-artifact-${callKey}` },
        originalIndex: originalIndex + 0.001,
        beforeRunAttachment: null, afterRunAttachment: null,
        beforeProcessAttachments: [], afterProcessAttachments: [],
      });
    }
    if (
      liveTurn &&
      originalIndex >= liveTurn.start &&
      originalIndex < liveTurn.end &&
      isProcessMessage(message) &&
      !liveStandaloneThinkingIndices.has(originalIndex)
    ) {
      collapsedIndices.add(originalIndex);
      return;
    }

    const item: RenderableMessageItem = {
      message,
      originalIndex,
      beforeRunAttachment: null,
      afterRunAttachment: null,
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

    const durationMs = getTurnRunDurationMs(messages, turn);
    if (durationMs != null && hasCompletedTurnWork(messages, turn)) {
      const runAttachment: ProcessRunAttachment = {
        id: `completed-run-${turn.start}-${turn.end}`,
        durationMs,
        startIndex: turn.start,
        endIndex: getTurnEndIndex(messages, turn),
      };
      const turnStartMessage = messages[turn.start];
      const turnStartItem = itemsByIndex.get(turn.start);
      if (turnStartMessage?.type === 'user' && turnStartItem) {
        turnStartItem.afterRunAttachment = runAttachment;
      } else {
        const firstVisibleItem = items.find((item) =>
          item.originalIndex >= turn.start && item.originalIndex < turn.end,
        );
        if (firstVisibleItem) {
          firstVisibleItem.beforeRunAttachment = runAttachment;
        }
      }
    }

    const segments = collectCompletedProcessSegments(messages, turn);

    if (segments.length === 0) {
      if (turn.summary && hasAgentActivitySummaryDetails(turn.summary.message)) {
        items.push({
          message: turn.summary.message,
          originalIndex: turn.summary.originalIndex,
          beforeRunAttachment: null,
          afterRunAttachment: null,
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
        processMessages: segment.messages,
        processDetailMessages: segment.detailMessages,
        startIndex: segment.startIndex,
        endIndex: segment.endIndex,
        inlineImages: collectToolResultImages(segment.messages),
      };
      const previousHost = segment.previousHostIndex == null
        ? null
        : itemsByIndex.get(segment.previousHostIndex);
      const nextHost = segment.nextHostIndex == null
        ? null
        : itemsByIndex.get(segment.nextHostIndex);
      const isTrailingCompactOnlySegment = Boolean(
        previousHost
        && !previousHost.message.isThinking
        // nextHost is intentionally unset whenever there is a previous host;
        // that does not mean this segment is at the end of the transcript.
        && findNextHostIndex(messages, turn, segment.endIndex + 1) === null
        && segment.messages.every((message) => message.isCompactBoundary),
      );

      if (isTrailingCompactOnlySegment && previousHost) {
        // A compact boundary is turn-scoped process metadata, never a new
        // conversational reply. Reconnect/history races can leave a recovered
        // boundary after the persisted final answer in the raw merged array;
        // keep the completed-turn UI invariant by folding it before that host.
        pushProcessAttachment(previousHost, 'before', attachment);
      } else if (previousHost) {
        pushProcessAttachment(previousHost, 'after', attachment);
      } else if (nextHost) {
        pushProcessAttachment(nextHost, 'before', attachment);
      } else {
        syntheticItems.push({
          // An interrupted turn can have only a tool call, with no assistant
          // prose to host its details. Keep a real expandable attachment here
          // rather than a count-only summary that loses the original call.
          message: { id: `process-host-${segment.id}`, type: 'assistant', content: '', timestamp: summary.timestamp },
          originalIndex: segment.startIndex - 0.1,
          beforeRunAttachment: null,
          afterRunAttachment: null,
          beforeProcessAttachments: [attachment],
          afterProcessAttachments: [],
        });
      }
    }
  });

  return [...items, ...syntheticItems]
    .filter((item) => !collapsedIndices.has(item.originalIndex))
    .filter((item) => !isEmptyRenderableMessageItem(item))
    .sort((a, b) => a.originalIndex - b.originalIndex);
}

// Approximate visible work rather than imposing the same call count on every
// run. Inputs are settled when a call is dispatched; result growth must never
// repartition an already-visible prefix and move the reader's scroll anchor.
function processPresentationCost(message: ChatMessage): number {
  if (message.isThinking) return 0.5 + Math.min(2.5, Math.floor((message.content?.length ?? 0) / 1600));
  if (message.isCompactBoundary) return 2;
  const kind = getProcessToolKind({ ...message, toolResult: undefined });
  const base = ['edit', 'image', 'image-generation', 'image-edit', 'video-generation', 'interaction'].includes(kind) ? 1.5 : 1;
  const input = message.toolInput;
  const values = Object.values(parseToolInput(input));
  // Live calls and restored history may encode the same arguments as an
  // object or JSON string. Syntax/escaping must not change batch boundaries.
  const inputLength = values.length ? values.reduce<number>((sum, value) => sum + (typeof value === 'string' ? value.length : 0), 0)
    : typeof input === 'string' ? input.length : 0;
  return base + Math.min(2, Math.floor(inputLength / 4000));
}

/** Preserve interleaved seats; the enclosing turn disclosure hides intermediate work and prose together. */
export function groupProcessIntervals(
  messages: ChatMessage[],
  items: RenderableMessageItem[],
  isAssistantWorking: boolean,
): RenderableMessageItem[] {
  const result: RenderableMessageItem[] = [];
  const mediaByIndex = new Map<number, RenderableMessageItem[]>();
  const existingByMessage = new Map<ChatMessage, RenderableMessageItem>();
  for (const item of items) {
    if (item.mediaArtifact) {
      const index = Math.floor(item.originalIndex);
      const surfaces = mediaByIndex.get(index) ?? [];
      surfaces.push(item);
      mediaByIndex.set(index, surfaces);
    } else existingByMessage.set(item.message, item);
  }
  const clean = (message: ChatMessage, originalIndex: number): RenderableMessageItem => ({
    message, originalIndex, beforeRunAttachment: null, afterRunAttachment: null,
    beforeProcessAttachments: [], afterProcessAttachments: [],
  });
  let pending: RenderableMessageItem[] = [];
  let pendingToolCalls = 0;
  let pendingCost = 0;
  let turnKey = 'history';
  const flush = (closed: boolean, live = false) => {
    if (!pending.length) return;
    const first = pending[0];
    const id = `process-block-${turnKey}-${String(first.message.renderKey || first.message.compactionId || first.message.toolId || first.message.toolCallId || first.message.id || first.originalIndex)}`;
    result.push({ ...clean({ id, renderKey: id, type: 'assistant', content: '', timestamp: first.message.timestamp }, first.originalIndex),
      turnTrace: { id, isLive: live, defaultExpanded: !closed, items: pending } });
    pending = [];
    pendingToolCalls = 0;
    pendingCost = 0;
  };
  messages.forEach((message, index) => {
    if (message.isAgentActivity || message.isAgentActivitySummary || isEmptyAssistantShell(message)) return;
    const work = message.isThinking || isProcessMessage(message)
      || (message.isToolUse && !isUserVisibleTool(message) && isPermissionToolError(message));
    if (work) {
      pending.push(clean(message, index));
      pendingCost += processPresentationCost(message);
      if (message.isToolUse || message.type === 'tool') pendingToolCalls++;
      // Delivered media stays visible even when the surrounding work closes.
      result.push(...(mediaByIndex.get(index) ?? []));
      // Fold a full batch immediately; its header still reports running calls.
      // Pending permission controls are reopened below after turn ownership is known.
      if (pendingCost >= 12 || pendingToolCalls >= 16 || pending.length >= 20) {
        const active = pending.some(item => isPendingProcessMessage(item.message) || item.message.isStreaming);
        flush(true, active && isAssistantWorking);
      }
      return;
    }
    flush(message.type !== 'error' && !message.isInterruptedNotice);
    if (message.type === 'user') turnKey = String(message.renderKey || message.id || index);
    const existing = existingByMessage.get(message);
    result.push({ ...clean(message, index),
      beforeRunAttachment: existing?.beforeRunAttachment ?? null,
      afterRunAttachment: existing?.afterRunAttachment ?? null });
  });
  flush(false, isAssistantWorking);
  // Media may have arrived while a group was still accumulating. Preserve chronology.
  const grouped = attachTurnProcessGroups(messages, result.sort((a, b) => a.originalIndex - b.originalIndex), isAssistantWorking);
  for (const item of grouped) {
    if (item.turnTrace && !item.processRun?.isRunning) item.turnTrace.isLive = false;
    if (item.turnTrace && item.processRun?.defaultExpanded && item.turnTrace.items.some(child => isPermissionToolError(child.message))) {
      item.turnTrace.defaultExpanded = true;
    }
  }
  return grouped;
}

export function getTurnProcessMemberId(item: RenderableMessageItem): string {
  return String(item.turnTrace?.id || item.message.renderKey || item.message.compactionId
    || item.message.toolId || item.message.toolCallId || item.message.id || item.originalIndex);
}

export function turnProcessKey(scope: string, group: TurnProcessGroup) {
  return `${scope}:${group.id}`;
}

export function turnProcessRegionId(scope: string, group: TurnProcessGroup, member: string) {
  return `turn-process-region-${encodeURIComponent(`${scope}:${group.id}:${member}`)}`;
}

/** Keep process seats in place while their turn-level header controls visibility. */
function attachTurnProcessGroups(messages: ChatMessage[], items: RenderableMessageItem[], working: boolean) {
  const turns = createMessageTurns(messages);
  attachSummariesToTurns(messages, turns);
  const stopNotices: RenderableMessageItem[] = [];
  let cursor = 0;
  for (const [turnIndex, turn] of turns.entries()) {
    const turnItems: RenderableMessageItem[] = [];
    while (cursor < items.length && items[cursor].originalIndex < turn.end) turnItems.push(items[cursor++]);
    if (!turnItems.length) continue;
    const raw = messages.slice(turn.start, turn.end);
    const reversed = [...raw].reverse();
    const running = working && turnIndex === turns.length - 1;
    const artifacts = raw.flatMap(message => message.artifacts ?? []);
    const fileHost = reversed.find(message => message.type === 'assistant' && (message.turnId || message.runId))
      || reversed.find(message => message.turnId || message.runId);
    const turnId = fileHost?.turnId || fileHost?.runId;
    if (turnId || artifacts.length) {
      turnItems[turnItems.length - 1].turnFiles = { turnId, artifacts, visible: !running && turnIndex === turns.length - 1 };
    }
    const last = reversed.find(message => !message.isAgentActivity && !message.isAgentActivitySummary
      && !message.isCompactBoundary && !isEmptyAssistantShell(message));
    const reason = reversed.find(message => message.turnTiming?.finishReason)?.turnTiming?.finishReason;
    const summaryState = turn.summary?.message.state;
    const outcome: TurnProcessGroup['outcome'] = reason ? reason === 'completed' ? 'completed'
      : reason.startsWith('aborted') ? 'cancelled' : 'failed'
      : summaryState === 'completed' ? 'completed'
      : summaryState === 'cancelled' || raw.some(message => message.isInterruptedNotice) ? 'cancelled'
      : summaryState === 'failed' || raw.some(message => message.type === 'error') ? 'failed' : undefined;
    const interrupted = outcome === 'cancelled' || outcome === 'failed';
    const cancelled = !running && outcome === 'cancelled';
    const finalReply = last?.type === 'assistant' && !last.isThinking && !last.isToolUse
      && !last.isSubagentContainer && !last.isInteractivePrompt && !last.isTaskNotification && !last.isStreaming
      && (Boolean(last.content?.trim()) || Boolean(last.artifacts?.length));
    const completed = !running && !interrupted && (finalReply || turn.summary?.message.state === 'completed');
    const isReply = (item: RenderableMessageItem) => item.message.type === 'assistant' && !item.mediaArtifact && !item.turnTrace
      && !item.message.isThinking && !item.message.isToolUse && !item.message.isSubagentContainer
      && !item.message.isInteractivePrompt && !item.message.isTaskNotification
      && !item.message.isInterruptedNotice && !item.message.isAgentActivity && !item.message.isAgentActivitySummary;
    const output = cancelled ? undefined : [...turnItems].reverse().find(isReply);
    const seats = turnItems.filter(item => {
      if (item.mediaArtifact || item.message.type === 'error' || item.message.isInterruptedNotice) return false;
      if (item.turnTrace) return true;
      if (isReply(item)) return true;
      // Pending questions/approvals stay reachable until the user stops the turn.
      if (!completed && !cancelled && isPermissionToolError(item.message)) return false;
      if (!cancelled && isUserVisibleTool(item.message) && !item.message.toolResult) return false;
      return Boolean(item.message.isThinking || item.message.isToolUse || item.message.isSubagentContainer
        || (item.message.isInteractivePrompt && (completed || cancelled))
        || item.message.isTaskNotification || item.message.isCompactBoundary);
    });
    const members = seats.filter(item => item !== output);
    const durationMs = getTurnRunDurationMs(messages, turn);
    const timing = getRecordedTurnTiming(raw);
    if (!running && !seats.length && durationMs === null) continue;
    const anchor = messages[turn.start];
    const startedAtMs = parseMessageTime(anchor.timestamp);
    const group: TurnProcessGroup = {
      id: `turn-process-${String(anchor.renderKey || anchor.id || anchor.turnId || anchor.runId || turn.start)}`,
      isRunning: running, defaultExpanded: !completed && !cancelled && turnIndex === turns.length - 1, durationMs,
      outcome,
      hasRecordedDuration: Boolean(timing) || (typeof turn.summary?.message.durationMs === 'number' && Number.isFinite(turn.summary.message.durationMs)),
      startedAt: timing ? new Date(timing.startedAt).toISOString() : turn.summary?.message.startedAt || (startedAtMs !== null ? new Date(startedAtMs).toISOString() : undefined),
      memberIds: members.map(getTurnProcessMemberId),
    };
    for (const item of turnItems) { item.beforeRunAttachment = null; item.afterRunAttachment = null; }
    for (const item of seats) { item.processRun = group; item.processOutput = item === output; }
    if (running || members.length || durationMs !== null) {
      const user = turnItems.find(item => item.message.type === 'user');
      if (user) user.afterTurnProcess = group;
      else turnItems[0].beforeTurnProcess = group;
    }
    // Timing summaries can confirm a stop without a separate transcript
    // notice. Project one status row outside the fold; never persist or duplicate it.
    if (cancelled && !turnItems.some(item => item.message.isInterruptedNotice)) {
      const id = `${group.id}-interrupted`;
      stopNotices.push({
        message: { id, renderKey: id, type: 'system', content: '', isInterruptedNotice: true,
          timestamp: turn.summary?.message.endedAt || reversed[0]?.timestamp || anchor.timestamp },
        originalIndex: turn.end - 0.1,
        beforeRunAttachment: null, afterRunAttachment: null, beforeProcessAttachments: [], afterProcessAttachments: [],
      });
    }
  }
  return stopNotices.length ? [...items, ...stopNotices].sort((a, b) => a.originalIndex - b.originalIndex) : items;
}

export function getLiveProcessDetailMessages(messages: ChatMessage[]): ChatMessage[] {
  return getLiveProcessGroups(messages, { isAssistantWorking: true })
    .flatMap((group) => group.detailMessages);
}

/** Only flatten a real single call; never discard thinking, activity or interactive details. */
export function isSingleToolProcess(messages: ChatMessage[]): boolean {
  return messages.length === 1 && Boolean(messages[0].isToolUse)
    && isExpandableProcessMessage(messages[0])
    && !messages[0].isSubagentContainer && !messages[0].isInteractivePrompt;
}

export function splitLiveProcessGroupDetailMessages(group: LiveProcessGroup): {
  beforeStatusMessages: ChatMessage[];
  statusDetailMessages: ChatMessage[];
} {
  return {
    beforeStatusMessages: [],
    statusDetailMessages: group.detailMessages,
  };
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

    if (groupMessages.every((m) => m.isThinking)) {
      groupStartIndex = -1;
      groupMessages = [];
      return;
    }

    const first = groupMessages[0];
    const identityMessage = groupMessages.find((message) => message.toolId || message.toolCallId) || first;
    const detail = groupMessages.filter(isExpandableProcessMessage);
    const gid = getStableProcessSegmentId(messages, liveTurn, identityMessage, groupStartIndex);
    groups.push({
      id: gid,
      afterOriginalIndex: previousVisibleIndex,
      beforeOriginalIndex,
      startIndex: groupStartIndex,
      endIndex: beforeOriginalIndex ?? messages.length,
      messages: groupMessages,
      detailMessages: detail,
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

    if (isEmptyAssistantShell(message)) {
      continue;
    }

    finishGroup(index);
    previousVisibleIndex = index;
  }

  finishGroup(null);

  const result = groups.map((group) => {
    return {
      ...group,
      isRunning: Boolean(options.isAssistantWorking && group.messages.some(isPendingProcessMessage)),
    };
  });
  return result;
}

export function shouldRenderLiveProcessGroup(group: LiveProcessGroup, runMode: ChatRunMode): boolean {
  if (runMode !== 'plan') {
    return true;
  }
  return !group.messages.every((message) => message.isCompactBoundary);
}

const WEB_FETCH_TOOL_NAMES = new Set(['web_fetch', 'webfetch']);

export function isWebFetchToolMessage(message: ChatMessage): boolean {
  const normalized = String(message.toolName || '')
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return WEB_FETCH_TOOL_NAMES.has(normalized);
}

function getLatestToolMessage(group: LiveProcessGroup): ChatMessage | undefined {
  return [...group.messages].reverse().find((message) => message.isToolUse || message.type === 'tool');
}

export function isPendingProcessMessage(message: ChatMessage): boolean {
  return (message.isCompactBoundary && message.compactState === 'running') || isPendingToolUseMessage(message);
}

export function isPendingToolUseMessage(message: ChatMessage): boolean {
  if (!message.isToolUse && message.type !== 'tool') {
    return false;
  }
  // A successful empty result still represents a finished invocation.
  return message.toolResult == null;
}

export function shouldShowWebFetchWaitingHint(
  group: LiveProcessGroup,
  planModeActive: boolean,
): boolean {
  if (!planModeActive || !group.isRunning) {
    return false;
  }

  const latestTool = getLatestToolMessage(group);
  return Boolean(latestTool && isWebFetchToolMessage(latestTool) && isPendingToolUseMessage(latestTool));
}

export function hasPendingWebFetchInRunningGroup(
  groups: LiveProcessGroup[],
  planModeActive: boolean,
): boolean {
  if (!planModeActive) {
    return false;
  }

  return groups.some((group) => shouldShowWebFetchWaitingHint(group, planModeActive));
}

export function getWebFetchWaitingStep(
  groupId: string,
  t: TFunction<'chat'>,
): ProcessTraceStep {
  return {
    id: `${groupId}-web-fetch-waiting`,
    title: t('working.waitingForWebFetch', { defaultValue: 'Fetching web content...' }),
    phase: 'tool',
    state: 'running',
    toolName: 'web_fetch',
  };
}

function numberField(message: ChatMessage, key: string): number {
  const value = message[key];
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function formatCompletedProcessTitle(
  messageOrMessages: ChatMessage | ChatMessage[],
  t: TFunction<'chat'>,
): string {
  const counts: ProcessCounts = Array.isArray(messageOrMessages)
    ? collectProcessCounts(messageOrMessages)
    : {
        ...additionalActivityCounts(messageOrMessages),
        editedTargets: [],
        readTargets: [],
        searchCount: numberField(messageOrMessages, 'ragSearchCount'),
        fetchCount: numberField(messageOrMessages, 'webFetchCount'),
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
  for (const { field, label, verb, noun } of ACTIVITY_METRICS) {
    const count = counts[field];
    if (count > 0) labels.push(t(`process.live.${label}`, { count,
      defaultValue: `${verb} ${count} ${noun}${count === 1 ? '' : 's'}` }));
  }
  if (counts.searchCount > 0) {
    labels.push(t('process.live.searches', {
      count: counts.searchCount,
      defaultValue: `Searched ${counts.searchCount} ${counts.searchCount === 1 ? 'time' : 'times'}`,
    }));
  }
  if (counts.fetchCount > 0) {
    labels.push(t('process.live.webFetches', {
      count: counts.fetchCount,
      defaultValue: `Fetched ${counts.fetchCount} ${counts.fetchCount === 1 ? 'page' : 'pages'}`,
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
    const compactState = Array.isArray(messageOrMessages)
      ? messageOrMessages.find(message => message.isCompactBoundary
        && (message.compactState === 'failed' || message.compactState === 'cancelled'))?.compactState
      : messageOrMessages.compactState;
    labels.push(compactState === 'failed'
      ? t('working.compactFailed', { defaultValue: 'Context compaction failed' })
      : compactState === 'cancelled'
        ? t('working.compactCancelled', { defaultValue: 'Context compaction stopped' })
        : t('process.live.compactCompleted', { defaultValue: 'Compacted context' }));
  }
  if (counts.otherToolCount > 0) {
    labels.push(t('process.live.toolCalls', {
      count: counts.otherToolCount,
      defaultValue: `Used ${counts.otherToolCount} ${counts.otherToolCount === 1 ? 'tool' : 'tools'}`,
    }));
  }
  if (counts.thinkingCount > 0 && labels.length === 0) {
    labels.push(t('process.live.thoughtCompleted', { defaultValue: 'Thought through next step' }));
  }

  return labels.join(' ');
}

export function getRunningProcessTitle(
  group: LiveProcessGroup,
  t: TFunction<'chat'>,
): string {
  const latestMessage = [...group.messages].reverse().find(isPendingProcessMessage);
  if (!latestMessage) {
    return t('working.processing', { defaultValue: 'Processing' });
  }

  const kind = getProcessToolKind(latestMessage);
  const target = getDisplayTarget(getToolTarget(latestMessage));
  if (isWebFetchToolMessage(latestMessage)) {
    return t('working.waitingForWebFetch', { defaultValue: 'Fetching web content...' });
  }
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
    return t('working.thinking', { defaultValue: 'thinking' });
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
    !['generation', 'thinking', 'permission'].includes(fallbackPhase) &&
    Boolean(fallbackRunningStep?.toolId && group.messages.some((message) =>
      (message.toolId || message.toolCallId) === fallbackRunningStep.toolId && isPendingToolUseMessage(message)));
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
  const latestMessage = group.isRunning
    ? [...group.messages].reverse().find(isPendingProcessMessage)
    : group.messages[group.messages.length - 1];
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
    t,
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
