/**
 * Fork a web session transcript at a prior turn entry.
 *
 * User-message forks create a new session before that user turn and return
 * the forked text for composer prefill. Assistant-message forks preserve
 * history through the selected assistant entry and continue from there.
 */

import { randomUUID } from "node:crypto";
import { cp, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { platform } from "node:process";
import type { CanonicalContentBlock, CanonicalMessage } from "../../model/index.js";
import { parseAgentRunMode } from "../../agent/protocol/input.js";
import { readCompactSnapshot } from "../../session/transcript/CompactSnapshot.js";
import {
  createProjectSessionForkPort,
  readAgentProjectSessionPersistence,
  sanitizeSessionIdForPath,
  type AgentProjectSessionStorage,
  type ProjectSessionForkPort,
  type ProjectSessionStorageProvider,
} from "../../session/index.js";
import type {
  AgentAcceptedInputTranscriptEntry,
  AgentSessionMetadataTranscriptEntry,
  AgentTranscriptEntry,
} from "../../session/transcript/TranscriptEntry.js";
import type { WebAgentRunMode, WebGatewayMode, WebForkSessionInput, WebForkSessionResult } from "../client/protocol.js";

export type ForkWebSessionOptions = {
  projectRoot: string;
  pilotHome: string;
  /** Application-selected durable backend used for source reads and fork writes. */
  storageProvider?: ProjectSessionStorageProvider;
  /** Explicit application/test override for the selected durable fork transaction. */
  sessionForkPort?: ProjectSessionForkPort;
  /** @deprecated Use storageProvider plus sessionForkPort. */
  storageForSession?: (sessionId: string) => AgentProjectSessionStorage;
  now?: () => Date;
};

function newWebSessionKey(): string {
  const sep = platform === "win32" ? "-" : ":";
  return `web${sep}s_${randomUUID()}`;
}

function extractAcceptedInputText(entry: AgentAcceptedInputTranscriptEntry): string {
  const chunks: string[] = [];
  for (const message of entry.messages) {
    for (const block of message.content as CanonicalContentBlock[]) {
      if (block.type === "text" && block.text.trim()) {
        chunks.push(block.text.trim());
      }
    }
  }
  return chunks.join("\n\n").trim();
}

function hasUnsupportedPrefillContent(entry: AgentAcceptedInputTranscriptEntry): boolean {
  return entry.messages.some((message) =>
    (message.content as CanonicalContentBlock[]).some((block) => block.type !== "text"),
  );
}

function getForkMode(entry: AgentAcceptedInputTranscriptEntry): WebGatewayMode | undefined {
  return entry.metadata?.permissionMode === "plan" ? "plan" : undefined;
}

function getForkRunMode(entry: AgentAcceptedInputTranscriptEntry): WebAgentRunMode | undefined {
  return parseAgentRunMode(entry.metadata?.runMode);
}

function buildForkTitle(
  prefillText: string,
  carriedMessageCount: number,
  inheritedTitle: string | undefined,
): string {
  const normalized = prefillText.replace(/\s+/g, " ").trim();
  if (normalized) {
    const max = 48;
    const snippet = normalized.length > max ? `${normalized.slice(0, max).trimEnd()}…` : normalized;
    // A leading branch glyph keeps forks scannable even when titles collide.
    return `⑂ ${snippet}`;
  }
  if (inheritedTitle) {
    return `⑂ ${inheritedTitle}`;
  }
  return carriedMessageCount > 0 ? "⑂ Forked session" : "⑂ New branch";
}

type ForkPoint = {
  target: AgentTranscriptEntry;
  acceptedInput: AgentAcceptedInputTranscriptEntry;
  preserveTarget: boolean;
};

function findForkPoint(
  entries: AgentTranscriptEntry[],
  fromEntryId: string,
  preserveAcceptedInput = false,
): ForkPoint {
  const target = entries.find((entry) => entry.entryId === fromEntryId);
  if (!target) {
    throw new ForkSessionError("fork_entry_not_found", `Transcript entry not found: ${fromEntryId}`);
  }

  if (target.type === "accepted_input" && !preserveAcceptedInput) {
    return {
      target,
      acceptedInput: target,
      preserveTarget: false,
    };
  }

  const accepted = entries.find(
    (entry): entry is AgentAcceptedInputTranscriptEntry =>
      entry.type === "accepted_input" && entry.turnId === target.turnId,
  );
  if (!accepted) {
    throw new ForkSessionError(
      "fork_turn_not_found",
      `No accepted_input found for turn ${target.turnId}`,
    );
  }
  return {
    target,
    acceptedInput: accepted,
    preserveTarget: true,
  };
}

function lastSessionMetadata(entries: AgentTranscriptEntry[]): Record<string, unknown> | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "session_metadata") {
      return entry.metadata as Record<string, unknown>;
    }
  }
  return undefined;
}

function countCarriedUserAssistantMessages(entries: AgentTranscriptEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    switch (entry.type) {
      case "accepted_input":
        count += entry.messages.length;
        break;
      case "assistant_message":
      case "tool_result_message":
      case "durable_message":
        count += 1;
        break;
      default:
        break;
    }
  }
  return count;
}

function shouldPreserveSourceEntry(entry: AgentTranscriptEntry, forkPoint: ForkPoint): boolean {
  if (!forkPoint.preserveTarget) {
    return entry.sequence < forkPoint.acceptedInput.sequence;
  }
  if (entry.sequence <= forkPoint.target.sequence) {
    return true;
  }
  // Assistant-message forks preserve the selected response as conversation
  // context. Keep the completion marker so replay does not drop that turn as
  // incomplete, without pulling in later durable messages from the same turn.
  return (
    entry.turnId === forkPoint.target.turnId &&
    (entry.type === "turn_result" || entry.type === "file_artifacts")
  );
}

function markMessageAsForkCarryover(
  message: CanonicalMessage,
  sourceSessionId: string,
  sourceTurnId: string,
): CanonicalMessage {
  return {
    ...message,
    metadata: {
      ...message.metadata,
      forkCarryover: {
        sourceSessionId,
        sourceTurnId,
      },
    },
  };
}

function markTranscriptEntryAsForkCarryover(
  entry: AgentTranscriptEntry,
  sourceSessionId: string,
): AgentTranscriptEntry {
  if (entry.type === "accepted_input") {
    return {
      ...entry,
      messages: entry.messages.map((message) =>
        markMessageAsForkCarryover(message, sourceSessionId, entry.turnId),
      ),
    };
  }
  if (
    entry.type === "assistant_message" ||
    entry.type === "tool_result_message" ||
    entry.type === "durable_message"
  ) {
    return {
      ...entry,
      message: markMessageAsForkCarryover(entry.message, sourceSessionId, entry.turnId),
    };
  }
  if (
    entry.type === "control_boundary" &&
    entry.boundary.kind === "compact" &&
    entry.boundary.subtype === "compact_boundary"
  ) {
    const snapshot = readCompactSnapshot(entry);
    if (snapshot) {
      return {
        ...entry,
        boundary: {
          ...entry.boundary,
          snapshot: {
            version: 1,
            messages: snapshot.map((message) => markMessageAsForkCarryover(message, sourceSessionId, entry.turnId)),
          },
        },
      };
    }
  }
  return entry;
}

function retargetEntriesToSession(
  entries: AgentTranscriptEntry[],
  options: {
    sessionId: string;
    sourceStorage?: AgentProjectSessionStorage;
    targetStorage?: AgentProjectSessionStorage;
  },
): AgentTranscriptEntry[] {
  return entries.map((entry) => {
    const retargeted = options.sourceStorage && options.targetStorage
      ? retargetLegacyAuxiliaryPaths(entry, options.sourceStorage, options.targetStorage)
      : entry;
    if (retargeted.type === "accepted_input") {
      return markTranscriptEntryAsForkCarryover({ ...retargeted, sessionId: options.sessionId }, entry.sessionId);
    }
    if (
      retargeted.type === "assistant_message" ||
      retargeted.type === "tool_result_message" ||
      retargeted.type === "durable_message" ||
      (retargeted.type === "control_boundary" &&
        retargeted.boundary.kind === "compact" &&
        retargeted.boundary.subtype === "compact_boundary")
    ) {
      return markTranscriptEntryAsForkCarryover({ ...retargeted, sessionId: options.sessionId }, entry.sessionId);
    }
    return {
      ...retargeted,
      sessionId: options.sessionId,
    };
  });
}

function retargetLegacyAuxiliaryPaths(
  entry: AgentTranscriptEntry,
  sourceStorage: AgentProjectSessionStorage,
  targetStorage: AgentProjectSessionStorage,
): AgentTranscriptEntry {
  const sourceSessionDir = dirname(sourceStorage.subagentsDir);
  const targetSessionDir = dirname(targetStorage.subagentsDir);
  const retargetBlock = (block: CanonicalContentBlock): CanonicalContentBlock => {
    if (block.type !== "tool_result_reference" && block.type !== "media_reference") return block;
    const absolute = resolve(block.path);
    const relativePath = relative(sourceStorage.toolResultsDir, absolute);
    if (relativePath && !relativePath.startsWith("..") && !isAbsolute(relativePath)) {
      return { ...block, path: resolve(targetStorage.toolResultsDir, relativePath) };
    }
    const sessionRelative = relative(sourceSessionDir, absolute);
    return sessionRelative && !sessionRelative.startsWith("..") && !isAbsolute(sessionRelative)
      ? { ...block, path: resolve(targetSessionDir, sessionRelative) }
      : block;
  };
  if (entry.type === "accepted_input") {
    return { ...entry, messages: entry.messages.map((message) => ({ ...message, content: message.content.map(retargetBlock) })) };
  }
  if (entry.type === "assistant_message" || entry.type === "tool_result_message" || entry.type === "durable_message") {
    return { ...entry, message: { ...entry.message, content: entry.message.content.map(retargetBlock) } };
  }
  if (
    entry.type === "control_boundary" &&
    entry.boundary.kind === "compact" &&
    entry.boundary.subtype === "compact_boundary"
  ) {
    const snapshot = readCompactSnapshot(entry);
    if (snapshot) {
      return {
        ...entry,
        boundary: {
          ...entry.boundary,
          snapshot: {
            version: 1,
            messages: snapshot.map((message) => ({
              ...message,
              content: message.content.map(retargetBlock),
            })),
          },
        },
      };
    }
  }
  if (entry.type === "subagent_started") {
    const sourceSafeId = sanitizeSessionIdForPath(entry.sessionId);
    const targetSafeId = sanitizeSessionIdForPath(basename(targetStorage.transcriptPath).replace(/\.jsonl$/, ""));
    const parts = entry.transcriptRelativePath.split(/[\\/]/);
    return parts[0] === sourceSafeId
      ? { ...entry, transcriptRelativePath: [targetSafeId, ...parts.slice(1)].join("/") }
      : entry;
  }
  return entry;
}

export class ForkSessionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ForkSessionError";
  }
}

export async function forkWebSession(
  input: WebForkSessionInput,
  options: ForkWebSessionOptions,
): Promise<WebForkSessionResult> {
  const effectiveProjectRoot = input.projectKey ?? options.projectRoot;
  const sourceStorage = options.storageForSession?.(input.sessionKey);
  const { entries } = sourceStorage
    ? await sourceStorage.restore()
    : await readAgentProjectSessionPersistence({
        projectRoot: effectiveProjectRoot,
        pilotHome: options.pilotHome,
        sessionId: input.sessionKey,
        ...(options.storageProvider ? { storageProvider: options.storageProvider } : {}),
      });
  if (entries.length === 0) {
    throw new ForkSessionError("fork_empty_transcript", "Cannot fork an empty session transcript.");
  }

  const forkPoint = findForkPoint(entries, input.fromEntryId, input.resumeAt === true);
  validateResumeDropsTurn(entries, forkPoint, input.resumeDropsTurn);
  const forkAcceptedInput = forkPoint.acceptedInput;
  if (!forkPoint.preserveTarget && hasUnsupportedPrefillContent(forkAcceptedInput)) {
    throw new ForkSessionError(
      "fork_unsupported_content",
      "Forking messages with attachments or non-text input is not supported yet.",
    );
  }
  const forkMode = getForkMode(forkAcceptedInput);
  const forkRunMode = getForkRunMode(forkAcceptedInput);
  const preservedSourceEntries = entries.filter((entry) => shouldPreserveSourceEntry(entry, forkPoint));
  const forkInputText = extractAcceptedInputText(forkAcceptedInput);
  const prefillText = forkPoint.preserveTarget ? "" : forkInputText;
  const carriedMessageCount = countCarriedUserAssistantMessages(preservedSourceEntries);

  const newSessionKey = newWebSessionKey();
  const targetStorage = options.storageForSession?.(newSessionKey);
  const preserved = retargetEntriesToSession(preservedSourceEntries, {
    sessionId: newSessionKey,
    sourceStorage,
    targetStorage,
  });
  const lastPreserved = preserved[preserved.length - 1];
  const lastEntryId = lastPreserved?.entryId ?? null;
  const maxSequence = preserved.reduce((max, entry) => Math.max(max, entry.sequence), 0);

  const parentMetadata = lastSessionMetadata(entries);
  const inheritedTitle =
    (typeof parentMetadata?.title === "string" && parentMetadata.title) ||
    (typeof parentMetadata?.aiTitle === "string" && parentMetadata.aiTitle) ||
    undefined;

  // Title the fork by the message it branches from so siblings are
  // distinguishable in the lineage tree (the branch icon + "forked from"
  // subtitle already convey that it is a fork).
  const forkTitle = buildForkTitle(forkInputText || prefillText, carriedMessageCount, inheritedTitle);

  const now = options.now ?? (() => new Date());
  const metadataEntry: AgentSessionMetadataTranscriptEntry = {
    type: "session_metadata",
    sessionId: newSessionKey,
    turnId: `fork-${randomUUID()}`,
    sequence: maxSequence + 1,
    createdAt: now().toISOString(),
    entryId: randomUUID(),
    parentEntryId: lastEntryId,
    metadata: {
      parentSessionId: input.sessionKey,
      forkedFromTurnId: forkAcceptedInput.turnId,
      title: forkTitle,
      firstPrompt: forkInputText || prefillText || undefined,
      updatedAt: now().toISOString(),
    },
  };

  const sessionForkPort = options.sessionForkPort ?? (sourceStorage && targetStorage
    ? createLegacyStorageForkPort(sourceStorage, targetStorage, preservedSourceEntries)
    : createProjectSessionForkPort({
        ...(options.storageProvider ? { storageProvider: options.storageProvider } : {}),
      }));
  await sessionForkPort.fork({
    projectRoot: effectiveProjectRoot,
    pilotHome: options.pilotHome,
    sourceSessionId: input.sessionKey,
    targetSessionId: newSessionKey,
    entries: [...preserved, metadataEntry],
  });

  return {
    newSessionKey,
    prefillText,
    carriedMessageCount,
    ...(forkRunMode ? { runMode: forkRunMode } : {}),
    ...(forkMode ? { mode: forkMode } : {}),
  };
}

function createLegacyStorageForkPort(
  sourceStorage: AgentProjectSessionStorage,
  targetStorage: AgentProjectSessionStorage,
  sourceEntries: readonly AgentTranscriptEntry[],
): ProjectSessionForkPort {
  return {
    async fork(input) {
      await targetStorage.copyTranscriptSidechains?.({
        sourceStorage,
        sourceTranscriptEntries: sourceEntries,
        transformEntry: (entry) => retargetLegacyAuxiliaryPaths(entry, sourceStorage, targetStorage),
      });
      await targetStorage.copyFileHistoryBackups?.({ sourceStorage, sourceTranscriptEntries: sourceEntries });
      await targetStorage.copyToolResultArtifacts?.({ sourceStorage, sourceTranscriptEntries: sourceEntries });
      if (targetStorage.replaceTranscript) {
        await targetStorage.replaceTranscript(input.entries);
        return;
      }
      if (targetStorage.externalTranscriptStore) {
        throw new ForkSessionError("fork_unsupported_storage", "The configured session storage does not support atomic fork creation.");
      }
      await forkNativeStorage(sourceStorage, targetStorage, input.entries);
    },
  };
}

async function forkNativeStorage(
  sourceStorage: AgentProjectSessionStorage,
  targetStorage: AgentProjectSessionStorage,
  entries: readonly AgentTranscriptEntry[],
): Promise<void> {
  const targetSessionDir = dirname(targetStorage.subagentsDir);
  const temporaryPath = `${targetStorage.transcriptPath}.${randomUUID()}.fork.tmp`;
  const exists = async (path: string) => stat(path).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return false;
    throw error;
  });
  if (await exists(targetStorage.transcriptPath) || await exists(targetSessionDir)) {
    throw new ForkSessionError("fork_target_exists", "Fork target session already exists.");
  }
  let createdTargetDir = false;
  try {
    await mkdir(targetStorage.chatDir, { recursive: true, mode: 0o700 });
    await mkdir(targetSessionDir, { recursive: false, mode: 0o700 });
    createdTargetDir = true;
    for (const [source, target] of [
      [sourceStorage.toolResultsDir, targetStorage.toolResultsDir],
      [sourceStorage.fileHistoryDir, targetStorage.fileHistoryDir],
      [sourceStorage.subagentsDir, targetStorage.subagentsDir],
    ] as const) {
      if (await exists(source)) await cp(source, target, { recursive: true, force: true });
    }
    await writeFile(
      temporaryPath,
      entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    await rename(temporaryPath, targetStorage.transcriptPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (createdTargetDir) await rm(targetSessionDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Validate Claude's optional resume-drops-turn guard before writing the fork.
 * The guard is deliberately fail-closed: every chain entry after the kept
 * fork point must belong to the one accepted-input turn named by the caller.
 * This prevents silently discarding a queued user message or another
 * side-effecting append that the caller may not have observed.
 */
function validateResumeDropsTurn(
  entries: AgentTranscriptEntry[],
  forkPoint: ForkPoint,
  resumeDropsTurn: string | undefined,
): void {
  if (resumeDropsTurn === undefined) return;
  const prefix = "Resume rejected by --resume-drops-turn: ";
  const droppedPrompt = entries.find((entry) => entry.entryId === resumeDropsTurn);
  if (!droppedPrompt || droppedPrompt.type !== "accepted_input") {
    throw new ForkSessionError(
      "resume_drops_turn_invalid",
      `${prefix}the supplied UUID is not an accepted-input entry.`,
    );
  }
  if (droppedPrompt.sequence <= forkPoint.target.sequence) {
    throw new ForkSessionError(
      "resume_drops_turn_invalid",
      `${prefix}the dropped turn must occur after the resume point.`,
    );
  }
  const discarded = entries.filter((entry) => entry.sequence > forkPoint.target.sequence);
  if (discarded.length === 0 || discarded.some((entry) => entry.turnId !== droppedPrompt.turnId)) {
    throw new ForkSessionError(
      "resume_drops_turn_mismatch",
      `${prefix}entries after the resume point are not attributable solely to the requested turn.`,
    );
  }
}
