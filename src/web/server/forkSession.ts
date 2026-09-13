/**
 * Fork a web session transcript at a prior turn entry.
 *
 * User-message forks create a new session before that user turn and return
 * the forked text for composer prefill. Assistant-message forks preserve
 * history through the selected assistant entry and continue from there.
 */

import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { chmod, cp, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { platform } from "node:process";
import type { CanonicalContentBlock, CanonicalMessage } from "../../model/index.js";
import { getPilotProjectChatDir } from "../../pilot/index.js";
import { readTranscript } from "../../session/transcript/TranscriptReader.js";
import {
  readAgentProjectSessionTranscript,
  sanitizeSessionIdForPath,
} from "../../session/storage/ProjectSessionStorage.js";
import type { AgentProjectSessionStorage } from "../../session/storage/ProjectSessionStorage.js";
import type {
  AgentAcceptedInputTranscriptEntry,
  AgentSessionMetadataTranscriptEntry,
  AgentTranscriptEntry,
} from "../../session/transcript/TranscriptEntry.js";
import type { WebAgentRunMode, WebGatewayMode, WebForkSessionInput, WebForkSessionResult } from "../client/protocol.js";

export type ForkWebSessionOptions = {
  projectRoot: string;
  pilotHome: string;
  /** Gateway-only resolver for a native session-storage layout. */
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
  const value = entry.metadata?.runMode;
  return value === "agent" || value === "plan" || value === "ask" ? value : undefined;
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

type ForkAuxiliaryPaths = {
  sourceSessionDir: string;
  targetSessionDir: string;
  sourceToolResultsDir?: string;
  targetToolResultsDir?: string;
};

function retargetAuxiliaryPath(
  path: string,
  sourceSessionDir: string,
  targetSessionDir: string,
  sourceToolResultsDir?: string,
  targetToolResultsDir?: string,
): string {
  const absolutePath = resolve(path);
  if (sourceToolResultsDir && targetToolResultsDir) {
    const toolResultRelativePath = relative(sourceToolResultsDir, absolutePath);
    if (
      toolResultRelativePath !== ""
      && !toolResultRelativePath.startsWith("..")
      && !isAbsolute(toolResultRelativePath)
    ) {
      return resolve(targetToolResultsDir, toolResultRelativePath);
    }
  }
  const relativePath = relative(sourceSessionDir, absolutePath);
  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  ) {
    return path;
  }
  return resolve(targetSessionDir, relativePath);
}

function retargetRelativeSessionPath(
  path: string,
  sourceSafeId: string,
  targetSafeId: string,
): string {
  const parts = path.split(/[\\/]/);
  if (parts[0] !== sourceSafeId) {
    return path;
  }
  return [targetSafeId, ...parts.slice(1)].join("/");
}

function retargetContentBlock(
  block: CanonicalContentBlock,
  paths: ForkAuxiliaryPaths,
): CanonicalContentBlock {
  if (block.type === "tool_result_reference" || block.type === "media_reference") {
    return {
      ...block,
      path: retargetAuxiliaryPath(
        block.path,
        paths.sourceSessionDir,
        paths.targetSessionDir,
        paths.sourceToolResultsDir,
        paths.targetToolResultsDir,
      ),
    };
  }
  return block;
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

function retargetTranscriptEntryAuxiliaryPaths(
  entry: AgentTranscriptEntry,
  paths: ForkAuxiliaryPaths,
): AgentTranscriptEntry {
  if (entry.type === "accepted_input") {
    return {
      ...entry,
      messages: entry.messages.map((message) => ({
        ...message,
        content: message.content.map((block) =>
          retargetContentBlock(block, paths),
        ),
      })),
    };
  }
  if (
    entry.type === "assistant_message" ||
    entry.type === "tool_result_message" ||
    entry.type === "durable_message"
  ) {
    return {
      ...entry,
      message: {
        ...entry.message,
        content: entry.message.content.map((block) =>
          retargetContentBlock(block, paths),
        ),
      },
    };
  }
  return entry;
}

function retargetForkSidechainEntry(
  entry: AgentTranscriptEntry,
  options: ForkAuxiliaryPaths & {
    sourceSafeId: string;
    targetSafeId: string;
  },
): AgentTranscriptEntry {
  const retargeted = retargetTranscriptEntryAuxiliaryPaths(entry, options);
  if (retargeted.type !== "subagent_started") {
    return retargeted;
  }
  return {
    ...retargeted,
    transcriptRelativePath: retargetRelativeSessionPath(
      retargeted.transcriptRelativePath,
      options.sourceSafeId,
      options.targetSafeId,
    ),
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
  return entry;
}

function retargetAcceptedInputEntry(
  entry: AgentAcceptedInputTranscriptEntry,
  sessionId: string,
  paths: ForkAuxiliaryPaths,
): AgentAcceptedInputTranscriptEntry {
  const retargeted = retargetTranscriptEntryAuxiliaryPaths(entry, paths);
  if (retargeted.type !== "accepted_input") {
    return entry;
  }
  return {
    ...retargeted,
    sessionId,
  };
}

function retargetEntriesToSession(
  entries: AgentTranscriptEntry[],
  options: ForkAuxiliaryPaths & {
    sessionId: string;
    sourceSafeId: string;
    targetSafeId: string;
  },
): AgentTranscriptEntry[] {
  return entries.map((entry) => {
    if (entry.type === "accepted_input") {
      const retargeted = retargetAcceptedInputEntry(
        entry,
        options.sessionId,
        options,
      );
      return markTranscriptEntryAsForkCarryover(retargeted, entry.sessionId);
    }
    if (
      entry.type === "assistant_message" ||
      entry.type === "tool_result_message" ||
      entry.type === "durable_message"
    ) {
      const retargeted = {
        ...retargetTranscriptEntryAuxiliaryPaths(
          entry,
          options,
        ),
        sessionId: options.sessionId,
      };
      return markTranscriptEntryAsForkCarryover(retargeted, entry.sessionId);
    }
    if (entry.type === "subagent_started") {
      return {
        ...entry,
        sessionId: options.sessionId,
        transcriptRelativePath: retargetRelativeSessionPath(
          entry.transcriptRelativePath,
          options.sourceSafeId,
          options.targetSafeId,
        ),
      };
    }
    return {
      ...entry,
      sessionId: options.sessionId,
    };
  });
}

function isNotFoundError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT",
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNotFoundError(error)) {
      return false;
    }
    throw error;
  }
}

async function retargetCopiedSubagentTranscripts(
  targetSubagentsDir: string,
  paths: ForkAuxiliaryPaths,
): Promise<void> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(targetSubagentsDir, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const path = join(targetSubagentsDir, entry.name);
    if (entry.isDirectory()) {
      await retargetCopiedSubagentTranscripts(path, paths);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
      continue;
    }
    const content = await readFile(path, "utf8");
    const rewritten = content
      .split(/\r?\n/)
      .map((line) => {
        if (!line.trim()) {
          return line;
        }
        try {
          const parsed = JSON.parse(line) as AgentTranscriptEntry;
          return JSON.stringify(
            retargetTranscriptEntryAuxiliaryPaths(parsed, paths),
          );
        } catch {
          return line;
        }
      })
      .join("\n");
    await writeFile(path, rewritten, "utf8");
  }
}

async function copySessionAuxDirs(paths: ForkAuxiliaryPaths): Promise<void> {
  for (const subdir of ["file-history", "subagents"] as const) {
    const source = join(paths.sourceSessionDir, subdir);
    const target = join(paths.targetSessionDir, subdir);
    if (!(await pathExists(source))) {
      continue;
    }
    await cp(source, target, { recursive: true, force: true });
    if (subdir === "subagents") {
      await retargetCopiedSubagentTranscripts(target, paths);
    }
  }
  if (
    paths.sourceToolResultsDir
    && paths.targetToolResultsDir
    && await pathExists(paths.sourceToolResultsDir)
  ) {
    await cp(paths.sourceToolResultsDir, paths.targetToolResultsDir, { recursive: true, force: true });
  }
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
  const chatDir = sourceStorage?.chatDir ?? getPilotProjectChatDir(effectiveProjectRoot, options.pilotHome);
  const sourceSafeId = sanitizeSessionIdForPath(input.sessionKey);
  const sourceTranscriptPath = sourceStorage?.transcriptPath ?? resolve(chatDir, `${sourceSafeId}.jsonl`);
  const sourceSessionDir = sourceStorage ? dirname(sourceStorage.subagentsDir) : resolve(chatDir, sourceSafeId);

  const { entries } = sourceStorage
    ? await readAgentProjectSessionTranscript(sourceStorage)
    : await readTranscript(sourceTranscriptPath);
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
  const newSafeId = sanitizeSessionIdForPath(newSessionKey);
  const targetStorage = options.storageForSession?.(newSessionKey);
  const newTranscriptPath = targetStorage?.transcriptPath ?? resolve(chatDir, `${newSafeId}.jsonl`);
  const newSessionDir = targetStorage ? dirname(targetStorage.subagentsDir) : resolve(chatDir, newSafeId);
  const auxiliaryPaths: ForkAuxiliaryPaths = {
    sourceSessionDir,
    targetSessionDir: newSessionDir,
    ...(sourceStorage && targetStorage
      ? {
          sourceToolResultsDir: sourceStorage.toolResultsDir,
          targetToolResultsDir: targetStorage.toolResultsDir,
        }
      : {}),
  };
  if (targetStorage?.externalTranscriptStore && !targetStorage.replaceTranscript) {
    throw new ForkSessionError(
      "fork_unsupported_storage",
      "The configured external transcript store does not support atomic fork creation.",
    );
  }
  const preserved = retargetEntriesToSession(preservedSourceEntries, {
    sessionId: newSessionKey,
    sourceSafeId,
    targetSafeId: newSafeId,
    ...auxiliaryPaths,
  });

  if (targetStorage?.externalTranscriptStore && sourceStorage && targetStorage.copyTranscriptSidechains) {
    await targetStorage.copyTranscriptSidechains({
      sourceStorage,
      sourceTranscriptEntries: entries,
      transformEntry: (entry) => retargetForkSidechainEntry(entry, {
        ...auxiliaryPaths,
        sourceSafeId,
        targetSafeId: newSafeId,
      }),
    });
  }
  if (targetStorage?.externalTranscriptStore && sourceStorage && targetStorage.copyFileHistoryBackups) {
    await targetStorage.copyFileHistoryBackups({
      sourceStorage,
      sourceTranscriptEntries: entries,
    });
  }
  if (targetStorage?.externalTranscriptStore && sourceStorage && targetStorage.copyToolResultArtifacts) {
    await targetStorage.copyToolResultArtifacts({
      sourceStorage,
      sourceTranscriptEntries: entries,
    });
  }

  if (!targetStorage?.externalTranscriptStore) {
    await mkdir(chatDir, { recursive: true, mode: 0o700 });
    await mkdir(newSessionDir, { recursive: true, mode: 0o700 });
    await copySessionAuxDirs(auxiliaryPaths);
  }

  const preservedLines = preserved.map((entry) => `${JSON.stringify(entry)}\n`).join("");
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

  if (targetStorage?.replaceTranscript) {
    await targetStorage.replaceTranscript([...preserved, metadataEntry]);
  } else {
    const body = preservedLines + `${JSON.stringify(metadataEntry)}\n`;
    await writeFile(newTranscriptPath, body, { encoding: "utf8", mode: 0o600 });
    await chmod(dirname(newTranscriptPath), 0o700);
  }

  return {
    newSessionKey,
    prefillText,
    carriedMessageCount,
    ...(forkRunMode ? { runMode: forkRunMode } : {}),
    ...(forkMode ? { mode: forkMode } : {}),
  };
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
