import type { AgentEvent } from "../../agent/protocol/events.js";
import type { AgentPermissionDenial, AgentTurnResult } from "../../agent/protocol/result.js";
import { cloneMessage, cloneMessages, type CanonicalMessage, type CanonicalUsage } from "../../model/index.js";
import type {
  AgentSubagentCompletedTranscriptEntry,
  AgentSubagentStartedTranscriptEntry,
  AgentTranscriptDiagnostic,
  AgentTranscriptEntry,
  SessionMetadataValue,
} from "../transcript/TranscriptEntry.js";
import { readCompactSnapshot } from "../transcript/CompactSnapshot.js";
import {
  checkpointArray,
  checkpointCanonicalMessages,
  checkpointCanonicalUsage,
  checkpointInteger,
  checkpointJsonSnapshot,
  checkpointPermissionDenials,
  checkpointRecord,
  checkpointStringArray,
  checkpointTranscriptEntries,
  checkpointTranscriptEntry,
} from "./SessionProjectionCheckpointCodec.js";
import type { SessionProjectionDefinition } from "./SessionProjection.js";
import { SessionProjectionRegistry } from "./SessionProjectionRegistry.js";

export const AGENT_TRANSCRIPT_PROJECTION_NAMES = {
  conversation: "agent-transcript.conversation",
  turnSummary: "agent-transcript.turn-summary",
  metadata: "agent-transcript.metadata",
  compactBoundary: "agent-transcript.compact-boundary",
  subagentReferences: "agent-transcript.subagent-references",
} as const;

export type AgentTranscriptProjectionResult = {
  messages: CanonicalMessage[];
  usage: CanonicalUsage;
  permissionDenials: AgentPermissionDenial[];
  events: AgentEvent[];
  metadata: SessionMetadataValue;
  diagnostics: AgentTranscriptDiagnostic[];
  lastCompactBoundaryIndex?: number;
  lastCompactBoundary?: AgentTranscriptEntry & { type: "control_boundary" };
};

type ConversationState = {
  entries: Array<{ entry: AgentTranscriptEntry; index: number }>;
  completedTurnIds: Set<string>;
  lastCompactBoundaryIndex: number;
  lastCompactReplacement?: {
    index: number;
    turnId: string;
    messages: CanonicalMessage[];
    replayBeforeTurnCompletion: boolean;
  };
};

export type AgentConversationProjectionResult = {
  messages: CanonicalMessage[];
  events: AgentEvent[];
  diagnostics: AgentTranscriptDiagnostic[];
  lastCompactBoundaryIndex: number;
};

export type AgentTurnSummaryProjectionResult = {
  usage: CanonicalUsage;
  permissionDenials: AgentPermissionDenial[];
};

type CompactBoundaryState = {
  lastCompactBoundary?: AgentTranscriptEntry & { type: "control_boundary" };
};

export type SubagentReferenceProjectionResult = {
  started: AgentSubagentStartedTranscriptEntry[];
  completed: AgentSubagentCompletedTranscriptEntry[];
  startedById: Map<string, AgentSubagentStartedTranscriptEntry>;
  completedById: Map<string, AgentSubagentCompletedTranscriptEntry>;
};

const conversationProjection: SessionProjectionDefinition<
  ConversationState,
  AgentConversationProjectionResult
> = {
  name: AGENT_TRANSCRIPT_PROJECTION_NAMES.conversation,
  version: 3,
  create: () => ({ entries: [], completedTurnIds: new Set(), lastCompactBoundaryIndex: -1 }),
  reduce(state, entry, { index }) {
    switch (entry.type) {
      case "accepted_input":
      case "assistant_message":
      case "tool_result_message":
      case "durable_message":
        return { ...state, entries: [...state.entries, { entry, index }] };
      case "context_snapshot":
        return entry.runtimeContextMessages && entry.runtimeContextMessages.length > 0
          ? { ...state, entries: [...state.entries, { entry, index }] }
          : state;
      case "turn_result":
        return {
          ...state,
          entries: [...state.entries, { entry, index }],
          completedTurnIds: new Set([...state.completedTurnIds, entry.turnId]),
        };
      case "control_boundary":
        if (
          entry.boundary.kind === "compact" &&
          "subtype" in entry.boundary &&
          entry.boundary.subtype === "compact_boundary"
        ) {
          const snapshot = readCompactSnapshot(entry);
          const replacement = snapshot ?? entry.boundary.replacementMessages;
          // A boundary without a complete replacement cannot discard prior
          // history. Snapshot records are self-contained and can survive a
          // crash before the enclosing turn reaches its terminal event.
          if (!replacement) {
            return hasSnapshotField(entry.boundary)
              ? { ...state, entries: [...state.entries, { entry, index }] }
              : state;
          }
          return {
            ...state,
            entries: [...state.entries, { entry, index }],
            lastCompactBoundaryIndex: index,
            lastCompactReplacement: {
              index,
              turnId: entry.turnId,
              messages: cloneMessages(replacement),
              replayBeforeTurnCompletion: snapshot !== undefined,
            },
          };
        }
        return state;
      default:
        return state;
    }
  },
  finalize(state) {
    const result: AgentConversationProjectionResult = {
      messages: [],
      events: [],
      diagnostics: [],
      lastCompactBoundaryIndex: state.lastCompactBoundaryIndex,
    };
    for (const { entry, index } of state.entries) {
      const beforeBoundary = state.lastCompactBoundaryIndex !== -1 && index < state.lastCompactBoundaryIndex;
      switch (entry.type) {
        case "accepted_input":
          if (!beforeBoundary) {
            result.messages.push(...cloneMessages(entry.messages));
            result.events.push({
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
          if (entry.message.metadata?.compactReplacement === true) {
            break;
          }
          if (!state.completedTurnIds.has(entry.turnId)) {
            result.diagnostics.push({
              code: "transcript_entry_invalid",
              severity: "warning",
              message: `Skipping durable message for incomplete turn ${entry.turnId}.`,
            });
          } else if (!beforeBoundary) {
            result.messages.push(cloneMessage(entry.message));
            result.events.push(projectMessageEvent(entry.sessionId, entry.turnId, entry.message));
          }
          break;
        case "context_snapshot":
          if (!beforeBoundary && state.completedTurnIds.has(entry.turnId) && entry.runtimeContextMessages) {
            result.messages = insertBeforeLatestUserRequest(
              result.messages,
              cloneMessages(entry.runtimeContextMessages),
            );
          }
          break;
        case "turn_result":
          if (!beforeBoundary) {
            result.events.push({
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
            entry.boundary.subtype === "compact_boundary" &&
            state.lastCompactReplacement?.index === index &&
            (state.lastCompactReplacement.replayBeforeTurnCompletion || state.completedTurnIds.has(entry.turnId))
          ) {
            for (const message of state.lastCompactReplacement.messages) {
              result.messages.push(cloneMessage(message));
              result.events.push(projectMessageEvent(entry.sessionId, entry.turnId, message));
            }
          } else if (
            entry.boundary.kind === "compact" &&
            "subtype" in entry.boundary &&
            entry.boundary.subtype === "compact_boundary" &&
            hasSnapshotField(entry.boundary) &&
            readCompactSnapshot(entry) === undefined
          ) {
            result.diagnostics.push({
              code: "transcript_entry_invalid",
              severity: "warning",
              message: "Ignoring compact boundary without a valid complete snapshot; retaining prior context.",
            });
          }
          break;
        default:
          break;
      }
    }
    return result;
  },
  checkpoint: {
    encode: (state) => ({
      entries: state.entries,
      completedTurnIds: [...state.completedTurnIds],
      lastCompactBoundaryIndex: state.lastCompactBoundaryIndex,
      ...(state.lastCompactReplacement
        ? {
            lastCompactReplacement: {
              index: state.lastCompactReplacement.index,
              turnId: state.lastCompactReplacement.turnId,
              messages: state.lastCompactReplacement.messages,
              replayBeforeTurnCompletion: state.lastCompactReplacement.replayBeforeTurnCompletion,
            },
          }
        : {}),
    }),
    decode(value) {
      const record = checkpointRecord(value, "conversation");
      const entries = checkpointArray(record.entries, "conversation.entries").map((row, index) => {
        const item = checkpointRecord(row, `conversation.entries[${index}]`);
        return {
          entry: checkpointTranscriptEntry(
            item.entry,
            ["accepted_input", "assistant_message", "tool_result_message", "durable_message", "context_snapshot", "turn_result", "control_boundary"],
            `conversation.entries[${index}].entry`,
          ),
          index: checkpointInteger(item.index, `conversation.entries[${index}].index`),
        };
      });
      const replacement = record.lastCompactReplacement === undefined
        ? undefined
        : (() => {
            const replacementRecord = checkpointRecord(
              record.lastCompactReplacement,
              "conversation.lastCompactReplacement",
            );
            if (typeof replacementRecord.turnId !== "string") {
              throw new TypeError("conversation.lastCompactReplacement.turnId checkpoint is invalid.");
            }
            return {
              index: checkpointInteger(replacementRecord.index, "conversation.lastCompactReplacement.index"),
              turnId: replacementRecord.turnId,
              messages: checkpointCanonicalMessages(
                replacementRecord.messages,
                "conversation.lastCompactReplacement.messages",
              ),
              replayBeforeTurnCompletion: replacementRecord.replayBeforeTurnCompletion === true,
            };
          })();
      return {
        entries,
        completedTurnIds: new Set(checkpointStringArray(
          record.completedTurnIds,
          "conversation.completedTurnIds",
        )),
        lastCompactBoundaryIndex: checkpointInteger(
          record.lastCompactBoundaryIndex,
          "conversation.lastCompactBoundaryIndex",
          -1,
        ),
        ...(replacement ? { lastCompactReplacement: replacement } : {}),
      };
    },
  },
};

const turnSummaryProjection: SessionProjectionDefinition<AgentTurnSummaryProjectionResult> = {
  name: AGENT_TRANSCRIPT_PROJECTION_NAMES.turnSummary,
  version: 1,
  create: () => ({ usage: {}, permissionDenials: [] }),
  reduce(state, entry) {
    if (entry.type !== "turn_result") return state;
    return {
      usage: mergeUsage(state.usage, entry.result.usage),
      permissionDenials: [...state.permissionDenials, ...entry.result.permissionDenials],
    };
  },
  checkpoint: {
    encode: (state) => checkpointJsonSnapshot(state, "turn summary"),
    decode(value) {
      const record = checkpointRecord(value, "turn summary");
      const usage = checkpointCanonicalUsage(record.usage, "turn summary usage");
      const permissionDenials = checkpointPermissionDenials(
        record.permissionDenials,
        "turn summary permission denials",
      );
      return { usage, permissionDenials };
    },
  },
};

const metadataProjection: SessionProjectionDefinition<SessionMetadataValue> = {
  name: AGENT_TRANSCRIPT_PROJECTION_NAMES.metadata,
  version: 2,
  create: () => ({}),
  reduce(state, entry) {
    if (entry.type === "session_metadata") return mergeMetadata(state, entry.metadata);
    if (entry.type !== "accepted_input" || !entry.metadata?.modelSelection) return state;
    const selection = entry.metadata.modelSelection as SessionMetadataValue["modelSelection"];
    if (
      selection?.mode !== "auto"
      && !(selection?.mode === "model" && typeof selection.provider === "string" && typeof selection.model === "string")
    ) {
      return state;
    }
    return mergeMetadata(state, { modelSelection: { ...selection } });
  },
  checkpoint: {
    encode: (state) => checkpointJsonSnapshot(state, "session metadata"),
    decode: decodeSessionMetadata,
  },
};

const compactBoundaryProjection: SessionProjectionDefinition<CompactBoundaryState> = {
  name: AGENT_TRANSCRIPT_PROJECTION_NAMES.compactBoundary,
  version: 1,
  create: () => ({}),
  reduce(state, entry) {
    if (
      entry.type === "control_boundary" &&
      entry.boundary.kind === "compact" &&
      "subtype" in entry.boundary &&
      entry.boundary.subtype === "compact_boundary"
    ) {
      if (!readCompactSnapshot(entry) && !entry.boundary.replacementMessages) return state;
      return { lastCompactBoundary: entry };
    }
    return state;
  },
  checkpoint: {
    encode: (state) => state,
    decode(value) {
      const record = checkpointRecord(value, "compact boundary");
      if (record.lastCompactBoundary === undefined) return {};
      const entry = checkpointTranscriptEntry(
        record.lastCompactBoundary,
        ["control_boundary"],
        "compact boundary entry",
      );
      if (
        entry.boundary.kind !== "compact" ||
        !("subtype" in entry.boundary) ||
        entry.boundary.subtype !== "compact_boundary"
      ) {
        throw new TypeError("Compact boundary checkpoint does not contain a compact boundary.");
      }
      if (!readCompactSnapshot(entry) && !entry.boundary.replacementMessages) {
        throw new TypeError("Compact boundary checkpoint does not contain a complete replacement.");
      }
      return { lastCompactBoundary: entry };
    },
  },
};

const subagentReferenceProjection: SessionProjectionDefinition<SubagentReferenceProjectionResult> = {
  name: AGENT_TRANSCRIPT_PROJECTION_NAMES.subagentReferences,
  version: 1,
  create: () => ({
    started: [],
    completed: [],
    startedById: new Map(),
    completedById: new Map(),
  }),
  reduce(state, entry) {
    if (entry.type === "subagent_started") {
      const startedById = new Map(state.startedById);
      if (!startedById.has(entry.subagentId)) startedById.set(entry.subagentId, entry);
      return {
        ...state,
        started: [...state.started, entry],
        startedById,
      };
    }
    if (entry.type === "subagent_completed") {
      const completedById = new Map(state.completedById);
      completedById.set(entry.subagentId, entry);
      return {
        ...state,
        completed: [...state.completed, entry],
        completedById,
      };
    }
    return state;
  },
  checkpoint: {
    encode: (state) => ({ started: state.started, completed: state.completed }),
    decode(value) {
      const record = checkpointRecord(value, "subagent references");
      const started = checkpointTranscriptEntries(
        record.started,
        ["subagent_started"],
        "subagent references started",
      );
      const completed = checkpointTranscriptEntries(
        record.completed,
        ["subagent_completed"],
        "subagent references completed",
      );
      const startedById = new Map<string, AgentSubagentStartedTranscriptEntry>();
      for (const entry of started) {
        if (!startedById.has(entry.subagentId)) startedById.set(entry.subagentId, entry);
      }
      const completedById = new Map<string, AgentSubagentCompletedTranscriptEntry>();
      for (const entry of completed) completedById.set(entry.subagentId, entry);
      return { started, completed, startedById, completedById };
    },
  },
};

export function registerAgentTranscriptProjections(registry: SessionProjectionRegistry): void {
  registry.register(conversationProjection);
  registry.register(turnSummaryProjection);
  registry.register(metadataProjection);
  registry.register(compactBoundaryProjection);
  registry.register(subagentReferenceProjection);
}

export function createAgentTranscriptProjectionRegistry(): SessionProjectionRegistry {
  const registry = new SessionProjectionRegistry();
  registerAgentTranscriptProjections(registry);
  return registry;
}

export function projectSubagentReferences(
  entries: readonly AgentTranscriptEntry[],
  registry = createAgentTranscriptProjectionRegistry(),
): SubagentReferenceProjectionResult {
  return registry.project<SubagentReferenceProjectionResult>(
    AGENT_TRANSCRIPT_PROJECTION_NAMES.subagentReferences,
    entries,
  );
}

export function projectAgentTranscriptEntries(
  entries: readonly AgentTranscriptEntry[],
  registry = createAgentTranscriptProjectionRegistry(),
): AgentTranscriptProjectionResult {
  const conversation = registry.project<AgentConversationProjectionResult>(
    AGENT_TRANSCRIPT_PROJECTION_NAMES.conversation,
    entries,
  );
  const turnSummary = registry.project<AgentTurnSummaryProjectionResult>(
    AGENT_TRANSCRIPT_PROJECTION_NAMES.turnSummary,
    entries,
  );
  const metadata = registry.project<SessionMetadataValue>(
    AGENT_TRANSCRIPT_PROJECTION_NAMES.metadata,
    entries,
  );
  const compactBoundary = registry.project<CompactBoundaryState>(
    AGENT_TRANSCRIPT_PROJECTION_NAMES.compactBoundary,
    entries,
  );

  return {
    messages: conversation.messages,
    usage: turnSummary.usage,
    permissionDenials: turnSummary.permissionDenials,
    events: conversation.events,
    metadata,
    diagnostics: conversation.diagnostics,
    lastCompactBoundaryIndex:
      conversation.lastCompactBoundaryIndex === -1 ? undefined : conversation.lastCompactBoundaryIndex,
    lastCompactBoundary: compactBoundary.lastCompactBoundary,
  };
}

export function findLastCompactBoundaryIndex(entries: readonly AgentTranscriptEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (
      entry.type === "control_boundary" &&
      entry.boundary.kind === "compact" &&
      "subtype" in entry.boundary &&
      entry.boundary.subtype === "compact_boundary" &&
      (readCompactSnapshot(entry) !== undefined || entry.boundary.replacementMessages !== undefined)
    ) {
      return index;
    }
  }
  return -1;
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
  if (first === undefined && second === undefined) return undefined;
  return (first ?? 0) + (second ?? 0);
}

function hasSnapshotField(boundary: Extract<AgentTranscriptEntry, { type: "control_boundary" }>['boundary']): boolean {
  return Object.prototype.hasOwnProperty.call(boundary, "snapshot");
}

function insertBeforeLatestUserRequest(
  messages: CanonicalMessage[],
  additions: CanonicalMessage[],
): CanonicalMessage[] {
  if (additions.length === 0) return messages;
  let insertionIndex = messages.length;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isRealUserRequestMessage(messages[index]!)) {
      insertionIndex = index;
      break;
    }
  }
  return [
    ...messages.slice(0, insertionIndex),
    ...additions,
    ...messages.slice(insertionIndex),
  ];
}

function isRealUserRequestMessage(message: CanonicalMessage): boolean {
  if (message.role !== "user" || message.metadata?.synthetic === true) return false;
  return message.content.some((block) => {
    if (block.type === "tool_result" || block.type === "tool_result_reference") return false;
    if (block.type === "media_reference" && typeof block.toolCallId === "string") return false;
    if (block.type !== "text") return true;
    const text = block.text.trim();
    return text.length > 0
      && text !== "[system: the conversation above has been compacted. please continue with the current task.]"
      && !["<compact-boundary", "<snip-boundary", "<memory-context>", "<internal-compaction-control", "<hook_context"]
        .some((prefix) => text.startsWith(prefix));
  });
}

function mergeMetadata(first: SessionMetadataValue, second: SessionMetadataValue): SessionMetadataValue {
  return {
    ...first,
    ...second,
    title: second.title ?? first.title,
    linkedPullRequest: second.linkedPullRequest ?? first.linkedPullRequest,
  };
}

function decodeSessionMetadata(value: unknown): SessionMetadataValue {
  const record = checkpointRecord(value, "session metadata");
  for (const key of [
    "title",
    "aiTitle",
    "tag",
    "firstPrompt",
    "lastPrompt",
    "gitBranch",
    "parentSessionId",
    "forkedFromTurnId",
    "titleProviderId",
    "titleSourceTurnId",
    "updatedAt",
  ]) {
    if (record[key] !== undefined && typeof record[key] !== "string") {
      throw new TypeError(`Session metadata checkpoint field ${key} is invalid.`);
    }
  }
  if (record.titleSource !== undefined && record.titleSource !== "user" && record.titleSource !== "provider" && record.titleSource !== "fallback") {
    throw new TypeError("Session metadata checkpoint field titleSource is invalid.");
  }
  if (record.titleMessageSequences !== undefined && (!Array.isArray(record.titleMessageSequences)
    || !record.titleMessageSequences.every((value) => Number.isSafeInteger(value) && value > 0))) {
    throw new TypeError("Session metadata checkpoint field titleMessageSequences is invalid.");
  }
  if (record.titleModel !== undefined) {
    const model = checkpointRecord(record.titleModel, "session metadata title model");
    if (typeof model.provider !== "string" || typeof model.model !== "string") {
      throw new TypeError("Session metadata checkpoint field titleModel is invalid.");
    }
  }
  if (record.isSnapshot !== undefined && record.isSnapshot !== true) {
    throw new TypeError("Session metadata checkpoint field isSnapshot is invalid.");
  }
  if (record.mode !== undefined && record.mode !== "normal" && record.mode !== "coordinator") {
    throw new TypeError("Session metadata checkpoint field mode is invalid.");
  }
  if (record.modelSelection !== undefined && record.modelSelection !== null) {
    const selection = checkpointRecord(record.modelSelection, "session metadata model selection");
    if (
      selection.mode !== "auto" &&
      !(
        selection.mode === "model" &&
        typeof selection.provider === "string" &&
        typeof selection.model === "string"
      )
    ) {
      throw new TypeError("Session metadata checkpoint model selection is invalid.");
    }
  }
  if (record.linkedPullRequest !== undefined) {
    const linked = checkpointRecord(record.linkedPullRequest, "session metadata linked pull request");
    if (
      !Number.isSafeInteger(linked.number) ||
      typeof linked.url !== "string" ||
      typeof linked.repository !== "string"
    ) {
      throw new TypeError("Session metadata checkpoint linked pull request is invalid.");
    }
  }
  return structuredClone(record) as SessionMetadataValue;
}
