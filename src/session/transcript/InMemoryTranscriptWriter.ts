import type { CanonicalMessage } from "../../model/index.js";
import type { AgentTurnResult } from "../../agent/protocol/result.js";
import { InMemorySessionEventStore } from "../events/InMemorySessionEventStore.js";
import type {
  SequencedSessionEventStoreOptions,
  SessionEventDraft,
} from "../events/SessionEventStore.js";
import type {
  AgentControlBoundaryTranscriptEntry,
  AgentFileSnapshotRecordedTranscriptEntry,
  AgentTranscriptEntry,
  FileHistorySnapshotRecord,
  SessionMetadataValue,
} from "./TranscriptEntry.js";
import {
  truncatePreview,
  SUBAGENT_PROMPT_PREVIEW_BYTES,
  SUBAGENT_SUMMARY_PREVIEW_BYTES,
} from "./TranscriptEntry.js";
import type { AgentStatusMessageInput } from "./TranscriptWriter.js";
import type { AgentTranscriptWriter, AgentTranscriptWriterState } from "./TranscriptWriter.js";
import type { FileArtifact } from "../artifacts/FileArtifact.js";

export type InMemoryTranscriptEntry = AgentTranscriptEntry;

export type InMemoryTranscriptWriterOptions = SequencedSessionEventStoreOptions & {
  eventStore?: InMemorySessionEventStore;
};

export type InMemorySubagentTranscriptHandle = {
  subagentId: string;
  writer: InMemoryTranscriptWriter;
  transcriptPath: string;
};

export class InMemoryTranscriptWriter implements AgentTranscriptWriter {
  private readonly eventStore: InMemorySessionEventStore;
  private readonly subagentWriters = new Map<string, InMemoryTranscriptWriter>();

  constructor(options: InMemoryTranscriptWriterOptions = {}) {
    this.eventStore = options.eventStore ?? new InMemorySessionEventStore(options);
  }

  get entries(): InMemoryTranscriptEntry[] {
    return this.eventStore.entries;
  }

  recordSessionEvent(sessionId: string, turnId: string, event: SessionEventDraft): Promise<void> {
    return this.append(sessionId, turnId, event);
  }

  recordAcceptedInput(
    sessionId: string,
    turnId: string,
    messages: CanonicalMessage[],
    metadata?: Record<string, unknown>,
  ): void | Promise<void> {
    return this.append(sessionId, turnId, {
      type: "accepted_input",
      messages,
      ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
  }

  recordDurableMessage(sessionId: string, turnId: string, message: CanonicalMessage): void | Promise<void> {
    return this.append(sessionId, turnId, { type: "durable_message", message });
  }

  recordAgentStatusMessage(
    sessionId: string,
    turnId: string,
    status: AgentStatusMessageInput,
  ): void | Promise<void> {
    return this.append(sessionId, turnId, { type: "agent_status_message", ...status });
  }

  recordFileArtifacts(sessionId: string, turnId: string, artifacts: FileArtifact[]): void | Promise<void> {
    return this.append(sessionId, turnId, { type: "file_artifacts", artifacts });
  }

  recordFileHistorySnapshot(
    sessionId: string,
    turnId: string,
    snapshot: FileHistorySnapshotRecord,
    snapshotKind: "create" | "update",
  ): void | Promise<void> {
    return this.append(sessionId, turnId, {
      type: "file_snapshot_recorded",
      snapshotKind,
      ...snapshot,
    });
  }

  recordTurnResult(sessionId: string, turnId: string, result: AgentTurnResult): void | Promise<void> {
    return this.append(sessionId, turnId, { type: "turn_result", result });
  }

  recordSessionMetadata(
    sessionId: string,
    turnId: string,
    metadata: SessionMetadataValue,
  ): void | Promise<void> {
    return this.append(sessionId, turnId, { type: "session_metadata", metadata });
  }

  recordControlBoundary(
    sessionId: string,
    turnId: string,
    boundary: AgentControlBoundaryTranscriptEntry["boundary"],
  ): void | Promise<void> {
    return this.append(sessionId, turnId, { type: "control_boundary", boundary });
  }

  recordCompactionReplacement(
    sessionId: string,
    turnId: string,
    boundary: Extract<AgentControlBoundaryTranscriptEntry["boundary"], { kind: "compact"; subtype: "compact_boundary" }>,
    messages: CanonicalMessage[],
  ): Promise<void> {
    return this.append(sessionId, turnId, {
      type: "control_boundary",
      boundary: {
        ...boundary,
        snapshot: { version: 1, messages: messages.map((message) => structuredClone(message)) },
      },
    });
  }

  recordEntry(entry: AgentTranscriptEntry): void | Promise<void> {
    return this.eventStore.appendRecorded(entry);
  }

  recordFileSnapshot(
    sessionId: string,
    turnId: string,
    snapshot: Omit<AgentFileSnapshotRecordedTranscriptEntry, "type" | "sessionId" | "turnId" | "sequence" | "createdAt" | "entryId" | "parentEntryId">,
  ): void | Promise<void> {
    return this.append(sessionId, turnId, { type: "file_snapshot_recorded", ...snapshot });
  }

  recordSubagentStarted(
    sessionId: string,
    turnId: string,
    args: {
      subagentId: string;
      subagentType: string;
      prompt: string;
      transcriptRelativePath: string;
      subagentSessionId?: string;
    },
  ): void | Promise<void> {
    const { preview, truncated } = truncatePreview(args.prompt, SUBAGENT_PROMPT_PREVIEW_BYTES);
    return this.append(sessionId, turnId, {
      type: "subagent_started",
      subagentId: args.subagentId,
      subagentType: args.subagentType,
      promptPreview: preview,
      promptTruncated: truncated,
      transcriptRelativePath: args.transcriptRelativePath,
      subagentSessionId: args.subagentSessionId,
    });
  }

  recordSubagentCompleted(
    sessionId: string,
    turnId: string,
    args: {
      subagentId: string;
      subagentType: string;
      summary: string;
      usage?: Record<string, unknown>;
      turns: number;
      durationMs: number;
      errored?: boolean;
    },
  ): void | Promise<void> {
    const { preview, truncated } = truncatePreview(args.summary, SUBAGENT_SUMMARY_PREVIEW_BYTES);
    return this.append(sessionId, turnId, {
      type: "subagent_completed",
      subagentId: args.subagentId,
      subagentType: args.subagentType,
      summaryPreview: preview,
      summaryTruncated: truncated,
      usage: args.usage,
      turns: args.turns,
      durationMs: args.durationMs,
      errored: args.errored,
    });
  }

  /**
   * Keeps sidechain state in the same process for ephemeral Gateway sessions.
   * The returned path is an identifier only; no transcript file is created.
   */
  forSubagent(subagentId: string, _now?: () => Date): InMemorySubagentTranscriptHandle {
    let writer = this.subagentWriters.get(subagentId);
    if (!writer) {
      writer = new InMemoryTranscriptWriter();
      this.subagentWriters.set(subagentId, writer);
    }
    return {
      subagentId,
      writer,
      transcriptPath: `memory://pilotdeck/subagents/${encodeURIComponent(subagentId)}`,
    };
  }

  relativeSubagentPath(subagentId: string): string {
    return `subagents/${encodeURIComponent(subagentId)}.jsonl`;
  }

  restoreState(_maxSequence: number, _lastEntryId: string | null): void {
    // Ephemeral sessions never resume from durable storage.
  }

  snapshotState(): AgentTranscriptWriterState {
    return this.eventStore.snapshotState();
  }

  private append(sessionId: string, turnId: string, event: SessionEventDraft): Promise<void> {
    return this.eventStore.append(sessionId, turnId, event).then(() => undefined);
  }
}
