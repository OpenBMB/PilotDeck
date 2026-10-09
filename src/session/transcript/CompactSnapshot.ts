import type { CanonicalMessage } from "../../model/index.js";
import type { AgentTranscriptEntry } from "./TranscriptEntry.js";

/** JSON on disk is untrusted even when it parses as a complete record. */
export function readCompactSnapshot(entry: AgentTranscriptEntry): CanonicalMessage[] | undefined {
  if (entry.type !== "control_boundary") return undefined;
  const boundary = entry.boundary;
  if (!isRecord(boundary) || boundary.kind !== "compact" || boundary.subtype !== "compact_boundary") {
    return undefined;
  }
  const snapshot: unknown = boundary.snapshot;
  if (!isRecord(snapshot) || snapshot.version !== 1 || !Array.isArray(snapshot.messages) ||
      snapshot.messages.length === 0 || !snapshot.messages.every(isMessage)) {
    return undefined;
  }
  return snapshot.messages;
}

export function readRestoreSnapshot(entry: AgentTranscriptEntry): CanonicalMessage[] | undefined {
  if (entry.type !== "control_boundary" || entry.boundary?.kind !== "restore") return undefined;
  const snapshot = entry.boundary.snapshot;
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.messages) || !snapshot.messages.every(isMessage) ||
      !Array.isArray(entry.boundary.visibleSequences) || !entry.boundary.visibleSequences.every(value => Number.isSafeInteger(value) && value >= 0)) return undefined;
  return snapshot.messages;
}

/** Project the active history branch; old entries stay in the append-only transcript. */
export function activeTranscriptEntries(entries: AgentTranscriptEntry[]): AgentTranscriptEntry[] {
  let visible: AgentTranscriptEntry[] = [];
  for (const entry of entries) {
    if (readRestoreSnapshot(entry) !== undefined && entry.type === "control_boundary" && entry.boundary.kind === "restore") {
      const sequences = new Set(entry.boundary.visibleSequences);
      visible = entries.filter(candidate => candidate.sequence < entry.sequence && sequences.has(candidate.sequence));
    }
    visible.push(entry);
  }
  return visible;
}

function isMessage(value: unknown): value is CanonicalMessage {
  return isRecord(value) && (value.role === "user" || value.role === "assistant") &&
    (value.metadata === undefined || isRecord(value.metadata)) &&
    Array.isArray(value.content) && value.content.every(isContentBlock);
}

function isContentBlock(value: unknown): boolean {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "text":
    case "thinking":
      return typeof value.text === "string";
    case "image":
    case "audio":
      return (value.source === "base64" || value.source === "url") &&
        typeof value.data === "string" && typeof value.mimeType === "string";
    case "pdf":
      return value.source === "base64" && typeof value.data === "string" &&
        value.mimeType === "application/pdf" && typeof value.bytes === "number";
    case "tool_call":
      return typeof value.id === "string" && typeof value.name === "string";
    case "tool_result":
      return typeof value.toolCallId === "string" && Array.isArray(value.content) &&
        value.content.every((block: unknown) => isRecord(block) &&
          ["text", "image", "pdf"].includes(String(block.type)) && isContentBlock(block));
    case "tool_result_reference":
    case "media_reference":
      return typeof value.path === "string" && typeof value.originalBytes === "number" &&
        typeof value.preview === "string" && typeof value.hasMore === "boolean" &&
        (value.type === "tool_result_reference"
          ? typeof value.toolCallId === "string"
          : typeof value.mimeType === "string" && ["image", "pdf", "audio"].includes(String(value.mediaType)));
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
