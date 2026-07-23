import type { CanonicalMessage } from "../../model/index.js";
import type { AgentTurnResult } from "../../agent/protocol/result.js";
import type { FileArtifact } from "../artifacts/FileArtifact.js";

export type AgentTranscriptEntryType =
  | "accepted_input"
  | "assistant_message"
  | "tool_result_message"
  | "durable_message"
  | "agent_status_message"
  | "file_artifacts"
  | "turn_result"
  | "control_boundary"
  | "session_metadata"
  | "subagent_started"
  | "subagent_completed";

export type AgentTranscriptEntryBase = {
  type: AgentTranscriptEntryType;
  sessionId: string;
  turnId: string;
  sequence: number;
  createdAt: string;
  entryId?: string;
  parentEntryId?: string | null;
};

export type AgentAcceptedInputTranscriptEntry = AgentTranscriptEntryBase & {
  type: "accepted_input";
  messages: CanonicalMessage[];
  metadata?: Record<string, unknown>;
};

export type AgentMessageTranscriptEntry = AgentTranscriptEntryBase & {
  type: "assistant_message" | "tool_result_message" | "durable_message";
  message: CanonicalMessage;
};

export type AgentStatusMessageTranscriptEntry = AgentTranscriptEntryBase & {
  type: "agent_status_message";
  event: string;
  kind: "status" | "error";
  text: string;
  detail?: Record<string, unknown>;
};

export type AgentTurnResultTranscriptEntry = AgentTranscriptEntryBase & {
  type: "turn_result";
  result: AgentTurnResult;
};

export type AgentFileArtifactsTranscriptEntry = AgentTranscriptEntryBase & {
  type: "file_artifacts";
  artifacts: FileArtifact[];
};

export type CompactBoundaryMetadata = {
  trigger: "manual" | "auto" | "reactive";
  preTokens: number;
  postTokens?: number;
  /** Number of messages summarized into the boundary's summary section. */
  messagesSummarized?: number;
  /** Logical parent uuid before compact (for resume relink). */
  logicalParentUuid?: string;
  /** Optional verbatim segment that was preserved across the boundary. */
  preservedSegment?: {
    fromIndex: number;
    toIndex: number;
  };
  /**
   * Tools that were available before compact; used by replay to detect missing
   * tool references after compact.
   */
  preCompactDiscoveredTools?: string[];
  /** Free-form additional metadata. */
  extra?: Record<string, unknown>;
};

export type MicroCompactBoundaryMetadata = {
  trigger: "time_based" | "cached";
  toolCallIds: string[];
  rewrittenBytes?: number;
};

export type AgentControlBoundaryTranscriptEntry = AgentTranscriptEntryBase & {
  type: "control_boundary";
  boundary:
    | {
        kind: "compact";
        subtype: "compact_boundary";
        compactMetadata: CompactBoundaryMetadata;
      }
    | {
        kind: "compact";
        subtype: "microcompact_boundary";
        microCompactMetadata: MicroCompactBoundaryMetadata;
      }
    | {
        kind: "resume" | "manual";
        metadata?: Record<string, unknown>;
      };
};

export type SessionMetadataValue = {
  title?: string;
  aiTitle?: string;
  tag?: string;
  firstPrompt?: string;
  lastPrompt?: string;
  gitBranch?: string;
  mode?: "normal" | "coordinator";
  linkedPullRequest?: {
    number: number;
    url: string;
    repository: string;
  };
  /** Parent session when this transcript was created via history fork. */
  parentSessionId?: string;
  /** Turn id of the fork point in the parent session. */
  forkedFromTurnId?: string;
  updatedAt?: string;
};

export type AgentSessionMetadataTranscriptEntry = AgentTranscriptEntryBase & {
  type: "session_metadata";
  metadata: SessionMetadataValue;
};

/**
 * Soft caps for sidechain reference fields. The full directive / final report
 * lives in the sidechain transcript; the parent records only a truncated
 * preview so the parent transcript stays bounded.
 */
export const SUBAGENT_PROMPT_PREVIEW_BYTES = 1024;
export const SUBAGENT_SUMMARY_PREVIEW_BYTES = 4 * 1024;

export type AgentSubagentStartedTranscriptEntry = AgentTranscriptEntryBase & {
  type: "subagent_started";
  /** UUID v4 of the forked subagent (matches sidechain filename). */
  subagentId: string;
  /** Definition id (`general-purpose` / `explore` / `plan`). */
  subagentType: string;
  /**
   * Truncated parent directive — capped at {@link SUBAGENT_PROMPT_PREVIEW_BYTES}
   * to keep main-transcript size bounded. Full directive is the first user
   * message in the sidechain.
   */
  promptPreview: string;
  /** Whether {@link promptPreview} is truncated. */
  promptTruncated: boolean;
  /** Relative path (from session dir) of the sidechain transcript. */
  transcriptRelativePath: string;
  /** Optional sub-session id if the SubAgentSession namespaces sessions. */
  subagentSessionId?: string;
};

export type AgentSubagentCompletedTranscriptEntry = AgentTranscriptEntryBase & {
  type: "subagent_completed";
  subagentId: string;
  subagentType: string;
  /** Truncated final assistant report. */
  summaryPreview: string;
  /** Whether {@link summaryPreview} is truncated. */
  summaryTruncated: boolean;
  /** Aggregate usage from the AgentLoop run. */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens?: number;
  };
  /** Number of internal turns the subagent took. */
  turns: number;
  durationMs: number;
  /** True when the run errored (subagent emitted an error result). */
  errored?: boolean;
};

export type AgentTranscriptEntry =
  | AgentAcceptedInputTranscriptEntry
  | AgentMessageTranscriptEntry
  | AgentStatusMessageTranscriptEntry
  | AgentFileArtifactsTranscriptEntry
  | AgentTurnResultTranscriptEntry
  | AgentControlBoundaryTranscriptEntry
  | AgentSessionMetadataTranscriptEntry
  | AgentSubagentStartedTranscriptEntry
  | AgentSubagentCompletedTranscriptEntry;

export function truncatePreview(input: string, byteCap: number): { preview: string; truncated: boolean } {
  const total = Buffer.byteLength(input, "utf8");
  if (total <= byteCap) return { preview: input, truncated: false };
  // Walk codepoint-by-codepoint so we never cut inside a UTF-8 sequence.
  let bytes = 0;
  let out = "";
  for (const ch of input) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (bytes + chBytes > byteCap) break;
    bytes += chBytes;
    out += ch;
  }
  return { preview: out, truncated: true };
}

export type AgentTranscriptDiagnostic = {
  code: "transcript_missing" | "transcript_too_large" | "transcript_line_invalid" | "transcript_entry_invalid";
  severity: "warning" | "error";
  message: string;
  line?: number;
};

export function classifyDurableMessageEntry(message: CanonicalMessage): AgentMessageTranscriptEntry["type"] {
  if (message.role === "assistant") {
    return "assistant_message";
  }

  if (message.content.some((block) => block.type === "tool_result")) {
    return "tool_result_message";
  }

  return "durable_message";
}
