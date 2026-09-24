/**
 * Storage-level wiring for the agent loop's subagent transcript hooks.
 *
 * Extracted from `createLocalGateway` so the gateway, tests, and any other
 * host share one code path. The factory binds the hooks to one parent
 * session's {@link AgentProjectSessionStorage}: sidechain paths stay inside
 * that session's storage directory, which is what scopes `task_id`
 * continuation to the owning parent session (a task of a different parent
 * session simply has no sidechain file here).
 */

import type { AgentSubagentTranscriptHooks } from "../../agent/runtime/AgentRuntimeDependencies.js";
import type { AgentTurnResult } from "../../agent/protocol/result.js";
import { loadSubagentContinuation } from "../transcript/loadSubagentContinuation.js";
import type {
  AgentControlBoundaryTranscriptEntry,
  SessionMetadataValue,
} from "../transcript/TranscriptEntry.js";
import type { AgentTranscriptWriterState } from "../transcript/TranscriptWriter.js";
import type { AgentProjectSessionStorage } from "./ProjectSessionStorage.js";

export function createStorageSubagentTranscriptHooks(
  storage: AgentProjectSessionStorage,
  now?: () => Date,
): AgentSubagentTranscriptHooks {
  const seeds = new Map<string, AgentTranscriptWriterState>();
  return {
    recordSubagentStarted: (args) =>
      storage.transcript.recordSubagentStarted(args.sessionId, args.turnId, {
        subagentId: args.subagentId,
        subagentType: args.subagentType,
        prompt: args.prompt,
        transcriptRelativePath: args.transcriptRelativePath,
        subagentSessionId: args.subagentSessionId,
      }),
    recordSubagentCompleted: (args) =>
      storage.transcript.recordSubagentCompleted(args.sessionId, args.turnId, {
        subagentId: args.subagentId,
        subagentType: args.subagentType,
        summary: args.summary,
        usage: args.usage,
        turns: args.turns,
        durationMs: args.durationMs,
        errored: args.errored,
      }),
    subagentTranscriptResolver: (subagentId) => {
      const seed = seeds.get(subagentId);
      seeds.delete(subagentId);
      const handle = storage.transcript.forSubagent(subagentId, now, seed);
      return {
        recordAcceptedInput: (sessionId, turnId, messages) =>
          handle.writer.recordAcceptedInput(sessionId, turnId, messages),
        recordDurableMessage: (sessionId, turnId, message) =>
          handle.writer.recordDurableMessage(sessionId, turnId, message),
        recordTurnResult: (sessionId, turnId, result: AgentTurnResult) =>
          handle.writer.recordTurnResult(sessionId, turnId, result),
        recordControlBoundary: (sessionId, turnId, boundary: AgentControlBoundaryTranscriptEntry["boundary"]) =>
          handle.writer.recordControlBoundary(sessionId, turnId, boundary),
        recordSessionMetadata: (sessionId, turnId, metadata: SessionMetadataValue) =>
          handle.writer.recordSessionMetadata(sessionId, turnId, metadata),
        transcriptRelativePath: storage.transcript.relativeSubagentPath(subagentId),
      };
    },
    loadSubagentContinuation: async (args) => {
      const loaded = await loadSubagentContinuation({
        transcriptPath: storage.subagentTranscriptPath(args.subagentId),
        requestedDefinitionId: args.requestedDefinitionId,
        expectedParentSessionId: args.sessionId,
        expectedSubagentId: args.subagentId,
      });
      // Re-seed the sidechain writer so appended rounds continue the file's
      // monotonic sequence (readTranscript sorts by sequence).
      seeds.set(args.subagentId, loaded.seed);
      return loaded;
    },
  };
}
