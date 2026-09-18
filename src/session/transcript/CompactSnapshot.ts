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
