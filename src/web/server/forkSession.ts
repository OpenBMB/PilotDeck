/**
 * Fork a web session transcript at a prior user turn.
 *
 * Creates a new session file containing all entries strictly before the
 * fork turn, copies auxiliary session dirs, and returns the forked user
 * message text for composer prefill.
 */

import { randomUUID } from "node:crypto";
import { cp, mkdir, writeFile, chmod } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { platform } from "node:process";
import type { CanonicalContentBlock } from "../../model/index.js";
import { getPilotProjectChatDir } from "../../pilot/index.js";
import { readTranscript } from "../../session/transcript/TranscriptReader.js";
import {
  sanitizeSessionIdForPath,
} from "../../session/storage/ProjectSessionStorage.js";
import type {
  AgentAcceptedInputTranscriptEntry,
  AgentSessionMetadataTranscriptEntry,
  AgentTranscriptEntry,
} from "../../session/transcript/TranscriptEntry.js";
import type { WebForkSessionInput, WebForkSessionResult } from "../client/protocol.js";

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
  for (const message of entry.messages) {
    for (const block of message.content as CanonicalContentBlock[]) {
      if (block.type === "text" && block.text.trim()) {
        return block.text.trim();
      }
    }
  }
  return "";
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

function findForkTurnAcceptedInput(
  entries: AgentTranscriptEntry[],
  fromEntryId: string,
): AgentAcceptedInputTranscriptEntry {
  const target = entries.find((entry) => entry.entryId === fromEntryId);
  if (!target) {
    throw new ForkSessionError("fork_entry_not_found", `Transcript entry not found: ${fromEntryId}`);
  }

  if (target.type === "accepted_input") {
    return target;
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
  return accepted;
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

async function copySessionAuxDirs(sourceSessionDir: string, targetSessionDir: string): Promise<void> {
  for (const subdir of ["tool-results", "file-history"] as const) {
    const source = join(sourceSessionDir, subdir);
    const target = join(targetSessionDir, subdir);
    try {
      await cp(source, target, { recursive: true, force: true });
    } catch {
      // Missing auxiliary dirs are normal for early sessions.
    }
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
  const chatDir = getPilotProjectChatDir(effectiveProjectRoot, options.pilotHome);
  const sourceSafeId = sanitizeSessionIdForPath(input.sessionKey);
  const sourceTranscriptPath = resolve(chatDir, `${sourceSafeId}.jsonl`);
  const sourceSessionDir = resolve(chatDir, sourceSafeId);

  const { entries } = await readTranscript(sourceTranscriptPath);
  if (entries.length === 0) {
    throw new ForkSessionError("fork_empty_transcript", "Cannot fork an empty session transcript.");
  }

  const forkAcceptedInput = findForkTurnAcceptedInput(entries, input.fromEntryId);
  const cutoffSequence = forkAcceptedInput.sequence;
  const preserved = entries.filter((entry) => entry.sequence < cutoffSequence);
  const prefillText = extractAcceptedInputText(forkAcceptedInput);
  const carriedMessageCount = countCarriedUserAssistantMessages(preserved);

  const newSessionKey = newWebSessionKey();
  const newSafeId = sanitizeSessionIdForPath(newSessionKey);
  const newTranscriptPath = resolve(chatDir, `${newSafeId}.jsonl`);
  const newSessionDir = resolve(chatDir, newSafeId);

  await mkdir(chatDir, { recursive: true, mode: 0o700 });
  await mkdir(newSessionDir, { recursive: true, mode: 0o700 });

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
  const forkTitle = buildForkTitle(prefillText, carriedMessageCount, inheritedTitle);

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
      firstPrompt: prefillText || undefined,
      updatedAt: now().toISOString(),
    },
  };

  const body = preservedLines + `${JSON.stringify(metadataEntry)}\n`;
  await writeFile(newTranscriptPath, body, { encoding: "utf8", mode: 0o600 });
  await chmod(dirname(newTranscriptPath), 0o700);

  await copySessionAuxDirs(sourceSessionDir, newSessionDir);

  return {
    newSessionKey,
    prefillText,
    carriedMessageCount,
  };
}
