/**
 * Read a session's transcript and project it onto Web `WebMessage[]`.
 *
 * The Web UI cannot consume `CanonicalMessage[]` directly because the
 * shape leaks `tool_call_block` / `tool_result_block` / `thinking_block`
 * details that need merging. This reader is the Phase 2 contract:
 *
 *   sessionKey
 *     -> readTranscript(.jsonl)
 *     -> replayTranscriptEntries(...)
 *     -> CanonicalMessage[]
 *     -> WebMessage[]
 *
 * Pagination is offset-based (`cursor` is a stringified integer). We do
 * NOT slice individual content blocks within a message — paging cuts at
 * `WebMessage` boundaries.
 */

import {
  flattenToolResultBlockText,
  type CanonicalContentBlock,
  type CanonicalImageBlock,
  type CanonicalMessage,
} from "../../model/index.js";
import {
  projectSubagentReferences,
  projectWebHistory,
  readAgentProjectSessionPersistence,
  readSubagentProjectSessionPersistence,
  readTranscript,
  listProjectSessions,
  type AgentProjectSessionStorage,
  type WebTokenUsageProjectionResult,
} from "../../session/index.js";
import { readAgentProjectSessionTranscript } from "../../session/storage/ProjectSessionStorage.js";
import type { SessionCatalogPort, SessionInfo } from "../../session/catalog/SessionCatalogPort.js";
import type { ProjectSessionStorageProvider } from "../../session/storage/ProjectSessionStorageProvider.js";
import type {
  AgentSubagentCompletedTranscriptEntry,
  AgentSubagentStartedTranscriptEntry,
  AgentTranscriptEntry,
} from "../../session/transcript/TranscriptEntry.js";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { getPilotProjectChatDir } from "../../pilot/index.js";
import { sanitizeSessionIdForPath } from "../../session/storage/ProjectSessionStorage.js";
import type {
  WebReadSessionMessagesInput,
  WebReadSessionMessagesResult,
} from "../client/protocol.js";
import type { WebMessage, WebMessageKind, WebMessageRole } from "../client/webMessage.js";

export type ReadWebSessionMessagesOptions = {
  projectRoot: string;
  pilotHome: string;
  /** Application-selected read-only catalog used to resolve session metadata. */
  sessionCatalog?: SessionCatalogPort;
  /** @deprecated Use storageProvider plus sessionCatalog. */
  storage?: AgentProjectSessionStorage;
  /** Optional selected persistence backend for standard Agent session history. */
  storageProvider?: ProjectSessionStorageProvider;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  /** Override clock for deterministic tests. */
  now?: () => Date;
};

const DEFAULT_HISTORY_CONTEXT_TOKENS = 200_000;

export async function readWebSessionMessages(
  input: WebReadSessionMessagesInput,
  options: ReadWebSessionMessagesOptions,
): Promise<WebReadSessionMessagesResult> {
  const effectiveProjectRoot = input.projectKey ?? options.projectRoot;
  const chatDir = options.storage?.chatDir ?? getPilotProjectChatDir(effectiveProjectRoot, options.pilotHome);
  const transcriptPath = isBackgroundTaskInput(input)
    ? resolveTranscriptPath(input, chatDir)
    : options.storage?.transcriptPath ?? resolveTranscriptPath(input, chatDir);
  const isBackgroundTask = isBackgroundTaskInput(input);
  const { entries } = !isBackgroundTask && options.storage
    ? await readAgentProjectSessionTranscript(options.storage)
    : !isBackgroundTask && options.storageProvider
      ? await readAgentProjectSessionPersistence({
        projectRoot: effectiveProjectRoot,
        pilotHome: options.pilotHome,
        sessionId: input.sessionKey,
        storageProvider: options.storageProvider,
      })
      : await readTranscript(transcriptPath);
  const sessionInfo = isBackgroundTask ? undefined : await locateSession(input.sessionKey, entries, {
    ...options,
    projectRoot: effectiveProjectRoot,
  });
  const subagentReferences = projectSubagentReferences(entries);
  const historyProjection = projectWebHistory(entries);
  const webReplay = extractWebVisibleMessages(entries);
  const entryTimestamps = webReplay.timestamps;
  const entryIds = webReplay.entryIds;
  const entryTurnIds = webReplay.turnIds;
  const entrySequences = webReplay.sequences;
  const incompleteTurnIds = historyProjection.incompleteTurnIds;

  const flattenedPerMessage: WebMessage[][] = webReplay.messages
    .map((message, index) =>
      flattenCanonicalMessage(message, {
        index,
        sessionKey: input.sessionKey,
        projectKey: input.projectKey,
        now: options.now,
        entryTimestamp: entryTimestamps[index],
        entryId: entryIds[index],
        forkUnsupportedContent: webReplay.forkUnsupportedContents[index],
      }).map((webMessage) => ({
        ...webMessage,
        turnId: entryTurnIds[index],
        sequence: entrySequences[index],
      })),
    );

  const allMessages: WebMessage[] = flattenedPerMessage.flat();

  injectCompactBoundaryMessages(
    webReplay.compactBoundaries,
    allMessages,
    input.sessionKey,
    input.projectKey,
  );
  const subagentToolUses = attachSubagentIds(subagentReferences.started, allMessages);
  recoverCompletedSubagentToolResults(subagentReferences.completed, allMessages, subagentToolUses);
  if (resolve(effectiveProjectRoot) !== resolve(options.pilotHome)) {
    injectFileArtifactMessages(historyProjection.fileArtifacts, allMessages, input.sessionKey, input.projectKey);
  }
  injectAgentStatusMessages(historyProjection.agentStatuses, allMessages, input.sessionKey, input.projectKey);
  injectErrorTurnMessages(historyProjection.turnErrors, allMessages, input.sessionKey, input.projectKey);
  if (incompleteTurnIds.length > 0) {
    allMessages.push(createIncompleteTurnStatusMessage(input, incompleteTurnIds, options));
  }

  const offset = parseCursor(input.cursor);
  const limit = input.limit ?? allMessages.length;
  const sliceEnd = limit === 0 ? allMessages.length : offset + limit;
  const slice = allMessages.slice(offset, sliceEnd);

  return {
    messages: slice,
    nextCursor:
      input.limit && offset + slice.length < allMessages.length
        ? String(offset + slice.length)
        : undefined,
    total: allMessages.length,
    tokenUsage: tokenUsageFromProjection(historyProjection.tokenUsage, options),
    session: {
      sessionId: sessionInfo?.sessionId ?? input.sessionKey,
      sessionKey: input.sessionKey,
      summary: sessionInfo?.summary ?? input.sessionKey,
      lastModified: sessionInfo?.lastModified ?? 0,
      fileSize: sessionInfo?.fileSize,
      customTitle: sessionInfo?.customTitle,
      aiTitle: sessionInfo?.aiTitle,
      firstPrompt: sessionInfo?.firstPrompt,
      cwd: sessionInfo?.cwd,
      tag: sessionInfo?.tag,
      createdAt: sessionInfo?.createdAt,
      ...(isBackgroundTask ? { sessionKind: "background_task" as const } : {}),
      parentSessionId: input.parentSessionId ?? sessionInfo?.parentSessionId,
      relativeTranscriptPath: input.relativeTranscriptPath,
      forkedFromTurnId: sessionInfo?.forkedFromTurnId,
    },
  };
}

function tokenUsageFromProjection(
  projection: WebTokenUsageProjectionResult,
  options: Pick<ReadWebSessionMessagesOptions, "maxContextTokens" | "maxOutputTokens">,
): Record<string, unknown> | undefined {
  const latestBudget = projection.latestContextBudget;
  const latestCompact = projection.latestCompactBudget;
  if (latestCompact && (!latestBudget || latestCompact.index > latestBudget.index)) {
    return tokenUsageFromCompactBoundary(latestCompact, latestBudget?.usage, options);
  }
  if (latestBudget) {
    return latestBudget.usage;
  }
  const latestTurn = projection.latestTurnUsage;
  if (!latestTurn) {
    return undefined;
  }
  const inputTokens = positiveNumber(latestTurn.inputTokens);
  const outputTokens = positiveNumber(latestTurn.outputTokens) ?? 0;
  const cacheReadTokens = positiveNumber(latestTurn.cacheReadTokens) ?? 0;
  const cacheWriteTokens = positiveNumber(latestTurn.cacheWriteTokens) ?? 0;
  const totalTokens = positiveNumber(latestTurn.totalTokens);
  const used = inputTokens !== undefined
    ? Math.ceil(inputTokens + cacheReadTokens + cacheWriteTokens)
    : totalTokens !== undefined
      ? Math.max(0, Math.ceil(totalTokens - outputTokens))
      : undefined;
  if (used === undefined || used <= 0) {
    return undefined;
  }
  const total = positiveNumber(options.maxContextTokens) ?? DEFAULT_HISTORY_CONTEXT_TOKENS;
  const reservedOutputTokens = positiveNumber(options.maxOutputTokens) ?? 0;
  const effectiveTotal = Math.max(1, total - reservedOutputTokens);
  return {
    used,
    total,
    effectiveTotal,
    reservedOutputTokens,
    source: "history",
    exact: true,
    breakdown: {
      input: inputTokens ?? 0,
      cacheRead: cacheReadTokens,
      cacheWrite: cacheWriteTokens,
      output: outputTokens,
      total: totalTokens ?? Math.ceil(used + outputTokens),
    },
  };
}

function tokenUsageFromCompactBoundary(
  compact: NonNullable<WebTokenUsageProjectionResult["latestCompactBudget"]>,
  previousBudget: Record<string, unknown> | undefined,
  options: Pick<ReadWebSessionMessagesOptions, "maxContextTokens" | "maxOutputTokens">,
): Record<string, unknown> {
  const used = Math.ceil(compact.postTokens);
  const total = positiveNumber(previousBudget?.total)
    ?? positiveNumber(options.maxContextTokens)
    ?? DEFAULT_HISTORY_CONTEXT_TOKENS;
  const reservedOutputTokens = positiveNumber(previousBudget?.reservedOutputTokens)
    ?? positiveNumber(options.maxOutputTokens)
    ?? 0;
  const effectiveTotal = positiveNumber(previousBudget?.effectiveTotal)
    ?? Math.max(1, total - reservedOutputTokens);
  const ratio = used / effectiveTotal;
  const state = ratio >= 0.95 ? "blocking" : ratio >= 0.8 ? "warning" : "ok";
  return {
    used,
    displayUsed: used,
    budgetUsed: used,
    total,
    effectiveTotal,
    reservedOutputTokens,
    ratio,
    state,
    source: "compact",
    exact: false,
    compacted: true,
    ...(compact.preTokens !== undefined ? { preCompactUsed: compact.preTokens } : {}),
    ...(compact.messagesSummarized !== undefined ? { messagesSummarized: compact.messagesSummarized } : {}),
  };
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Read a subagent's sidechain transcript and project it onto WebMessage[].
 * Selected storage providers are addressed through the parent durable
 * `subagent_started` reference; legacy and background records retain the
 * constrained JSONL relative-path fallback.
 */
export async function readSubagentWebMessages(
  input: {
    sessionKey: string;
    subagentId: string;
    projectKey?: string;
    sessionKind?: "background_task";
    parentSessionId?: string;
    relativeTranscriptPath?: string;
  },
  options: ReadWebSessionMessagesOptions,
): Promise<{ messages: WebMessage[]; total: number }> {
  const effectiveProjectRoot = input.projectKey ?? options.projectRoot;
  const chatDir = options.storage?.chatDir ?? getPilotProjectChatDir(effectiveProjectRoot, options.pilotHome);
  const parentTranscriptPath = options.storage?.transcriptPath ?? resolveTranscriptPath(input, chatDir);
  const parentSessionId = input.parentSessionId ?? input.sessionKey;
  const isBackgroundTask = isBackgroundTaskInput(input);

  const { entries: parentEntries } = !isBackgroundTask && options.storage
    ? await readAgentProjectSessionTranscript(options.storage)
    : !isBackgroundTask && options.storageProvider
      ? await readAgentProjectSessionPersistence({
        projectRoot: effectiveProjectRoot,
        pilotHome: options.pilotHome,
        sessionId: parentSessionId,
        storageProvider: options.storageProvider,
      })
      : await readTranscript(parentTranscriptPath);
  const sidechainReference = projectSubagentReferences(parentEntries).startedById.get(input.subagentId);
  const sidechainRelative = sidechainReference?.transcriptRelativePath;

  if (!sidechainReference) {
    return { messages: [], total: 0 };
  }

  const { entries } = !isBackgroundTask && options.storage?.readTranscriptAtPath && sidechainRelative
    ? await options.storage.readTranscriptAtPath(resolveRelativeTranscriptPath(
        sidechainRelative,
        dirname(parentTranscriptPath),
        chatDir,
      ))
    : !isBackgroundTask && options.storageProvider && sidechainReference.subagentSessionId
      ? await readSubagentProjectSessionPersistence({
        projectRoot: effectiveProjectRoot,
        pilotHome: options.pilotHome,
        parentSessionId,
        sessionId: sidechainReference.subagentSessionId,
        sidechainId: input.subagentId,
        storageProvider: options.storageProvider,
      })
      : sidechainRelative
        ? await readTranscript(resolveRelativeTranscriptPath(
          sidechainRelative,
          dirname(parentTranscriptPath),
          chatDir,
        ))
        : { entries: [] };
  const webReplay = extractSubagentExecutionMessages(entries);

  const flattenedPerMessage: WebMessage[][] = webReplay.messages
    .filter((message) => !message.metadata?.synthetic)
    .map((message, index) =>
      flattenCanonicalMessage(message, {
        index,
        sessionKey: `${input.sessionKey}::sub::${input.subagentId}`,
        projectKey: input.projectKey,
        now: options.now,
        entryTimestamp: webReplay.timestamps[index],
        entryId: webReplay.entryIds[index],
      }).map((webMessage) => ({
        ...webMessage,
        turnId: webReplay.turnIds[index],
        sequence: webReplay.sequences[index],
      })),
    );
  const allMessages: WebMessage[] = flattenedPerMessage.flat();
  injectCompactBoundaryMessages(
    webReplay.compactBoundaries,
    allMessages,
    `${input.sessionKey}::sub::${input.subagentId}`,
    input.projectKey,
  );

  return { messages: allMessages, total: allMessages.length };
}

function isBackgroundTaskInput(input: {
  sessionKind?: string;
  relativeTranscriptPath?: string;
}): input is { sessionKind: "background_task"; relativeTranscriptPath: string } {
  return input.sessionKind === "background_task" &&
    typeof input.relativeTranscriptPath === "string" &&
    input.relativeTranscriptPath.length > 0;
}

function resolveTranscriptPath(
  input: {
    sessionKey: string;
    sessionKind?: string;
    relativeTranscriptPath?: string;
  },
  chatDir: string,
): string {
  if (isBackgroundTaskInput(input)) {
    return resolveRelativeTranscriptPath(input.relativeTranscriptPath, chatDir, chatDir);
  }
  return resolve(chatDir, `${sanitizeSessionIdForPath(input.sessionKey)}.jsonl`);
}

function resolveRelativeTranscriptPath(
  path: string,
  baseDir: string,
  allowedRoot: string,
): string {
  if (!path || isAbsolute(path)) {
    throw new Error("relativeTranscriptPath must be a relative path.");
  }
  const candidate = resolve(baseDir, path);
  if (!isWithinDirectory(allowedRoot, candidate) || !candidate.endsWith(".jsonl")) {
    throw new Error("relativeTranscriptPath points outside the project transcript directory.");
  }
  return candidate;
}

function isWithinDirectory(parentDir: string, candidatePath: string): boolean {
  const rel = relative(parentDir, candidatePath);
  return Boolean(rel) && !rel.startsWith("..") && !isAbsolute(rel);
}

function createIncompleteTurnStatusMessage(
  input: WebReadSessionMessagesInput,
  turnIds: string[],
  options: ReadWebSessionMessagesOptions,
): WebMessage {
  const stamp = (options.now ?? (() => new Date()))().toISOString();
  return {
    id: `${input.sessionKey}-incomplete-turn-status-${turnIds.join("-")}`,
    sessionKey: input.sessionKey,
    projectKey: input.projectKey,
    createdAt: stamp,
    provider: "pilotdeck",
    role: "system",
    kind: "status",
    text: "本轮记录尚未写入最终结果，已恢复当时产生的工具调用和输出。",
    payload: { incompleteTurnIds: turnIds },
    source: "history",
  };
}

async function locateSession(
  sessionKey: string,
  entries: readonly AgentTranscriptEntry[],
  options: ReadWebSessionMessagesOptions,
): Promise<SessionInfo | undefined> {
  let sessions: SessionInfo[];
  try {
    sessions = options.sessionCatalog
      ? await options.sessionCatalog.list({
          projectRoot: options.projectRoot,
          pilotHome: options.pilotHome,
        })
      : await listProjectSessions({
          projectRoot: options.projectRoot,
          pilotHome: options.pilotHome,
          ...(options.storage ? { chatDir: options.storage.chatDir } : {}),
        });
  } catch (error) {
    // Exact-session history already has durable entries from the selected
    // provider. Catalog enumeration is optional and must not force a JSONL
    // fallback for this direct read.
    if (!options.storageProvider && !options.storage) throw error;
    return sessionInfoFromEntries(sessionKey, entries, options.projectRoot);
  }
  // sessionId in SessionInfo is the on-disk filename (already sanitized);
  // the incoming sessionKey may still be the raw form (e.g. tui:project=/foo:default).
  // Compare against the sanitized form so locating works for both shapes.
  const safeKey = sanitizeSessionIdForPath(sessionKey);
  return sessions.find(
    (session) => session.sessionId === sessionKey || session.sessionId === safeKey,
  ) ?? sessionInfoFromEntries(sessionKey, entries, options.projectRoot);
}

function sessionInfoFromEntries(
  sessionId: string,
  entries: readonly AgentTranscriptEntry[],
  projectRoot: string,
): SessionInfo | undefined {
  if (entries.length === 0) return undefined;
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  let tag: string | undefined;
  let firstPrompt: string | undefined;
  let lastPrompt: string | undefined;
  let parentSessionId: string | undefined;
  let forkedFromTurnId: string | undefined;
  for (const entry of entries) {
    if (entry.type === "accepted_input") {
      for (const message of entry.messages) {
        const text = message.content.find((block) => block.type === "text")?.text?.trim();
        if (!text) continue;
        firstPrompt ??= text;
        lastPrompt = text;
      }
      continue;
    }
    if (entry.type !== "session_metadata") continue;
    customTitle = entry.metadata.title ?? customTitle;
    aiTitle = entry.metadata.aiTitle ?? aiTitle;
    tag = entry.metadata.tag ?? tag;
    firstPrompt = entry.metadata.firstPrompt ?? firstPrompt;
    lastPrompt = entry.metadata.lastPrompt ?? lastPrompt;
    parentSessionId = entry.metadata.parentSessionId ?? parentSessionId;
    forkedFromTurnId = entry.metadata.forkedFromTurnId ?? forkedFromTurnId;
  }
  const createdAt = Date.parse(entries[0]!.createdAt);
  const lastModified = Date.parse(entries[entries.length - 1]!.createdAt);
  return {
    sessionId,
    summary: customTitle ?? aiTitle ?? lastPrompt ?? firstPrompt ?? sessionId,
    lastModified: Number.isFinite(lastModified) ? lastModified : 0,
    customTitle,
    aiTitle,
    firstPrompt,
    cwd: projectRoot,
    tag,
    ...(Number.isFinite(createdAt) ? { createdAt } : {}),
    parentSessionId,
    forkedFromTurnId,
  };
}

function parseCursor(cursor?: string): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

type ProjectionContext = {
  index: number;
  sessionKey: string;
  projectKey?: string;
  now?: () => Date;
  /** Actual transcript entry timestamp — preferred over now(). */
  entryTimestamp?: string;
  /** Transcript entry id for fork targeting. */
  entryId?: string;
  /** True when this entry cannot be fork-prefilled losslessly by the web UI. */
  forkUnsupportedContent?: boolean;
};

/**
 * Flatten a CanonicalMessage's content blocks into one or more WebMessages.
 * Adjacent legacy text blocks merge; identified model blocks stay distinct.
 *
 * Tool-result images get special handling: when an `image` block immediately
 * follows a `tool_result` block (as produced by `projectToolResults`), the
 * image is attached to that tool_result WebMessage instead of being emitted as
 * a separate user-role text message. Without this, read_file image responses
 * would render as a "user" bubble on the right side of the chat — see
 * https://github.com/ — the canonical wire format requires role=user, but the
 * UI semantics want the picture rendered alongside the tool result on the
 * assistant/tool side.
 */
export function flattenCanonicalMessage(
  message: CanonicalMessage,
  context: ProjectionContext,
): WebMessage[] {
  const stamp = context.entryTimestamp ?? (context.now ?? (() => new Date()))().toISOString();
  const out: WebMessage[] = [];
  const role: WebMessageRole = message.role === "user" ? "user" : "assistant";
  let textBuffer = "";
  let textBlockId: string | undefined;
  let textTimeline: CanonicalContentBlock["timeline"];
  let pendingImages: NonNullable<WebMessage["images"]> = [];
  let lastToolResultMessage: WebMessage | undefined;

  const flushText = (): void => {
    if (!textBuffer && pendingImages.length === 0) return;
    out.push({
      id: `${context.sessionKey}-msg-${context.index}-${out.length}`,
      sessionKey: context.sessionKey,
      projectKey: context.projectKey,
      createdAt: stamp,
      provider: "pilotdeck",
      role,
      kind: "text",
      text: textBuffer,
      ...(textBlockId ? { blockId: textBlockId } : {}),
      ...(textTimeline ? { timeline: textTimeline } : {}),
      ...(role === "assistant" && typeof message.metadata?.model === "string" ? { model: message.metadata.model } : {}),
      ...(pendingImages.length > 0 ? { images: pendingImages } : {}),
      ...(context.forkUnsupportedContent
        ? {
            payload: {
              forkUnsupportedContent: true,
              forkUnsupportedReason: "This turn contains attachments or media.",
            },
          }
        : {}),
      ...(context.entryId ? { entryId: context.entryId } : {}),
      source: "history",
    });
    textBuffer = "";
    textBlockId = undefined;
    textTimeline = undefined;
    pendingImages = [];
  };

  for (const block of message.content) {
    if (block.type === 'text') {
      if (textBlockId !== block.blockId) flushText();
      textBlockId = block.blockId;
      textTimeline = block.timeline;
    }
    if (block.type !== "image" && block.type !== "tool_result") {
      // Any other block breaks the tool_result → image association.
      lastToolResultMessage = undefined;
    }
    if (block.type === "image" && lastToolResultMessage && role === "user") {
      const existing = lastToolResultMessage.images ?? [];
      lastToolResultMessage.images = [...existing, toWebMessageImage(block)];
      continue;
    }
    flushBlock(block, out, context, stamp, role, () => {
      flushText();
    }, (chunk) => {
      textBuffer += chunk;
    }, (image) => {
      pendingImages.push(toWebMessageImage(image));
    });
    if (block.type !== "text" && block.timeline && out.length) out[out.length - 1].timeline = block.timeline;
    if (block.type === "tool_result") {
      lastToolResultMessage = out[out.length - 1];
    }
  }
  flushText();
  const queueItemId = message.metadata?.queueItemId;
  const moduleId = message.metadata?.moduleId;
  if (typeof queueItemId === "string" && queueItemId) {
    for (const webMessage of out) {
      webMessage.queueItemId = queueItemId;
    }
  }
  if (typeof moduleId === "string" && moduleId) {
    for (const webMessage of out) webMessage.moduleId = moduleId;
  }
  return out;
}

function flushBlock(
  block: CanonicalContentBlock,
  out: WebMessage[],
  context: ProjectionContext,
  stamp: string,
  role: WebMessageRole,
  flushText: () => void,
  appendText: (chunk: string) => void,
  appendImage: (image: CanonicalImageBlock) => void,
): void {
  switch (block.type) {
    case "text":
      appendText(block.text);
      return;
    case "thinking":
      flushText();
      out.push({
        id: `${context.sessionKey}-thinking-${context.index}-${out.length}`,
        sessionKey: context.sessionKey,
        projectKey: context.projectKey,
        createdAt: stamp,
        provider: "pilotdeck",
        role: "assistant",
        kind: "thinking",
        text: block.text,
        ...(block.blockId ? { blockId: block.blockId } : {}),
        source: "history",
      });
      return;
    case "tool_call":
      flushText();
      out.push({
        id: `${context.sessionKey}-tool-${context.index}-${block.id}`,
        sessionKey: context.sessionKey,
        projectKey: context.projectKey,
        createdAt: stamp,
        provider: "pilotdeck",
        role: "tool",
        kind: "tool_use",
        toolCallId: block.id,
        toolName: block.name,
        payload: block.input,
        source: "history",
      });
      return;
    case "tool_result": {
      flushText();
      const resultText = flattenToolResultBlockText(block);
      const errorCode = readToolResultErrorCode(block.raw);
      const toolName = readToolResultToolName(block.raw);
      const planData = readPlanData(block.raw);
      const searchData = readSearchToolData(block.raw);
      const resultImages: NonNullable<WebMessage["images"]> = [];
      for (const sub of block.content) {
        if (sub.type === "image") {
          resultImages.push(toWebMessageImage(sub));
        }
      }
      out.push({
        id: `${context.sessionKey}-tool-${context.index}-${block.toolCallId}-result`,
        sessionKey: context.sessionKey,
        projectKey: context.projectKey,
        createdAt: stamp,
        provider: "pilotdeck",
        role: "tool",
        kind: "tool_result",
        toolCallId: block.toolCallId,
        ...(toolName ? { toolName } : {}),
        ok: !block.isError,
        text: resultText,
        ...(errorCode ? { errorCode } : {}),
        ...(planData || searchData ? { payload: planData ?? searchData } : {}),
        ...(resultImages.length > 0 ? { images: resultImages } : {}),
        source: "history",
      });
      return;
    }
    case "tool_result_reference":
      flushText();
      out.push({
        id: `${context.sessionKey}-tool-${context.index}-${block.toolCallId}-result-ref`,
        sessionKey: context.sessionKey,
        projectKey: context.projectKey,
        createdAt: stamp,
        provider: "pilotdeck",
        role: "tool",
        kind: "tool_result",
        toolCallId: block.toolCallId,
        ok: !block.isError,
        text: block.preview,
        resultPath: block.path,
        payload: {
          path: block.path,
          originalBytes: block.originalBytes,
          hasMore: block.hasMore,
          mimeType: block.mimeType,
          reason: block.reason,
        },
        source: "history",
      });
      return;
    case "media_reference":
      flushText();
      out.push({
        id: `${context.sessionKey}-media-${context.index}-${out.length}`,
        sessionKey: context.sessionKey,
        projectKey: context.projectKey,
        createdAt: stamp,
        provider: "pilotdeck",
        role: "tool",
        kind: "tool_result",
        toolCallId: block.toolCallId,
        ok: true,
        text: block.preview,
        payload: {
          path: block.path,
          originalBytes: block.originalBytes,
          hasMore: block.hasMore,
          mimeType: block.mimeType,
          mediaType: block.mediaType,
          pages: block.pages,
          detail: block.detail,
          reason: block.reason,
        },
        source: "history",
      });
      return;
    case "image":
      if (role === "user") {
        appendImage(block);
        return;
      }
      flushText();
      out.push({
        id: `${context.sessionKey}-attachment-${context.index}-${out.length}`,
        sessionKey: context.sessionKey,
        projectKey: context.projectKey,
        createdAt: stamp,
        provider: "pilotdeck",
        role,
        kind: "status",
        text: `[${block.type} attachment]`,
        payload: { mimeType: block.mimeType, bytes: "bytes" in block ? block.bytes : undefined },
        source: "history",
      });
      return;
    case "pdf":
    case "audio":
      flushText();
      const kind: WebMessageKind = "status";
      out.push({
        id: `${context.sessionKey}-attachment-${context.index}-${out.length}`,
        sessionKey: context.sessionKey,
        projectKey: context.projectKey,
        createdAt: stamp,
        provider: "pilotdeck",
        role,
        kind,
        text: `[${block.type} attachment]`,
        payload: { mimeType: block.mimeType, bytes: "bytes" in block ? block.bytes : undefined },
        source: "history",
      });
      return;
  }
}

function toWebMessageImage(block: CanonicalImageBlock): NonNullable<WebMessage["images"]>[number] {
  return {
    data: block.source === "url" ? block.data : `data:${block.mimeType};base64,${block.data}`,
    mimeType: block.mimeType,
  };
}

/**
 * Web history is allowed to show persisted messages from incomplete turns so
 * users do not lose tool calls they already saw live. Keep this projection
 * local to the web reader: the core transcript replay still skips incomplete
 * durable messages so agent resume never feeds half-finished tool histories
 * back to the model.
 */
type CompactBoundaryInfo = {
  timestamp: string;
  turnId: string;
  sequence: number;
  entryId?: string;
  metadata?: Record<string, unknown>;
};

function isCompactReplacementMessage(message: CanonicalMessage): boolean {
  return message.metadata?.compactReplacement === true;
}

function shouldShowCompactReplacementInWeb(message: CanonicalMessage): boolean {
  return !isCompactReplacementMessage(message);
}

function compactBoundaryMetadata(entry: AgentTranscriptEntry & { type: "control_boundary" }): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  if (
    entry.boundary.kind === "compact" &&
    "subtype" in entry.boundary &&
    entry.boundary.subtype === "compact_boundary" &&
    "compactMetadata" in entry.boundary
  ) {
    const cm = entry.boundary.compactMetadata as Record<string, unknown>;
    if (cm.timeline) meta.timeline = cm.timeline;
    if (typeof cm.compactionId === "string" && cm.compactionId.length > 0) {
      meta.compactionId = cm.compactionId;
    }
    meta.trigger = cm.trigger;
    meta.preTokens = cm.preTokens;
    meta.postTokens = cm.postTokens;
    meta.messagesSummarized = cm.messagesSummarized;
    if (typeof cm.targetTokens === "number") meta.targetTokens = cm.targetTokens;
    if (typeof cm.summaryGenerated === "boolean") meta.summaryGenerated = cm.summaryGenerated;
    if (typeof cm.checkpointMerged === "boolean") meta.checkpointMerged = cm.checkpointMerged;
    if (typeof cm.finalRatio === "number") meta.finalRatio = cm.finalRatio;
    meta.level = cm.level;
    meta.stage = cm.stage;
    meta.stageLabel = cm.stageLabel;
  }
  return meta;
}

function extractWebVisibleMessages(entries: AgentTranscriptEntry[]): {
  messages: CanonicalMessage[];
  timestamps: string[];
  entryIds: Array<string | undefined>;
  turnIds: string[];
  sequences: number[];
  forkUnsupportedContents: boolean[];
  compactBoundaries: CompactBoundaryInfo[];
} {
  const messages: CanonicalMessage[] = [];
  const timestamps: string[] = [];
  const entryIds: Array<string | undefined> = [];
  const turnIds: string[] = [];
  const sequences: number[] = [];
  const forkUnsupportedContents: boolean[] = [];
  const compactBoundaries: CompactBoundaryInfo[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    switch (entry.type) {
      case "accepted_input":
        {
          const entryForkUnsupported = entry.messages.some((message) =>
            message.content.some((block) => block.type !== "text"),
          );
          for (const message of entry.messages) {
            if (message.metadata?.synthetic) {
              continue;
            }
            if (!shouldShowCompactReplacementInWeb(message)) {
              continue;
            }
            messages.push(cloneMessage(message));
            timestamps.push(entry.createdAt);
            entryIds.push(entry.entryId);
            turnIds.push(entry.turnId);
            sequences.push(entry.sequence);
            forkUnsupportedContents.push(entryForkUnsupported);
          }
        }
        break;
      case "assistant_message":
      case "tool_result_message":
      case "durable_message":
        if (entry.message.metadata?.synthetic) {
          break;
        }
        if (!shouldShowCompactReplacementInWeb(entry.message)) {
          break;
        }
        messages.push(cloneMessage(entry.message));
        timestamps.push(entry.createdAt);
        entryIds.push(entry.entryId);
        turnIds.push(entry.turnId);
        sequences.push(entry.sequence);
        forkUnsupportedContents.push(false);
        break;
      case "control_boundary": {
        if (entry.boundary && entry.boundary.kind === "compact") {
          compactBoundaries.push({
            timestamp: entry.createdAt,
            turnId: entry.turnId,
            sequence: entry.sequence,
            entryId: entry.entryId,
            metadata: compactBoundaryMetadata(entry),
          });
        }
        break;
      }
    }
  }

  return {
    messages,
    timestamps,
    entryIds,
    turnIds,
    sequences,
    forkUnsupportedContents,
    compactBoundaries,
  };
}

function extractSubagentExecutionMessages(entries: AgentTranscriptEntry[]): {
  messages: CanonicalMessage[];
  timestamps: string[];
  entryIds: Array<string | undefined>;
  turnIds: string[];
  sequences: number[];
  compactBoundaries: CompactBoundaryInfo[];
} {
  const messages: CanonicalMessage[] = [];
  const timestamps: string[] = [];
  const entryIds: Array<string | undefined> = [];
  const turnIds: string[] = [];
  const sequences: number[] = [];
  const compactBoundaries: CompactBoundaryInfo[] = [];
  let sawExecutionMessage = false;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];

    switch (entry.type) {
      case "accepted_input":
        // Sidechain accepted_input is the fork prelude: parent assistant
        // context + fork directive. It is model input, not subagent output.
        break;
      case "assistant_message":
      case "tool_result_message":
      case "durable_message":
        sawExecutionMessage = true;
        if (entry.message.metadata?.synthetic || !shouldShowCompactReplacementInWeb(entry.message)) {
          break;
        }
        messages.push(cloneMessage(entry.message));
        timestamps.push(entry.createdAt);
        entryIds.push(entry.entryId);
        turnIds.push(entry.turnId);
        sequences.push(entry.sequence);
        break;
      case "control_boundary": {
        if (
          sawExecutionMessage &&
          entry.boundary &&
          entry.boundary.kind === "compact"
        ) {
          compactBoundaries.push({
            timestamp: entry.createdAt,
            turnId: entry.turnId,
            sequence: entry.sequence,
            entryId: entry.entryId,
            metadata: compactBoundaryMetadata(entry),
          });
        }
        break;
      }
    }
  }

  return { messages, timestamps, entryIds, turnIds, sequences, compactBoundaries };
}

function cloneMessage(message: CanonicalMessage): CanonicalMessage {
  return JSON.parse(JSON.stringify(message)) as CanonicalMessage;
}

function injectCompactBoundaryMessages(
  boundaries: CompactBoundaryInfo[],
  allMessages: WebMessage[],
  sessionKey: string,
  projectKey?: string,
): void {
  for (const boundary of boundaries) {
    const message: WebMessage = {
      id: boundary.entryId ?? `${sessionKey}-compact-${boundary.turnId}-${boundary.sequence}`,
      sessionKey,
      projectKey,
      createdAt: boundary.timestamp,
      provider: "pilotdeck",
      role: "system",
      kind: "compact_boundary",
      ...(boundary.metadata?.timeline ? { timeline: boundary.metadata.timeline as WebMessage["timeline"] } : {}),
      turnId: boundary.turnId,
      sequence: boundary.sequence,
      text: "Context compacted",
      payload: boundary.metadata ?? {},
      source: "history",
      ...(boundary.entryId ? { entryId: boundary.entryId } : {}),
    };
    insertWebMessageByTranscriptOrder(allMessages, message);
  }
}

function insertWebMessageByTranscriptOrder(
  allMessages: WebMessage[],
  message: WebMessage,
): void {
  if (Number.isFinite(message.sequence)) {
    const insertAt = allMessages.findIndex((candidate) =>
      Number.isFinite(candidate.sequence) && candidate.sequence! > message.sequence!,
    );
    allMessages.splice(insertAt === -1 ? allMessages.length : insertAt, 0, message);
    return;
  }

  let insertAt = allMessages.length;
  for (let index = allMessages.length - 1; index >= 0; index -= 1) {
    if (allMessages[index].createdAt <= message.createdAt) {
      insertAt = index + 1;
      break;
    }
    if (index === 0) insertAt = 0;
  }
  allMessages.splice(insertAt, 0, message);
}

/**
 * Correlate `subagent_started` transcript entries with their parent `tool_use`
 * (agent/Task) WebMessages by matching order within entries, then stamp
 * `subagentId` onto the WebMessage so the frontend can link to the sidechain.
 */
function attachSubagentIds(
  startedEntries: readonly AgentSubagentStartedTranscriptEntry[],
  allMessages: WebMessage[],
): Map<string, WebMessage> {
  const toolUseBySubagentId = new Map<string, WebMessage>();
  const subagentQueue = startedEntries.map((entry) => entry.subagentId);
  if (subagentQueue.length === 0) return toolUseBySubagentId;

  let qi = 0;
  for (const msg of allMessages) {
    if (qi >= subagentQueue.length) break;
    if (msg.kind !== "tool_use") continue;
    const name = String(msg.toolName ?? "").toLowerCase();
    if (name !== "agent" && name !== "task") continue;
    const subagentId = subagentQueue[qi];
    msg.subagentId = subagentId;
    toolUseBySubagentId.set(subagentId, msg);
    qi += 1;
  }
  return toolUseBySubagentId;
}

/**
 * Concurrent Agent calls project their tool results as a batch. If the parent
 * turn is aborted after one child has already completed, that child's
 * `subagent_completed` entry is durable but its parent tool result may never
 * be written. Recreate only successful missing results so history preserves
 * the completed child while unfinished/failed siblings still use terminal
 * parent-state handling.
 */
function recoverCompletedSubagentToolResults(
  completedEntries: readonly AgentSubagentCompletedTranscriptEntry[],
  allMessages: WebMessage[],
  toolUseBySubagentId: Map<string, WebMessage>,
): void {
  const existingResults = new Set(
    allMessages
      .filter((message) => message.kind === "tool_result" && message.toolCallId)
      .map((message) => `${message.turnId ?? ""}\u0000${message.toolCallId}`),
  );

  for (const entry of completedEntries) {
    if (entry.errored === true) continue;
    const toolUse = toolUseBySubagentId.get(entry.subagentId);
    if (!toolUse?.toolCallId) continue;

    const resultKey = `${toolUse.turnId ?? ""}\u0000${toolUse.toolCallId}`;
    if (existingResults.has(resultKey)) continue;

    insertWebMessageByTranscriptOrder(allMessages, {
      id: `${toolUse.id}-subagent-result`,
      sessionKey: toolUse.sessionKey,
      projectKey: toolUse.projectKey,
      createdAt: entry.createdAt,
      provider: "pilotdeck",
      role: "tool",
      kind: "tool_result",
      turnId: toolUse.turnId ?? entry.turnId,
      sequence: entry.sequence,
      toolCallId: toolUse.toolCallId,
      toolName: toolUse.toolName,
      ok: true,
      text: entry.summaryPreview,
      source: "history",
      ...(entry.entryId ? { entryId: entry.entryId } : {}),
    });
    existingResults.add(resultKey);
  }
}

function injectFileArtifactMessages(
  entries: Extract<AgentTranscriptEntry, { type: "file_artifacts" }>[],
  allMessages: WebMessage[],
  sessionKey: string,
  projectKey?: string,
): void {
  const artifactMessages: WebMessage[] = [];
  for (const entry of entries) {
    artifactMessages.push({
      id: entry.entryId ?? `${sessionKey}-file-artifacts-${entry.turnId}-${entry.sequence}`,
      sessionKey,
      projectKey,
      createdAt: entry.createdAt,
      provider: "pilotdeck",
      role: "assistant",
      kind: "file_artifacts",
      turnId: entry.turnId,
      sequence: entry.sequence,
      artifacts: entry.artifacts,
      payload: { turnId: entry.turnId },
      source: "history",
      ...(entry.entryId ? { entryId: entry.entryId } : {}),
    });
  }

  for (const artifactMessage of artifactMessages) {
    insertWebMessageByTranscriptOrder(allMessages, artifactMessage);
  }
}

/**
 * Scan transcript entries for failed turns (`turn_result` with `type === "error"`)
 * and inject corresponding `WebMessage { kind: 'error' }` into the message list
 * so error banners survive history reload when no visible semantic status
 * already represents the same turn.
 */
function injectErrorTurnMessages(
  entries: Extract<AgentTranscriptEntry, { type: "turn_result" }>[],
  allMessages: WebMessage[],
  sessionKey: string,
  projectKey?: string,
): void {
  const errorMessages: WebMessage[] = [];
  for (const entry of entries) {
    const errorTexts = entry.result.errors?.map((e) => e.message).filter(Boolean) ?? [];
    const text = errorTexts.length > 0
      ? errorTexts.join("\n")
      : `Turn failed: ${entry.result.stopReason}`;
    errorMessages.push({
      id: `${sessionKey}-turn-error-${entry.turnId}`,
      sessionKey,
      projectKey,
      createdAt: entry.createdAt,
      provider: "pilotdeck",
      role: "error",
      kind: "error",
      turnId: entry.turnId,
      sequence: entry.sequence,
      text,
      payload: { code: entry.result.stopReason, recoverable: false },
      source: "history",
    });
  }
  if (errorMessages.length === 0) return;

  for (const errMsg of errorMessages) {
    insertWebMessageByTranscriptOrder(allMessages, errMsg);
  }
}

function injectAgentStatusMessages(
  entries: Extract<AgentTranscriptEntry, { type: "agent_status_message" }>[],
  allMessages: WebMessage[],
  sessionKey: string,
  projectKey?: string,
): void {
  const statusMessages: WebMessage[] = [];
  for (const entry of entries) {
    statusMessages.push({
      id: entry.entryId ?? `${sessionKey}-agent-status-${entry.turnId}-${entry.sequence}`,
      sessionKey,
      projectKey,
      createdAt: entry.createdAt,
      provider: "pilotdeck",
      role: entry.kind === "error" ? "error" : "system",
      kind: entry.kind,
      turnId: entry.turnId,
      sequence: entry.sequence,
      text: entry.text,
      ...(isI18nDescriptor(entry.detail?.messageI18n) ? { contentI18n: entry.detail.messageI18n } : {}),
      ...(isI18nDescriptor(entry.detail?.userHintI18n) ? { userHintI18n: entry.detail.userHintI18n } : {}),
      payload: { event: entry.event, ...(entry.detail ? { detail: entry.detail } : {}) },
      source: "history",
    });
  }
  if (statusMessages.length === 0) return;

  for (const statusMsg of statusMessages) {
    insertWebMessageByTranscriptOrder(allMessages, statusMsg);
  }
}

function isI18nDescriptor(value: unknown): value is { key: string; params?: Record<string, unknown> } {
  return typeof value === "object"
    && value !== null
    && typeof (value as { key?: unknown }).key === "string";
}

function readToolResultErrorCode(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const error = (raw as { error?: unknown }).error;
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

function readToolResultToolName(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const toolName = (raw as { toolName?: unknown }).toolName;
  return typeof toolName === "string" && toolName.length > 0 ? toolName : undefined;
}

function readPlanData(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const data = (raw as { data?: unknown }).data;
  if (!data || typeof data !== "object") return undefined;
  const d = data as Record<string, unknown>;
  if (typeof d.planFilePath !== "string") return undefined;
  return {
    planFilePath: d.planFilePath,
    planTitle: d.planTitle,
    planSummary: d.planSummary,
  };
}

function readSearchToolData(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as { toolName?: unknown; data?: unknown };
  if (!isSearchToolName(record.toolName)) return undefined;
  return record.data && typeof record.data === "object"
    ? record.data as Record<string, unknown>
    : undefined;
}

function isSearchToolName(name: unknown): boolean {
  const normalized = typeof name === "string" ? name.toLowerCase() : "";
  return normalized === "grep" || normalized === "glob";
}
