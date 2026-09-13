import type { CanonicalMessage } from "../../model/index.js";
import type { AgentTurnResult } from "../../agent/protocol/result.js";
import type { AgentControlBoundaryTranscriptEntry, AgentFileSnapshotRecordedTranscriptEntry, SessionMetadataValue } from "./TranscriptEntry.js";
import type { AgentStatusMessageInput } from "./TranscriptWriter.js";
import type { AgentTranscriptWriter, AgentTranscriptWriterState } from "./TranscriptWriter.js";
import type { FileArtifact } from "../artifacts/FileArtifact.js";

export type InMemoryTranscriptEntry =
  | {
      type: "accepted_input";
      sessionId: string;
      turnId: string;
      messages: CanonicalMessage[];
      metadata?: Record<string, unknown>;
    }
  | { type: "durable_message"; sessionId: string; turnId: string; message: CanonicalMessage }
  | { type: "agent_status_message"; sessionId: string; turnId: string } & AgentStatusMessageInput
  | { type: "file_artifacts"; sessionId: string; turnId: string; artifacts: FileArtifact[] }
  | { type: "turn_result"; sessionId: string; turnId: string; result: AgentTurnResult }
  | { type: "session_metadata"; sessionId: string; turnId: string; metadata: SessionMetadataValue }
  | { type: "file_snapshot_recorded"; sessionId: string; turnId: string } & Omit<AgentFileSnapshotRecordedTranscriptEntry, "type" | "sessionId" | "turnId" | "sequence" | "createdAt" | "entryId" | "parentEntryId">
  | {
      type: "control_boundary";
      sessionId: string;
      turnId: string;
      boundary: AgentControlBoundaryTranscriptEntry["boundary"];
    }
  | {
      type: "subagent_started";
      sessionId: string;
      turnId: string;
      subagentId: string;
      subagentType: string;
      prompt: string;
      transcriptRelativePath: string;
      subagentSessionId?: string;
    }
  | {
      type: "subagent_completed";
      sessionId: string;
      turnId: string;
      subagentId: string;
      subagentType: string;
      summary: string;
      usage?: Record<string, unknown>;
      turns: number;
      durationMs: number;
      errored?: boolean;
    };

export type InMemorySubagentTranscriptHandle = {
  subagentId: string;
  writer: InMemoryTranscriptWriter;
  transcriptPath: string;
};

export class InMemoryTranscriptWriter implements AgentTranscriptWriter {
  readonly entries: InMemoryTranscriptEntry[] = [];
  private readonly subagentWriters = new Map<string, InMemoryTranscriptWriter>();

  recordAcceptedInput(
    sessionId: string,
    turnId: string,
    messages: CanonicalMessage[],
    metadata?: Record<string, unknown>,
  ): void {
    this.entries.push({
      type: "accepted_input",
      sessionId,
      turnId,
      messages,
      ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
  }

  recordDurableMessage(sessionId: string, turnId: string, message: CanonicalMessage): void {
    this.entries.push({ type: "durable_message", sessionId, turnId, message });
  }

  recordAgentStatusMessage(sessionId: string, turnId: string, status: AgentStatusMessageInput): void {
    this.entries.push({ type: "agent_status_message", sessionId, turnId, ...status });
  }

  recordFileArtifacts(sessionId: string, turnId: string, artifacts: FileArtifact[]): void {
    this.entries.push({ type: "file_artifacts", sessionId, turnId, artifacts });
  }

  recordTurnResult(sessionId: string, turnId: string, result: AgentTurnResult): void {
    this.entries.push({ type: "turn_result", sessionId, turnId, result });
  }

  recordSessionMetadata(sessionId: string, turnId: string, metadata: SessionMetadataValue): void {
    this.entries.push({ type: "session_metadata", sessionId, turnId, metadata });
  }

  recordControlBoundary(
    sessionId: string,
    turnId: string,
    boundary: AgentControlBoundaryTranscriptEntry["boundary"],
  ): void {
    this.entries.push({ type: "control_boundary", sessionId, turnId, boundary });
  }

  recordFileSnapshot(
    sessionId: string,
    turnId: string,
    snapshot: Omit<AgentFileSnapshotRecordedTranscriptEntry, "type" | "sessionId" | "turnId" | "sequence" | "createdAt" | "entryId" | "parentEntryId">,
  ): void {
    this.entries.push({ type: "file_snapshot_recorded", sessionId, turnId, ...snapshot });
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
  ): void {
    this.entries.push({ type: "subagent_started", sessionId, turnId, ...args });
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
  ): void {
    this.entries.push({ type: "subagent_completed", sessionId, turnId, ...args });
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
    return {
      sequence: this.entries.length,
      lastEntryId: null,
    };
  }
}
