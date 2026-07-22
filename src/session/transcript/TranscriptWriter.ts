import type { CanonicalMessage } from "../../model/index.js";
import type { AgentTurnResult } from "../../agent/protocol/result.js";
import type {
  AgentControlBoundaryTranscriptEntry,
  AgentStatusMessageTranscriptEntry,
  AgentTranscriptEntry,
  SessionMetadataValue,
} from "./TranscriptEntry.js";
import type { FileArtifact } from "../artifacts/FileArtifact.js";

export type AgentStatusMessageInput = Pick<
  AgentStatusMessageTranscriptEntry,
  "event" | "kind" | "text" | "detail"
>;

export type AgentTranscriptWriterState = {
  sequence: number;
  lastEntryId: string | null;
};

export type AgentTranscriptWriter = {
  recordAcceptedInput(
    sessionId: string,
    turnId: string,
    messages: CanonicalMessage[],
    metadata?: Record<string, unknown>,
  ): void | Promise<void>;
  recordDurableMessage(sessionId: string, turnId: string, message: CanonicalMessage): void | Promise<void>;
  recordAgentStatusMessage?(sessionId: string, turnId: string, status: AgentStatusMessageInput): void | Promise<void>;
  recordFileArtifacts?(sessionId: string, turnId: string, artifacts: FileArtifact[]): void | Promise<void>;
  recordTurnResult(sessionId: string, turnId: string, result: AgentTurnResult): void | Promise<void>;
  recordSessionMetadata?(sessionId: string, turnId: string, metadata: SessionMetadataValue): void | Promise<void>;
  recordControlBoundary?(
    sessionId: string,
    turnId: string,
    boundary: AgentControlBoundaryTranscriptEntry["boundary"],
  ): void | Promise<void>;
  recordEntry?(entry: AgentTranscriptEntry): void | Promise<void>;
  snapshotState?(): AgentTranscriptWriterState;
};
