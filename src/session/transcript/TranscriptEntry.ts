import type {
  CanonicalMessage,
  CanonicalModelEvent,
  CanonicalModelRequest,
} from "../../model/index.js";
import type { TimelinePosition } from "../../model/protocol/timeline.js";
import type { AgentTurnResult } from "../../agent/protocol/result.js";
import type { AgentInput, AgentSubmitOptions } from "../../agent/protocol/input.js";
import type { PilotDeckToolCall, PilotDeckToolResult } from "../../tool/index.js";
import type { PilotDeckTodoItem } from "../../tool/protocol/types.js";
import type { GoalSnapshot } from "../../goal/protocol/types.js";
import type { FileArtifact } from "../artifacts/FileArtifact.js";
import type {
  PermissionDecision,
  PermissionDecisionReason,
  PermissionMode,
} from "../../permission/protocol/types.js";

export type AgentTranscriptEntryType =
  | "accepted_input"
  | "assistant_message"
  | "tool_result_message"
  | "durable_message"
  | "agent_status_message"
  | "file_artifacts"
  | "file_snapshot_recorded"
  | "agent_turn_enqueued"
  | "agent_turn_discarded"
  | "turn_started"
  | "step_started"
  | "step_completed"
  | "context_snapshot"
  | "agent_instructions"
  | "model_request"
  | "model_stream_event"
  | "tool_call"
  | "tool_result"
  | "inbox_mutation"
  | "compaction_started"
  | "compaction_completed"
  | "compaction_failed"
  | "question_started"
  | "question_completed"
  | "question_failed"
  | "permission_started"
  | "permission_completed"
  | "permission_failed"
  | "agent_loop_operation_started"
  | "agent_loop_operation_accepted"
  | "agent_loop_operation_terminal"
  | "turn_result"
  | "control_boundary"
  | "session_metadata"
  | "subagent_descriptor"
  | "subagent_started"
  | "subagent_completed"
  | "plan_todo_plan_changed"
  | "plan_todo_written"
  | "plan_todo_progressed"
  | "goal_changed";

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

/** Host-owned transport binding stored without exposing a Session or Gateway. */
export type AgentLoopOperationBinding = {
  moduleInstanceId: string;
  connectionGeneration: string;
};

export type AgentLoopOperationStartedTranscriptEntry = AgentTranscriptEntryBase & {
  type: "agent_loop_operation_started";
  runId: string;
  operationId: string;
  requestId: string;
  binding: AgentLoopOperationBinding;
  idempotencyKey?: string;
};

export type AgentLoopOperationAcceptedTranscriptEntry = AgentTranscriptEntryBase & {
  type: "agent_loop_operation_accepted";
  runId: string;
  operationId: string;
  requestId: string;
  binding: AgentLoopOperationBinding;
  streamId: string;
  idempotencyKey?: string;
};

/**
 * A durable terminal observation of one sidecar request. `result_unknown`
 * intentionally has no result projection and remains fail-closed until a
 * host status owner appends a matching known terminal.
 */
export type AgentLoopOperationTerminalTranscriptEntry = AgentTranscriptEntryBase & {
  type: "agent_loop_operation_terminal";
  runId: string;
  operationId: string;
  requestId: string;
  binding: AgentLoopOperationBinding;
  streamId?: string;
  lastAppliedSequence: number;
  outcome: "completed" | "failed" | "cancelled" | "result_unknown";
  result?: AgentTurnResult;
  messages?: CanonicalMessage[];
  /** JSON-compatible AgentLoop seed-state projection. */
  seedState?: Record<string, unknown>;
  idempotencyKey?: string;
  code?: string;
  error?: unknown;
};

export type AgentTurnStartedTranscriptEntry = AgentTranscriptEntryBase & {
  type: "turn_started";
  /** Atomically claims this previously queued next-turn item. */
  inboxItemId?: string;
};

export type AgentTurnEnqueuedTranscriptEntry = AgentTranscriptEntryBase & {
  type: "agent_turn_enqueued";
  itemId: string;
  input: AgentInput;
  submitOptions: Omit<AgentSubmitOptions, "turnId">;
};

export type AgentTurnDiscardedTranscriptEntry = AgentTranscriptEntryBase & {
  type: "agent_turn_discarded";
  itemId: string;
  reason: "cancelled" | "agent_disposed";
};

export type AgentStepStartedTranscriptEntry = AgentTranscriptEntryBase & {
  type: "step_started";
  step: number;
};

export type AgentStepCompletedTranscriptEntry = AgentTranscriptEntryBase & {
  type: "step_completed";
  step: number;
  outcome: "completed" | "failed" | "aborted";
};

export type AgentContextSnapshotTranscriptEntry = AgentTranscriptEntryBase & {
  type: "context_snapshot";
  step: number;
  promptGeneration?: number;
  contexts: Array<{ name: string; text: string }>;
  /** Optional synthetic user-role surface materialized for this step. */
  runtimeContextMessages?: CanonicalMessage[];
};

export type AgentInstructionLayerSnapshot = {
  scope: string;
  path: string;
  content: string;
};

export type AgentInstructionChange = {
  action: "set" | "replace" | "remove";
  scope: string;
  path: string;
  content?: string;
};

export type AgentInstructionsTranscriptEntry = AgentTranscriptEntryBase & {
  type: "agent_instructions";
  step: number;
  baseline: boolean;
  layers?: AgentInstructionLayerSnapshot[];
  changes: AgentInstructionChange[];
};

export type AgentModelRequestTranscriptEntry = AgentTranscriptEntryBase & {
  type: "model_request";
  step: number;
  request: CanonicalModelRequest;
};

export type AgentModelStreamEventTranscriptEntry = AgentTranscriptEntryBase & {
  type: "model_stream_event";
  step: number;
  event: CanonicalModelEvent;
};

export type AgentToolCallTranscriptEntry = AgentTranscriptEntryBase & {
  type: "tool_call";
  step: number;
  call: PilotDeckToolCall;
};

export type AgentToolResultTranscriptEntry = AgentTranscriptEntryBase & {
  type: "tool_result";
  step: number;
  result: PilotDeckToolResult;
};

export type AgentInboxMutationTranscriptEntry = AgentTranscriptEntryBase & {
  type: "inbox_mutation";
  mutation: "insert" | "cancel" | "claim" | "discard";
  itemId: string;
  message?: CanonicalMessage;
  allowedReadFiles?: string[];
  reason?: "turn_ended" | "turn_closing";
};

/** Durable lifecycle bracket for one compaction attempt. */
export type AgentCompactionStartedTranscriptEntry = AgentTranscriptEntryBase & {
  type: "compaction_started";
  operationId: string;
  trigger: "auto" | "reactive" | "manual";
  messageCount: number;
  maxContextTokens?: number;
};

export type AgentCompactionCompletedTranscriptEntry = AgentTranscriptEntryBase & {
  type: "compaction_completed";
  operationId: string;
  status: "skipped" | "compacted";
  tier?: "micro" | "snip" | "full" | "emergency";
  compactionId?: string;
  messageCount: number;
  error?: "context_overflow_after_emergency_compaction";
};

export type AgentCompactionFailedTranscriptEntry = AgentTranscriptEntryBase & {
  type: "compaction_failed";
  operationId: string;
  error: string;
};

/** Durable lifecycle bracket for one user-question request. */
export type AgentQuestionStartedTranscriptEntry = AgentTranscriptEntryBase & {
  type: "question_started";
  operationId: string;
  toolCallId: string;
  toolName: string;
  questionCount: number;
};

export type AgentQuestionCompletedTranscriptEntry = AgentTranscriptEntryBase & {
  type: "question_completed";
  operationId: string;
  status: "answered" | "cancelled";
  questionCount: number;
  reason?: string;
};

export type AgentQuestionFailedTranscriptEntry = AgentTranscriptEntryBase & {
  type: "question_failed";
  operationId: string;
  error: string;
};

/** Durable lifecycle bracket for one permission evaluation/approval request. */
export type AgentPermissionStartedTranscriptEntry = AgentTranscriptEntryBase & {
  type: "permission_started";
  step: number;
  operationId: string;
  toolCallId: string;
  toolName: string;
  mode: PermissionMode;
};

export type AgentPermissionCompletedTranscriptEntry = AgentTranscriptEntryBase & {
  type: "permission_completed";
  step: number;
  operationId: string;
  toolCallId: string;
  toolName: string;
  mode: PermissionMode;
  decision: PermissionDecision["type"];
  reason: PermissionDecisionReason;
};

export type AgentPermissionFailedTranscriptEntry = AgentTranscriptEntryBase & {
  type: "permission_failed";
  step: number;
  operationId: string;
  toolCallId: string;
  toolName: string;
  mode: PermissionMode;
  error: string;
};

export type AgentFileArtifactsTranscriptEntry = AgentTranscriptEntryBase & {
  type: "file_artifacts";
  artifacts: FileArtifact[];
};

export type FileHistorySnapshotRecord = {
  messageId: string;
  trackedFileBackups: Record<
    string,
    {
      backupFileName: string | null;
      version: number;
      mode?: number;
      backupTime: string;
    }
  >;
  expectedFileStates?: Record<string, import("../filesystem/types.js").FileHistoryExpectedFileState>;
  timestamp: string;
};

export type AgentFileSnapshotRecordedTranscriptEntry = AgentTranscriptEntryBase & {
  type: "file_snapshot_recorded";
  messageId: string;
  trackedFileBackups: FileHistorySnapshotRecord["trackedFileBackups"];
  expectedFileStates?: FileHistorySnapshotRecord["expectedFileStates"];
  /** Current event-store representation. */
  timestamp?: string;
  snapshotKind?: "create" | "update";
  /** Legacy SDK compatibility representation. */
  snapshotTimestamp?: string;
};

export type CompactBoundaryMetadata = {
  timeline?: TimelinePosition;
  /** Stable identity shared by live and persisted representations. */
  compactionId?: string;
  trigger: "manual" | "auto" | "reactive";
  preTokens: number;
  postTokens?: number;
  /** Number of messages summarized into the boundary's summary section. */
  messagesSummarized?: number;
  /** Desired post-compaction prompt size. */
  targetTokens?: number;
  /** Whether this compaction emitted a summary message. */
  summaryGenerated?: boolean;
  /** Whether prior checkpoint summaries were consolidated. */
  checkpointMerged?: boolean;
  /** Final prompt usage divided by the effective input budget. */
  finalRatio?: number;
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
        /** Complete replacement context committed in the same durable record. */
        snapshot?: { version: 1; messages: CanonicalMessage[] };
        /**
         * Compatibility for records written before compact snapshots. New
         * writers always use `snapshot`, which is validated before replay.
         */
        replacementMessages?: CanonicalMessage[];
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
  /** Marks a metadata entry written by `reappendTail()` as a full snapshot. */
  isSnapshot?: true;
  title?: string;
  aiTitle?: string;
  titleSource?: "user" | "provider" | "fallback";
  titleProviderId?: string;
  titleModel?: { provider: string; model: string };
  titleMessageSequences?: number[];
  titleSourceTurnId?: string;
  tag?: string;
  firstPrompt?: string;
  lastPrompt?: string;
  gitBranch?: string;
  mode?: "normal" | "coordinator";
  /** Persisted dialog model preference. Null is an explicit clear tombstone. */
  modelSelection?:
    | { mode: "auto" }
    | { mode: "model"; provider: string; model: string; reasoning?: number; speed?: number }
    | null;
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

export type AgentOneShotSubagentDescriptorData = {
  version: 1;
  mode: "one-shot";
  provider: string;
  definitionId: string;
};

export type AgentContinuableSubagentDescriptorData = {
  version: 2;
  mode: "continuable";
  provider: string;
  definitionId: string;
  parentSessionId: string;
  label: string;
  agentProvider: string;
  agentModel: string;
};

export type AgentSubagentDescriptorData =
  | AgentOneShotSubagentDescriptorData
  | AgentContinuableSubagentDescriptorData;

/** Model-hidden creation identity stored in the child sidechain log. */
export type AgentSubagentDescriptorTranscriptEntry = AgentTranscriptEntryBase & {
  type: "subagent_descriptor";
  descriptor: AgentSubagentDescriptorData;
};

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

/** Durable session-scoped plan approval. Null clears a previously approved plan. */
export type AgentPlanTodoPlanChangedTranscriptEntry = AgentTranscriptEntryBase & {
  type: "plan_todo_plan_changed";
  plan: string | null;
};

/** Whole-list todo state after a model-visible todo_write operation. */
export type AgentPlanTodoWrittenTranscriptEntry = AgentTranscriptEntryBase & {
  type: "plan_todo_written";
  mode: "markdown" | "structured";
  merge: boolean;
  markdown?: string;
  reason?: string;
  todos: PilotDeckTodoItem[];
};

/** One successful side-effecting tool call after the todo list was initialized. */
export type AgentPlanTodoProgressedTranscriptEntry = AgentTranscriptEntryBase & {
  type: "plan_todo_progressed";
  toolName: string;
};

/** Full session-scoped goal snapshot, or a null tombstone when cleared. */
export type AgentGoalChangedTranscriptEntry = AgentTranscriptEntryBase & {
  type: "goal_changed";
  goal: GoalSnapshot | null;
  revision: number;
};

export type AgentTranscriptEntry =
  | AgentAcceptedInputTranscriptEntry
  | AgentMessageTranscriptEntry
  | AgentStatusMessageTranscriptEntry
  | AgentFileArtifactsTranscriptEntry
  | AgentFileSnapshotRecordedTranscriptEntry
  | AgentTurnEnqueuedTranscriptEntry
  | AgentTurnDiscardedTranscriptEntry
  | AgentTurnStartedTranscriptEntry
  | AgentStepStartedTranscriptEntry
  | AgentStepCompletedTranscriptEntry
  | AgentContextSnapshotTranscriptEntry
  | AgentInstructionsTranscriptEntry
  | AgentModelRequestTranscriptEntry
  | AgentModelStreamEventTranscriptEntry
  | AgentToolCallTranscriptEntry
  | AgentToolResultTranscriptEntry
  | AgentInboxMutationTranscriptEntry
  | AgentCompactionStartedTranscriptEntry
  | AgentCompactionCompletedTranscriptEntry
  | AgentCompactionFailedTranscriptEntry
  | AgentQuestionStartedTranscriptEntry
  | AgentQuestionCompletedTranscriptEntry
  | AgentQuestionFailedTranscriptEntry
  | AgentPermissionStartedTranscriptEntry
  | AgentPermissionCompletedTranscriptEntry
  | AgentPermissionFailedTranscriptEntry
  | AgentLoopOperationStartedTranscriptEntry
  | AgentLoopOperationAcceptedTranscriptEntry
  | AgentLoopOperationTerminalTranscriptEntry
  | AgentTurnResultTranscriptEntry
  | AgentControlBoundaryTranscriptEntry
  | AgentSessionMetadataTranscriptEntry
  | AgentSubagentDescriptorTranscriptEntry
  | AgentSubagentStartedTranscriptEntry
  | AgentSubagentCompletedTranscriptEntry
  | AgentPlanTodoPlanChangedTranscriptEntry
  | AgentPlanTodoWrittenTranscriptEntry
  | AgentPlanTodoProgressedTranscriptEntry
  | AgentGoalChangedTranscriptEntry;

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
