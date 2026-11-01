/**
 * task_id continuation loader — reads a forked subagent's sidechain
 * transcript from disk and validates that it can be safely resumed.
 *
 * Storage scoping: callers pass a path derived from the *calling parent
 * session's* storage directory (`storage.subagentTranscriptPath(taskId)`).
 * A task created by a foreign parent session therefore has no file here, so
 * unknown ids and foreign-parent ids fail identically with
 * `subagent_task_unknown` and no history of another session is ever opened.
 *
 * Supported history (formatVersion 2): every accepted turn carries a
 * `turn_result`, the latest `subagentTask` metadata names the child
 * identity / provider / model, and the last round finished successfully.
 * Anything else (legacy transcripts, crash-truncated rounds, failed rounds)
 * is rejected so callers start a fresh child with its own clean context
 * instead of resuming from an unsafe state.
 */

import { stat } from "node:fs/promises";

import { filterIncompleteToolCalls } from "../../agent/sub/filterIncompleteToolCalls.js";
import {
  SubagentContinuationError,
  type SubagentContinuationState,
} from "../../agent/sub/continuation.js";
import { cloneMessages } from "../../model/index.js";
import { readTranscript } from "./TranscriptReader.js";
import { replayTranscriptEntries } from "./TranscriptReplay.js";
import type { AgentTranscriptWriterState } from "./TranscriptWriter.js";

export type LoadSubagentContinuationArgs = {
  /** Session-scoped sidechain path for the requested task id. */
  transcriptPath: string;
  /** When provided, must match the saved definition id. */
  requestedDefinitionId?: string;
  /** Calling parent session id — tasks of other parents are unknown here. */
  expectedParentSessionId?: string;
  expectedSubagentId?: string;
};

export type LoadedSubagentContinuation = SubagentContinuationState & {
  /** Writer state the sidechain writer must be re-seeded with before appending. */
  seed: AgentTranscriptWriterState;
};

export async function loadSubagentContinuation(
  args: LoadSubagentContinuationArgs,
): Promise<LoadedSubagentContinuation> {
  if (args.expectedSubagentId !== undefined && !/^[A-Za-z0-9_-]{1,256}$/.test(args.expectedSubagentId)) {
    throw new SubagentContinuationError("subagent_task_unknown", "Unknown task_id in this parent session.");
  }
  // Ownership / existence check BEFORE opening the history: the path lives
  // under the calling session's storage dir, so stat is the scoping gate.
  try {
    await stat(args.transcriptPath);
  } catch {
    throw new SubagentContinuationError(
      "subagent_task_unknown",
      "Unknown task_id in this parent session. Start a new agent call instead.",
    );
  }

  let transcript: Awaited<ReturnType<typeof readTranscript>>;
  try {
    transcript = await readTranscript(args.transcriptPath);
  } catch {
    throw unsupported("the child transcript could not be read");
  }
  const { entries, diagnostics } = transcript;
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    throw unsupported("the transcript contains invalid or unreadable entries");
  }
  if (entries.length === 0) {
    throw new SubagentContinuationError(
      "subagent_task_unknown",
      "Unknown task_id: no child history is recorded in this parent session.",
    );
  }

  const completedTurnIds = new Set(
    entries.filter((entry) => entry.type === "turn_result").map((entry) => entry.turnId),
  );
  const acceptedTurnIds = [
    ...new Set(entries.filter((entry) => entry.type === "accepted_input").map((entry) => entry.turnId)),
  ];
  if (acceptedTurnIds.length === 0) {
    throw unsupported("sidechain transcript carries no accepted turns");
  }
  const incomplete = acceptedTurnIds.filter((turnId) => !completedTurnIds.has(turnId));
  if (incomplete.length > 0) {
    throw unsupported(
      `sidechain has incomplete rounds without a turn_result (${incomplete.join(", ")}); resuming them is unsafe`,
    );
  }

  const replay = replayTranscriptEntries(entries);
  const task = replay.metadata.subagentTask;
  if (!task || task.formatVersion !== 2 || [task.definitionId, task.subagentId, task.subagentSessionId].some((value) => typeof value !== "string" || !value)) {
    throw unsupported(
      "sidechain transcript predates task_id continuation (no subagentTask metadata); start a new agent call instead",
    );
  }
  if (
    args.expectedParentSessionId !== undefined
    && task.parentSessionId !== args.expectedParentSessionId
  ) {
    throw new SubagentContinuationError(
      "subagent_task_unknown",
      "Unknown task_id in this parent session.",
    );
  }
  if (args.expectedSubagentId !== undefined && task.subagentId !== args.expectedSubagentId) {
    throw new SubagentContinuationError("subagent_task_unknown", "Unknown task_id in this parent session.");
  }
  if (entries.some((entry) => entry.sessionId !== task.subagentSessionId)) {
    throw unsupported("the recorded child session does not match its history");
  }
  const sequences = entries.map((entry) => entry.sequence);
  if (sequences.some((sequence) => !Number.isSafeInteger(sequence) || sequence < 1) || new Set(sequences).size !== sequences.length) {
    throw unsupported("the transcript contains invalid or duplicate sequence numbers");
  }
  if (
    args.requestedDefinitionId !== undefined
    && args.requestedDefinitionId !== task.definitionId
  ) {
    throw new SubagentContinuationError(
      "subagent_task_type_conflict",
      `subagent_type "${args.requestedDefinitionId}" conflicts with the saved task definition "${task.definitionId}"; omit subagent_type to reuse the task's identity`,
    );
  }
  if (typeof task.provider !== "string" || task.provider.length === 0 || typeof task.model !== "string" || task.model.length === 0) {
    throw new SubagentContinuationError(
      "subagent_task_model_missing",
      "saved task metadata is missing its provider/model; refusing to continue with a silently switched model",
    );
  }

  const lastResultEntry = [...entries].reverse().find((entry) => entry.type === "turn_result");
  if (!lastResultEntry || lastResultEntry.type !== "turn_result" || lastResultEntry.result.type !== "success") {
    const lastType = lastResultEntry && lastResultEntry.type === "turn_result" ? lastResultEntry.result.type : "missing";
    throw new SubagentContinuationError(
      "subagent_task_round_failed",
      `last recorded round of task did not complete successfully (result: ${lastType}); start a new agent call with its own clean context instead`,
    );
  }
  if (replay.messages.length === 0) {
    throw unsupported("sidechain replay produced no durable messages");
  }

  const maxSequence = entries.reduce((max, entry) => Math.max(max, entry.sequence), 0);
  const lastEntry = entries[entries.length - 1]!;

  return {
    messages: filterIncompleteToolCalls(cloneMessages(replay.messages)),
    definitionId: task.definitionId,
    provider: task.provider,
    model: task.model,
    subagentSessionId: task.subagentSessionId,
    nextTurnIndex: acceptedTurnIds.length,
    seed: { sequence: maxSequence, lastEntryId: lastEntry.entryId ?? null },
  };
}

function unsupported(reason: string): SubagentContinuationError {
  return new SubagentContinuationError(
    "subagent_task_history_unsupported",
    `task history cannot be safely resumed: ${reason}.`,
  );
}
