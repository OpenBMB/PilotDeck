import { cloneMessage, cloneMessages, type CanonicalContentBlock, type CanonicalMessage, type CanonicalUsage } from "../../model/index.js";
import type { AgentEvent } from "../../agent/protocol/events.js";
import type { AgentPermissionDenial, AgentTurnResult } from "../../agent/protocol/result.js";
import type { AgentTranscriptDiagnostic, AgentTranscriptEntry, SessionMetadataValue } from "./TranscriptEntry.js";

export type AgentTranscriptReplayResult = {
  messages: CanonicalMessage[];
  usage: CanonicalUsage;
  permissionDenials: AgentPermissionDenial[];
  events: AgentEvent[];
  metadata: SessionMetadataValue;
  diagnostics: AgentTranscriptDiagnostic[];
  /**
   * Index of the last compact_boundary entry consumed during replay. When
   * present, only messages after this entry are kept in `messages`.
   */
  lastCompactBoundaryIndex?: number;
  /** Last compact boundary entry encountered (for resume relink). */
  lastCompactBoundary?: AgentTranscriptEntry & { type: "control_boundary" };
};

/**
 * Find the index of the last compact boundary entry. Used by resume / replay
 * to slice messages after the boundary.
 */
export function findLastCompactBoundaryIndex(entries: AgentTranscriptEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry.type === "control_boundary" &&
      entry.boundary.kind === "compact" &&
      "subtype" in entry.boundary &&
      entry.boundary.subtype === "compact_boundary"
    ) {
      return index;
    }
  }
  return -1;
}

export function replayTranscriptEntries(entries: AgentTranscriptEntry[]): AgentTranscriptReplayResult {
  const lastBoundaryIndex = findLastCompactBoundaryIndex(entries);
  const messages: CanonicalMessage[] = [];
  const events: AgentEvent[] = [];
  const diagnostics: AgentTranscriptDiagnostic[] = [];
  let metadata: SessionMetadataValue = {};
  let usage: CanonicalUsage = {};
  let permissionDenials: AgentPermissionDenial[] = [];
  let lastCompactBoundary: (AgentTranscriptEntry & { type: "control_boundary" }) | undefined;

  const completedTurnIds = new Set(
    entries.filter((entry) => entry.type === "turn_result").map((entry) => entry.turnId),
  );

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    // Past compact boundary: usage / metadata still merge; messages produced
    // before the boundary are dropped (legacy getMessagesAfterCompactBoundary).
    const beforeBoundary = lastBoundaryIndex !== -1 && index < lastBoundaryIndex;

    switch (entry.type) {
      case "accepted_input":
        if (!beforeBoundary) {
          messages.push(...cloneMessages(entry.messages));
          events.push({
            type: "input_accepted",
            sessionId: entry.sessionId,
            turnId: entry.turnId,
            messages: cloneMessages(entry.messages),
          });
        }
        break;
      case "assistant_message":
      case "tool_result_message":
      case "durable_message":
        if (!completedTurnIds.has(entry.turnId)) {
          diagnostics.push({
            code: "transcript_entry_invalid",
            severity: "warning",
            message: `Skipping durable message for incomplete turn ${entry.turnId}.`,
          });
          break;
        }
        if (beforeBoundary) {
          break;
        }
        messages.push(cloneMessage(entry.message));
        events.push(projectMessageEvent(entry.sessionId, entry.turnId, entry.message));
        break;
      case "turn_result":
        usage = mergeUsage(usage, entry.result.usage);
        permissionDenials = [...permissionDenials, ...entry.result.permissionDenials];
        if (!beforeBoundary) {
          events.push({
            type: "turn_completed",
            sessionId: entry.sessionId,
            turnId: entry.turnId,
            result: cloneTurnResult(entry.result),
          });
        }
        break;
      case "control_boundary":
        if (
          entry.boundary.kind === "compact" &&
          "subtype" in entry.boundary &&
          entry.boundary.subtype === "compact_boundary"
        ) {
          lastCompactBoundary = entry;
        }
        break;
      case "session_metadata":
        metadata = mergeMetadata(metadata, entry.metadata);
        break;
      case "subagent_started":
      case "subagent_completed":
        // C3: lazy-load. The parent transcript replay does NOT expand
        // sidechain content; consumers wanting subagent details call
        // `replaySubagentTranscript(...)` explicitly.
        break;
    }
  }

  const repairedMessages = repairToolPairing(messages, diagnostics);

  return {
    messages: repairedMessages,
    usage,
    permissionDenials,
    events,
    metadata,
    diagnostics,
    lastCompactBoundaryIndex: lastBoundaryIndex === -1 ? undefined : lastBoundaryIndex,
    lastCompactBoundary,
  };
}

function repairToolPairing(
  messages: CanonicalMessage[],
  diagnostics: AgentTranscriptDiagnostic[],
): CanonicalMessage[] {
  const out: CanonicalMessage[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (message.role === "user") {
      const cleaned = stripToolResultBlocks(message);
      if (cleaned.content.length > 0) {
        out.push(cleaned);
      }
      continue;
    }

    const toolCalls = message.content.filter((block) => block.type === "tool_call");
    if (toolCalls.length === 0) {
      out.push(message);
      continue;
    }

    const expectedIds = new Set(toolCalls.map((block) => block.id));
    const collected = new Map<string, CanonicalContentBlock>();
    const deferred: CanonicalMessage[] = [];
    let j = i + 1;
    while (j < messages.length && messages[j].role !== "assistant") {
      const next = messages[j];
      const deferredContent: CanonicalContentBlock[] = [];
      for (const block of next.content) {
        if (block.type === "tool_result" || block.type === "tool_result_reference") {
          if (expectedIds.has(block.toolCallId) && !collected.has(block.toolCallId)) {
            collected.set(block.toolCallId, block);
          } else {
            diagnostics.push({
              code: "transcript_entry_invalid",
              severity: "warning",
              message: `Skipping orphaned or duplicate tool result ${block.toolCallId}.`,
            });
          }
        } else {
          deferredContent.push(block);
        }
      }
      if (deferredContent.length > 0) {
        deferred.push({ ...next, content: deferredContent });
      }
      j += 1;
    }

    out.push(message);
    const toolResultContent: CanonicalContentBlock[] = [];
    for (const call of toolCalls) {
      const existing = collected.get(call.id);
      if (existing) {
        toolResultContent.push(existing);
      } else {
        diagnostics.push({
          code: "transcript_entry_invalid",
          severity: "warning",
          message: `Inserted synthetic tool result for incomplete tool call ${call.id}.`,
        });
        toolResultContent.push({
          type: "tool_result",
          toolCallId: call.id,
          isError: true,
          content: [{
            type: "text",
            text: "Tool result unavailable: previous turn ended before this tool result was recorded.",
          }],
        });
      }
    }
    out.push({ role: "user", content: toolResultContent });
    out.push(...deferred);
    i = j - 1;
  }
  return out;
}

function stripToolResultBlocks(message: CanonicalMessage): CanonicalMessage {
  const content = message.content.filter(
    (block) => block.type !== "tool_result" && block.type !== "tool_result_reference",
  );
  return content.length === message.content.length ? message : { ...message, content };
}

function projectMessageEvent(sessionId: string, turnId: string, message: CanonicalMessage): AgentEvent {
  if (message.role === "assistant") {
    return { type: "assistant_message", sessionId, turnId, message: cloneMessage(message) };
  }
  return { type: "tool_results_projected", sessionId, turnId, message: cloneMessage(message) };
}

function cloneTurnResult(result: AgentTurnResult): AgentTurnResult {
  return {
    ...result,
    usage: { ...result.usage },
    permissionDenials: result.permissionDenials.map((denial) => ({ ...denial })),
    errors: result.errors?.map((error) => ({ ...error })),
  };
}

function mergeUsage(first: CanonicalUsage, second: CanonicalUsage): CanonicalUsage {
  return {
    inputTokens: add(first.inputTokens, second.inputTokens),
    outputTokens: add(first.outputTokens, second.outputTokens),
    cacheReadTokens: add(first.cacheReadTokens, second.cacheReadTokens),
    cacheWriteTokens: add(first.cacheWriteTokens, second.cacheWriteTokens),
    totalTokens: add(first.totalTokens, second.totalTokens),
  };
}

function add(first: number | undefined, second: number | undefined): number | undefined {
  if (first === undefined && second === undefined) {
    return undefined;
  }
  return (first ?? 0) + (second ?? 0);
}

function mergeMetadata(first: SessionMetadataValue, second: SessionMetadataValue): SessionMetadataValue {
  return {
    ...first,
    ...second,
    title: second.title ?? first.title,
    linkedPullRequest: second.linkedPullRequest ?? first.linkedPullRequest,
  };
}
