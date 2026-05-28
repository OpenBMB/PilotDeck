import type { CanonicalMessage } from "../../model/index.js";
import type { AgentTurnResult } from "../../agent/protocol/result.js";
import type { AgentControlBoundaryTranscriptEntry, SessionMetadataValue } from "./TranscriptEntry.js";
import type { AgentTranscriptWriter, AgentTranscriptWriterState } from "./TranscriptWriter.js";

export type InMemoryTranscriptEntry =
  | { type: "accepted_input"; sessionId: string; turnId: string; messages: CanonicalMessage[] }
  | { type: "durable_message"; sessionId: string; turnId: string; message: CanonicalMessage }
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

  recordAcceptedInput(sessionId: string, turnId: string, messages: CanonicalMessage[]): void {
    this.entries.push({ type: "accepted_input", sessionId, turnId, messages });
  }

  recordDurableMessage(sessionId: string, turnId: string, message: CanonicalMessage): void {
    this.entries.push({ type: "durable_message", sessionId, turnId, message });
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
