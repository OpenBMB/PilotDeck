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
import { listProjectSessions, readTranscript, findLastCompactBoundaryIndex, type SessionInfo } from "../../session/index.js";
import type { AgentTranscriptEntry } from "../../session/transcript/TranscriptEntry.js";
import { resolve, dirname } from "node:path";
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
  /** Override clock for deterministic tests. */
  now?: () => Date;
};

export async function readWebSessionMessages(
  input: WebReadSessionMessagesInput,
  options: ReadWebSessionMessagesOptions,
): Promise<WebReadSessionMessagesResult> {
  const effectiveProjectRoot = input.projectKey ?? options.projectRoot;
  const sessionInfo = await locateSession(input.sessionKey, {
    ...options,
    projectRoot: effectiveProjectRoot,
  });
  const transcriptPath = resolve(
    getPilotProjectChatDir(effectiveProjectRoot, options.pilotHome),
    `${sanitizeSessionIdForPath(input.sessionKey)}.jsonl`,
  );
  const { entries } = await readTranscript(transcriptPath);
  const webReplay = extractWebVisibleMessages(entries);
  const entryTimestamps = webReplay.timestamps;
  const incompleteTurnIds = extractIncompleteTurnIds(entries);

  const flattenedPerMessage: WebMessage[][] = webReplay.messages
    .filter((message) => !message.metadata?.synthetic)
    .map((message, index) =>
      flattenCanonicalMessage(message, {
        index,
        sessionKey: input.sessionKey,
        projectKey: input.projectKey,
        now: options.now,
        entryTimestamp: entryTimestamps[index],
        entryId: webReplay.entryIds[index],
      }),
    );

  const cumulativeWebCounts: number[] = [];
  let cumulative = 0;
  for (const group of flattenedPerMessage) {
    cumulative += group.length;
    cumulativeWebCounts.push(cumulative);
  }

  const allMessages: WebMessage[] = flattenedPerMessage.flat();

  for (const boundary of [...webReplay.compactBoundaries].reverse()) {
    const insertPos =
      boundary.insertAfterMessageIndex >= 0
        ? (cumulativeWebCounts[boundary.insertAfterMessageIndex] ?? 0)
        : 0;
    const meta = boundary.metadata ?? {};
    const compactMsg: WebMessage = {
      id: `${input.sessionKey}-compact-${boundary.timestamp}`,
      sessionKey: input.sessionKey,
      projectKey: input.projectKey,
      createdAt: boundary.timestamp,
      provider: "pilotdeck",
      role: "system",
      kind: "compact_boundary",
      text: "Context compacted",
      payload: meta,
      source: "history",
    };
    allMessages.splice(insertPos, 0, compactMsg);
  }

  attachSubagentIds(entries, allMessages);
  injectErrorTurnMessages(entries, allMessages, input.sessionKey, input.projectKey);
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
    },
  };
}

/**
 * Read a subagent's sidechain transcript and project it onto WebMessage[].
 * Locates the sidechain JSONL by deriving the default path from the parent
 * session transcript path + subagentId.
 */
export async function readSubagentWebMessages(
  input: { sessionKey: string; subagentId: string; projectKey?: string },
  options: ReadWebSessionMessagesOptions,
): Promise<{ messages: WebMessage[]; total: number }> {
  const effectiveProjectRoot = input.projectKey ?? options.projectRoot;
  const chatDir = getPilotProjectChatDir(effectiveProjectRoot, options.pilotHome);
  const parentTranscriptPath = resolve(
    chatDir,
    `${sanitizeSessionIdForPath(input.sessionKey)}.jsonl`,
  );

  const { entries: parentEntries } = await readTranscript(parentTranscriptPath);
  let sidechainRelative: string | undefined;
  for (const entry of parentEntries) {
    if (entry.type === "subagent_started" && entry.subagentId === input.subagentId) {
      sidechainRelative = entry.transcriptRelativePath;
      break;
    }
  }

  if (!sidechainRelative) {
    return { messages: [], total: 0 };
  }

  const sidechainPath = resolve(dirname(parentTranscriptPath), sidechainRelative);
  const { entries } = await readTranscript(sidechainPath);
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
      }),
    );
  const cumulativeWebCounts: number[] = [];
  let cumulative = 0;
  for (const group of flattenedPerMessage) {
    cumulative += group.length;
    cumulativeWebCounts.push(cumulative);
  }

  const allMessages: WebMessage[] = flattenedPerMessage.flat();

  for (const boundary of [...webReplay.compactBoundaries].reverse()) {
    const insertPos =
      boundary.insertAfterMessageIndex >= 0
        ? (cumulativeWebCounts[boundary.insertAfterMessageIndex] ?? 0)
        : 0;
    const meta = boundary.metadata ?? {};
    const compactMsg: WebMessage = {
      id: `${input.sessionKey}::sub::${input.subagentId}-compact-${boundary.timestamp}`,
      sessionKey: `${input.sessionKey}::sub::${input.subagentId}`,
      projectKey: input.projectKey,
      createdAt: boundary.timestamp,
      provider: "pilotdeck",
      role: "system",
      kind: "compact_boundary",
      text: "Context compacted",
      payload: meta,
      source: "history",
    };
    allMessages.splice(insertPos, 0, compactMsg);
  }

  return { messages: allMessages, total: allMessages.length };
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
    text: "上次运行未正常结束或已中断，已恢复当时产生的工具调用和输出。",
    payload: { incompleteTurnIds: turnIds },
    source: "history",
  };
}

function extractIncompleteTurnIds(entries: AgentTranscriptEntry[]): string[] {
  const completedTurnIds = new Set(
    entries.filter((entry) => entry.type === "turn_result").map((entry) => entry.turnId),
  );
  const incompleteTurnIds = new Set<string>();
  for (const entry of entries) {
    if (
      (entry.type === "assistant_message" ||
        entry.type === "tool_result_message" ||
        entry.type === "durable_message") &&
      !completedTurnIds.has(entry.turnId)
    ) {
      incompleteTurnIds.add(entry.turnId);
    }
  }
  return [...incompleteTurnIds];
}

async function locateSession(
  sessionKey: string,
  options: ReadWebSessionMessagesOptions,
): Promise<SessionInfo | undefined> {
  const sessions = await listProjectSessions({
    projectRoot: options.projectRoot,
    pilotHome: options.pilotHome,
  });
  // sessionId in SessionInfo is the on-disk filename (already sanitized);
  // the incoming sessionKey may still be the raw form (e.g. tui:project=/foo:default).
  // Compare against the sanitized form so locating works for both shapes.
  const safeKey = sanitizeSessionIdForPath(sessionKey);
  return sessions.find(
    (session) => session.sessionId === sessionKey || session.sessionId === safeKey,
  );
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
  /** JSONL entryId of the transcript entry being projected. Threaded
   *  through onto each produced WebMessage so the client can reference
   *  the underlying transcript row (e.g. for fork truncation). */
  entryId?: string;
};

/**
 * Flatten a CanonicalMessage's content blocks into one or more WebMessages.
 * Adjacent text blocks within the same canonical message merge.
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
      ...(context.entryId ? { entryId: context.entryId } : {}),
      text: textBuffer,
      ...(pendingImages.length > 0 ? { images: pendingImages } : {}),
      source: "history",
    });
    textBuffer = "";
    pendingImages = [];
  };

  for (const block of message.content) {
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
    if (block.type === "tool_result") {
      lastToolResultMessage = out[out.length - 1];
    }
  }
  flushText();
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
        source: "history",
        ...(context.entryId ? { entryId: context.entryId } : {}),
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
        ...(context.entryId ? { entryId: context.entryId } : {}),
      });
      return;
    case "tool_result": {
      flushText();
      const resultText = flattenToolResultBlockText(block);
      const errorCode = readToolResultErrorCode(block.raw);
      const planData = readPlanData(block.raw);
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
        ok: !block.isError,
        text: resultText,
        ...(errorCode ? { errorCode } : {}),
        ...(planData ? { payload: planData } : {}),
        ...(resultImages.length > 0 ? { images: resultImages } : {}),
        source: "history",
        ...(context.entryId ? { entryId: context.entryId } : {}),
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
        ok: true,
        text: block.preview,
        payload: {
          path: block.path,
          originalBytes: block.originalBytes,
          hasMore: block.hasMore,
          mimeType: block.mimeType,
          reason: block.reason,
        },
        source: "history",
        ...(context.entryId ? { entryId: context.entryId } : {}),
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
        ...(context.entryId ? { entryId: context.entryId } : {}),
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
        ...(context.entryId ? { entryId: context.entryId } : {}),
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
  insertAfterMessageIndex: number;
  timestamp: string;
  metadata?: Record<string, unknown>;
};

function extractWebVisibleMessages(entries: AgentTranscriptEntry[]): {
  messages: CanonicalMessage[];
  timestamps: string[];
  entryIds: string[];
  compactBoundaries: CompactBoundaryInfo[];
} {
  const lastBoundaryIndex = findLastCompactBoundaryIndex(entries);
  const messages: CanonicalMessage[] = [];
  const timestamps: string[] = [];
  const entryIds: string[] = [];
  const compactBoundaries: CompactBoundaryInfo[] = [];

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const beforeBoundary = lastBoundaryIndex !== -1 && index < lastBoundaryIndex;

    switch (entry.type) {
      case "accepted_input":
        if (!beforeBoundary) {
          for (const message of entry.messages) {
            messages.push(cloneMessage(message));
            timestamps.push(entry.createdAt);
            entryIds.push(entry.entryId);
          }
        }
        break;
      case "assistant_message":
      case "tool_result_message":
      case "durable_message":
        if (!beforeBoundary) {
          messages.push(cloneMessage(entry.message));
          timestamps.push(entry.createdAt);
          entryIds.push(entry.entryId);
        }
        break;
      case "control_boundary": {
        if (!beforeBoundary && entry.boundary && entry.boundary.kind === "compact") {
          const meta: Record<string, unknown> = {};
          if (entry.boundary.subtype === "compact_boundary" && "compactMetadata" in entry.boundary) {
            const cm = entry.boundary.compactMetadata as Record<string, unknown>;
            meta.trigger = cm.trigger;
            meta.preTokens = cm.preTokens;
            meta.level = cm.level;
            meta.stage = cm.stage;
            meta.stageLabel = cm.stageLabel;
          }
          compactBoundaries.push({
            insertAfterMessageIndex: messages.length - 1,
            timestamp: entry.createdAt,
            metadata: meta,
          });
        }
        break;
      }
    }
  }

  return { messages, timestamps, entryIds, compactBoundaries };
}

function extractSubagentExecutionMessages(entries: AgentTranscriptEntry[]): {
  messages: CanonicalMessage[];
  timestamps: string[];
  entryIds: string[];
  compactBoundaries: CompactBoundaryInfo[];
} {
  const lastBoundaryIndex = findLastCompactBoundaryIndex(entries);
  const messages: CanonicalMessage[] = [];
  const timestamps: string[] = [];
  const entryIds: string[] = [];
  const compactBoundaries: CompactBoundaryInfo[] = [];
  let sawExecutionMessage = false;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const beforeBoundary = lastBoundaryIndex !== -1 && index < lastBoundaryIndex;

    switch (entry.type) {
      case "accepted_input":
        // Sidechain accepted_input is the fork prelude: parent assistant
        // context + fork directive. It is model input, not subagent output.
        break;
      case "assistant_message":
      case "tool_result_message":
      case "durable_message":
        sawExecutionMessage = true;
        if (!beforeBoundary) {
          messages.push(cloneMessage(entry.message));
          timestamps.push(entry.createdAt);
          entryIds.push(entry.entryId);
        }
        break;
      case "control_boundary": {
        if (
          !beforeBoundary &&
          sawExecutionMessage &&
          entry.boundary &&
          entry.boundary.kind === "compact"
        ) {
          const meta: Record<string, unknown> = {};
          if (entry.boundary.subtype === "compact_boundary" && "compactMetadata" in entry.boundary) {
            const cm = entry.boundary.compactMetadata as Record<string, unknown>;
            meta.trigger = cm.trigger;
            meta.preTokens = cm.preTokens;
            meta.level = cm.level;
            meta.stage = cm.stage;
            meta.stageLabel = cm.stageLabel;
          }
          compactBoundaries.push({
            insertAfterMessageIndex: messages.length - 1,
            timestamp: entry.createdAt,
            metadata: meta,
          });
        }
        break;
      }
    }
  }

  return { messages, timestamps, entryIds, compactBoundaries };
}

function cloneMessage(message: CanonicalMessage): CanonicalMessage {
  return JSON.parse(JSON.stringify(message)) as CanonicalMessage;
}

/**
 * Correlate `subagent_started` transcript entries with their parent `tool_use`
 * (agent/Task) WebMessages by matching order within entries, then stamp
 * `subagentId` onto the WebMessage so the frontend can link to the sidechain.
 */
function attachSubagentIds(
  entries: AgentTranscriptEntry[],
  allMessages: WebMessage[],
): void {
  const subagentQueue: string[] = [];
  for (const entry of entries) {
    if (entry.type === "subagent_started") {
      subagentQueue.push(entry.subagentId);
    }
  }
  if (subagentQueue.length === 0) return;

  let qi = 0;
  for (const msg of allMessages) {
    if (qi >= subagentQueue.length) break;
    if (msg.kind !== "tool_use") continue;
    const name = String(msg.toolName ?? "").toLowerCase();
    if (name !== "agent" && name !== "task") continue;
    msg.subagentId = subagentQueue[qi];
    qi += 1;
  }
}

/**
 * Scan transcript entries for failed turns (`turn_result` with `type === "error"`)
 * and inject corresponding `WebMessage { kind: 'error' }` into the message list
 * so error banners survive history reload.
 */
function injectErrorTurnMessages(
  entries: AgentTranscriptEntry[],
  allMessages: WebMessage[],
  sessionKey: string,
  projectKey?: string,
): void {
  const errorMessages: WebMessage[] = [];
  for (const entry of entries) {
    if (entry.type !== "turn_result" || entry.result.type !== "error") continue;
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
      text,
      payload: { code: entry.result.stopReason, recoverable: false },
      source: "history",
    });
  }
  if (errorMessages.length === 0) return;

  for (const errMsg of errorMessages) {
    let insertAt = allMessages.length;
    for (let i = allMessages.length - 1; i >= 0; i--) {
      if (allMessages[i].createdAt <= errMsg.createdAt) {
        insertAt = i + 1;
        break;
      }
      if (i === 0) insertAt = 0;
    }
    allMessages.splice(insertAt, 0, errMsg);
  }
}

function readToolResultErrorCode(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const error = (raw as { error?: unknown }).error;
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.length > 0 ? code : undefined;
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
