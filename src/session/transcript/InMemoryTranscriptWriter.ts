import type { CanonicalMessage } from "../../model/index.js";
import type { AgentTurnResult } from "../../agent/protocol/result.js";
import type { AgentControlBoundaryTranscriptEntry, SessionMetadataValue } from "./TranscriptEntry.js";
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
  | {
      type: "control_boundary";
      sessionId: string;
      turnId: string;
      boundary: AgentControlBoundaryTranscriptEntry["boundary"];
    };

export class InMemoryTranscriptWriter implements AgentTranscriptWriter {
  readonly entries: InMemoryTranscriptEntry[] = [];

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

  snapshotState(): AgentTranscriptWriterState {
    return {
      sequence: this.entries.length,
      lastEntryId: null,
    };
  }
}
