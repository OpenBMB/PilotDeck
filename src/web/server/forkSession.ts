import { VideoJobManager, type VideoJob } from "../../tool/builtin/videos/VideoJobManager.js";
import { toCanonicalToolResultBlock } from "../../tool/protocol/result.js";
import { VideoStore, type GeneratedVideo } from "../../tool/builtin/videos/VideoStore.js";
/**
 * Fork a web session transcript at a prior turn entry.
 *
 * User-message forks create a new session before that user turn and return
 * the forked text for composer prefill. Assistant-message forks preserve
 * history through the selected assistant entry and continue from there.
 */

import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { chmod, cp, mkdir, readdir, readFile, realpath, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { platform } from "node:process";
import type { CanonicalContentBlock, CanonicalMessage } from "../../model/index.js";
import { getPilotProjectChatDir } from "../../pilot/index.js";
import { readCompactSnapshot, readRestoreSnapshot } from "../../session/transcript/CompactSnapshot.js";
import { readTranscript } from "../../session/transcript/TranscriptReader.js";
import {
  sanitizeSessionIdForPath,
} from "../../session/storage/ProjectSessionStorage.js";
import type {
  AgentAcceptedInputTranscriptEntry,
  AgentSessionMetadataTranscriptEntry,
  AgentTranscriptEntry,
} from "../../session/transcript/TranscriptEntry.js";
import type { WebAgentRunMode, WebGatewayMode, WebForkSessionInput, WebForkSessionResult } from "../client/protocol.js";
import { ImageStore, type GeneratedImage } from "../../tool/builtin/images/ImageStore.js";

export type ForkWebSessionOptions = {
  projectRoot: string;
  pilotHome: string;
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
): ForkPoint {
  const target = entries.find((entry) => entry.entryId === fromEntryId);
  if (!target) {
    throw new ForkSessionError("fork_entry_not_found", `Transcript entry not found: ${fromEntryId}`);
  }

  if (target.type === "accepted_input") {
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

function retargetAuxiliaryPath(
  path: string,
  sourceSessionDir: string,
  targetSessionDir: string,
): string {
  const absolutePath = resolve(path);
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
  sourceSessionDir: string,
  targetSessionDir: string,
): CanonicalContentBlock {
  if (block.type === "tool_result_reference" || block.type === "media_reference") {
    return {
      ...block,
      path: retargetAuxiliaryPath(block.path, sourceSessionDir, targetSessionDir),
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

function mapTranscriptEntryMessages(
  entry: AgentTranscriptEntry,
  transform: (message: CanonicalMessage) => CanonicalMessage,
): AgentTranscriptEntry {
  if (entry.type === "accepted_input") {
    return { ...entry, messages: entry.messages.map(transform) };
  }
  if (
    entry.type === "assistant_message" ||
    entry.type === "tool_result_message" ||
    entry.type === "durable_message"
  ) {
    return { ...entry, message: transform(entry.message) };
  }
  if (entry.type === "control_boundary" && (entry.boundary.kind === "restore" ||
      entry.boundary.kind === "compact" && entry.boundary.subtype === "compact_boundary")) {
    const messages = readCompactSnapshot(entry) ?? readRestoreSnapshot(entry);
    if (messages) {
      return {
        ...entry,
        boundary: {
          ...entry.boundary,
          snapshot: { version: 1, messages: messages.map(transform) },
        },
      };
    }
  }
  return entry;
}

function retargetTranscriptEntryAuxiliaryPaths(
  entry: AgentTranscriptEntry,
  sourceSessionDir: string,
  targetSessionDir: string,
): AgentTranscriptEntry {
  return mapTranscriptEntryMessages(entry, (message) => ({
    ...message,
    content: message.content.map((block) =>
      retargetContentBlock(block, sourceSessionDir, targetSessionDir),
    ),
  }));
}

function markTranscriptEntryAsForkCarryover(
  entry: AgentTranscriptEntry,
  sourceSessionId: string,
): AgentTranscriptEntry {
  return mapTranscriptEntryMessages(entry, (message) =>
    markMessageAsForkCarryover(message, sourceSessionId, entry.turnId),
  );
}

function retargetAcceptedInputEntry(
  entry: AgentAcceptedInputTranscriptEntry,
  sessionId: string,
  sourceSessionDir: string,
  targetSessionDir: string,
): AgentAcceptedInputTranscriptEntry {
  const retargeted = retargetTranscriptEntryAuxiliaryPaths(
    entry,
    sourceSessionDir,
    targetSessionDir,
  );
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
  options: {
    sessionId: string;
    sourceSafeId: string;
    targetSafeId: string;
    sourceSessionDir: string;
    targetSessionDir: string;
  },
): AgentTranscriptEntry[] {
  return entries.map((entry) => {
    if (entry.type === "accepted_input") {
      const retargeted = retargetAcceptedInputEntry(
        entry,
        options.sessionId,
        options.sourceSessionDir,
        options.targetSessionDir,
      );
      return markTranscriptEntryAsForkCarryover(retargeted, entry.sessionId);
    }
    if (
      entry.type === "assistant_message" ||
      entry.type === "tool_result_message" ||
      entry.type === "durable_message" ||
      entry.type === "control_boundary"
    ) {
      const retargeted = {
        ...retargetTranscriptEntryAuxiliaryPaths(
          entry,
          options.sourceSessionDir,
          options.targetSessionDir,
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
  sourceSessionDir: string,
  targetSessionDir: string,
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
      await retargetCopiedSubagentTranscripts(path, sourceSessionDir, targetSessionDir);
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
            retargetTranscriptEntryAuxiliaryPaths(parsed, sourceSessionDir, targetSessionDir),
          );
        } catch {
          return line;
        }
      })
      .join("\n");
    await writeFile(path, rewritten, "utf8");
  }
}

async function copySessionAuxDirs(sourceSessionDir: string, targetSessionDir: string): Promise<void> {
  for (const subdir of ["tool-results", "file-history", "subagents"] as const) {
    const source = join(sourceSessionDir, subdir);
    const target = join(targetSessionDir, subdir);
    if (!(await pathExists(source))) {
      continue;
    }
    await cp(source, target, { recursive: true, force: true });
    if (subdir === "subagents") {
      await retargetCopiedSubagentTranscripts(target, sourceSessionDir, targetSessionDir);
    }
  }
}

/** Inherited media IDs become assets owned by the new conversation, including
 * attachments referenced by compact snapshots and retained child transcripts. */
class ForkMediaInheritance {
  private readonly images = new Map<string, GeneratedImage>();
  private readonly videos = new Map<string, GeneratedVideo>();
  private readonly jobRollbacks = new Map<string, () => Promise<void>>();
  private readonly jobLists = new Map<string, Promise<VideoJob[]>>();
  private readonly jobs: VideoJobManager;
  constructor(private readonly store: ImageStore, private readonly targetSessionId: string, private readonly videoStore: VideoStore, private readonly sourceSessionId: string) {
    this.jobs = new VideoJobManager({ store: videoStore, getConfig: () => undefined });
  }

  private async inheritVideo(original: GeneratedVideo): Promise<GeneratedVideo> {
    const existing = this.videos.get(original.videoId);
    if (existing) return existing;
    const video = await this.videoStore.inherit(original.sessionId, original.videoId, this.targetSessionId);
    this.videos.set(video.videoId, video);
    return video;
  }
  private async findRecovered(call: string, entry: AgentTranscriptEntry): Promise<VideoJob | undefined> {
    const owners = new Set([this.sourceSessionId, entry.sessionId]);
    for (const owner of owners) {
      if (owner === this.targetSessionId) continue;
      let pending = this.jobLists.get(owner);
      if (!pending) { pending = this.jobs.list(owner); this.jobLists.set(owner, pending); }
      const matches = (await pending).filter(job => job.toolCallId === call &&
        (entry.type !== "control_boundary" || job.createdAt <= Date.parse(entry.createdAt)));
      // A compact snapshot may no longer carry the original turn ID. Only
      // resolve a unique, already-submitted task there; never pick a later
      // task that happens to reuse the same provider call ID.
      const job = entry.type === "control_boundary"
        ? matches.length === 1 ? matches[0] : undefined
        : matches.find(job => job.turnId === entry.turnId);
      if (job?.state === "completed" && job.video) return job;
    }
  }
  private async inheritJob(job: VideoJob, subagentId?: string) {
    const video = await this.inheritVideo(job.video!);
    this.jobRollbacks.set(job.id, await this.jobs.inheritCompleted(job, video, subagentId));
    return video;
  }

  async rewrite(entries: AgentTranscriptEntry[], subagentId?: string): Promise<AgentTranscriptEntry[]> {
    const blocks = new Map<CanonicalContentBlock, CanonicalContentBlock>();
    const references: Array<{ block: Extract<CanonicalContentBlock, { type: "tool_call" | "tool_result" }>; entry: AgentTranscriptEntry }> = [];
    const calls = new Set<string>();
    for (const entry of entries) mapTranscriptEntryMessages(entry, message => {
      for (const block of message.content) {
        if (block.type === "tool_call" || block.type === "tool_result") references.push({ block, entry });
        if (block.type === "tool_call" && block.name === "generate_video") calls.add(JSON.stringify([entry.turnId, block.id]));
      }
      return message;
    });
    for (const { block, entry } of references) {
      if (block.type === "tool_call") {
        if (block.name === "generate_video") {
          const job = await this.findRecovered(block.id, entry);
          if (job) await this.inheritJob(job, subagentId);
        }
        continue;
      }
      const videoRaw = block.raw as { toolName?: string; data?: { videoGeneration?: GeneratedVideo } } | undefined;
      const isVideo = videoRaw && ["generate_video", "save_generated_video"].includes(videoRaw.toolName ?? "");
      const job = videoRaw?.toolName === "generate_video" || calls.has(JSON.stringify([entry.turnId, block.toolCallId]))
        ? await this.findRecovered(block.toolCallId, entry) : undefined;
      if (isVideo || job) {
        const original = videoRaw?.data?.videoGeneration;
        if (original && typeof original.videoId === "string" && typeof original.sessionId === "string") {
          const inherited = await this.inheritVideo(original);
          const rewritten = replaceImagePath(block, original.path, inherited.path) as typeof block;
          const raw = rewritten.raw as NonNullable<typeof videoRaw>;
          raw.data = { ...raw.data, videoGeneration: { ...original, ...inherited } };
          blocks.set(block, rewritten);
          if (job?.video?.videoId === original.videoId) await this.inheritJob(job, subagentId);
        } else if (job) {
          const video = await this.inheritJob(job, subagentId);
          blocks.set(block, toCanonicalToolResultBlock({ type: "success", toolName: "generate_video", toolCallId: block.toolCallId,
            content: [{ type: "text", text: `Video recovered. video_id: ${video.videoId}. Attachment: ${video.path}` }],
            data: { videoGeneration: video }, startedAt: new Date(job.createdAt).toISOString(), completedAt: new Date(job.updatedAt).toISOString() }));
        }
        continue;
      }
      const raw = block.raw as { toolName?: string; data?: { imageGeneration?: GeneratedImage } } | undefined;
      if (!raw || !["generate_image", "edit_image", "save_generated_image"].includes(raw.toolName ?? "")) continue;
      const original = raw.data?.imageGeneration;
      if (!original || typeof original.imageId !== "string" || typeof original.sessionId !== "string") continue;
      let inherited = this.images.get(original.imageId);
      if (!inherited) {
        inherited = await this.store.inherit(original.sessionId, original.imageId, this.targetSessionId);
        this.images.set(original.imageId, inherited);
      }
      // Only rewrite this host-produced tool result, not arbitrary user text.
      const rewritten = replaceImagePath(block, original.path, inherited.path) as typeof block;
      const rewrittenRaw = rewritten.raw as typeof raw;
      rewrittenRaw.data = { ...rewrittenRaw.data, imageGeneration: { ...original, ...inherited } };
      blocks.set(block, rewritten);
    }
    return entries.map(entry => mapTranscriptEntryMessages(entry, message => ({
      ...message, content: message.content.map(block => blocks.get(block) ?? block),
    })));
  }

  async rewriteSubagents(entries: AgentTranscriptEntry[], chatDir: string, targetSessionDir: string, cutoff: string): Promise<void> {
    const visited = new Set<string>();
    for (const entry of entries) {
      if (entry.type !== "subagent_started" || !entry.transcriptRelativePath) continue;
      const transcriptPath = resolve(chatDir, entry.transcriptRelativePath);
      const rel = relative(targetSessionDir, transcriptPath);
      if (!rel || rel.startsWith("..") || isAbsolute(rel) || visited.has(transcriptPath)) continue;
      if (!(await pathExists(transcriptPath))) continue;
      const realRelative = relative(await realpath(targetSessionDir), await realpath(transcriptPath));
      if (!realRelative || realRelative.startsWith("..") || isAbsolute(realRelative)) throw new Error("Child transcript resolves outside the copied session.");
      visited.add(transcriptPath);
      const child = await readTranscript(transcriptPath);
      // A fork must not inherit child output produced after its fork point.
      const carried = child.entries.filter(item => !(Date.parse(item.createdAt) > Date.parse(cutoff)));
      const rewritten = await this.rewrite(carried, entry.subagentId);
      await writeFile(transcriptPath, rewritten.map(item => JSON.stringify(item) + "\n").join(""), "utf8");
    }
  }

  async rollback(): Promise<void> {
    await Promise.all([...this.jobRollbacks.values()].map(rollback => rollback()));
    await Promise.all([...this.videos.values()].flatMap(video => [video.path, join(dirname(video.path), video.videoId + ".json")]).map(file => unlink(file).catch(() => {})));
    await Promise.all([...this.images.values()].flatMap(image => [image.path, join(dirname(image.path), image.imageId + ".json")])
      .map(file => unlink(file).catch(() => {})));
  }
}

function replaceImagePath(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string") return from ? value.split(from).join(to) : value;
  if (Array.isArray(value)) return value.map(item => replaceImagePath(item, from, to));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceImagePath(item, from, to)]));
  return value;
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
  const chatDir = getPilotProjectChatDir(effectiveProjectRoot, options.pilotHome);
  const sourceSafeId = sanitizeSessionIdForPath(input.sessionKey);
  const sourceTranscriptPath = resolve(chatDir, `${sourceSafeId}.jsonl`);
  const sourceSessionDir = resolve(chatDir, sourceSafeId);

  const { entries } = await readTranscript(sourceTranscriptPath);
  if (entries.length === 0) {
    throw new ForkSessionError("fork_empty_transcript", "Cannot fork an empty session transcript.");
  }

  const forkPoint = findForkPoint(entries, input.fromEntryId);
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
  const newTranscriptPath = resolve(chatDir, `${newSafeId}.jsonl`);
  const newSessionDir = resolve(chatDir, newSafeId);
  let preserved = retargetEntriesToSession(preservedSourceEntries, {
    sessionId: newSessionKey,
    sourceSafeId,
    targetSafeId: newSafeId,
    sourceSessionDir,
    targetSessionDir: newSessionDir,
  });

  await mkdir(chatDir, { recursive: true, mode: 0o700 });
  await mkdir(newSessionDir, { recursive: true, mode: 0o700 });
  await copySessionAuxDirs(sourceSessionDir, newSessionDir);
  const images = new ForkMediaInheritance(new ImageStore(join(options.pilotHome, "generated-images")), newSessionKey, new VideoStore(join(options.pilotHome, "generated-videos")), input.sessionKey);
  try {
    preserved = await images.rewrite(preserved);
    await images.rewriteSubagents(preserved, chatDir, newSessionDir, forkPoint.target.createdAt);
  } catch (error) {
    await images.rollback();
    throw new ForkSessionError("fork_image_unavailable", `Could not inherit session attachments: ${error instanceof Error ? error.message : String(error)}`);
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

  const body = preservedLines + `${JSON.stringify(metadataEntry)}\n`;
  try {
    await writeFile(newTranscriptPath, body, { encoding: "utf8", mode: 0o600 });
    await chmod(dirname(newTranscriptPath), 0o700);
  } catch (error) {
    await images.rollback();
    throw error;
  }

  return {
    newSessionKey,
    prefillText,
    carriedMessageCount,
    ...(forkRunMode ? { runMode: forkRunMode } : {}),
    ...(forkMode ? { mode: forkMode } : {}),
  };
}
